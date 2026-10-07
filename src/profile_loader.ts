/**
 * pi-rolecast/src/profile_loader.ts
 *
 * Load + validate a project-local rolecast profile. TypeScript port of
 * scripts/profile_loader.py (v0.4.4). Single source of truth for the
 * profile schema. Consumed by:
 *  - src/dump_bindings.ts (auto-fired on session_start)
 *  - src/scaffolder.ts (validate + init)
 *  - src/gate_runner.ts (load_profile before phase execution)
 *  - src/sync_settings.ts (load_profile + available_roles for dispatch)
 *  - scripts/install.sh (indirectly via the Node helpers above)
 *
 * v0.2.0 breaking changes:
 *   * Roles are now grouped (role-packs/<group>/<role>.md). Profile
 *     bindings use full names like `coding-architect` (hyphen-namespaced).
 *   * Profile gains `workflow.role_groups: [list]`.
 *   * Project-local profile filename changed from
 *     `.pi/agent-workflow.yaml` to `.pi/rolecast.yaml`.
 *
 * Resolution rules (alias → model + channel) live in this module too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

// js-yaml is the only third-party runtime dep in the framework. It's
// bundled with the npm package, so a missing PyYAML / Python is no
// longer the user's problem.

export const LEGACY_CORE_ROLES: ReadonlySet<string> = new Set([
    "orchestrator", "architect", "planner", "implementer", "tester",
    "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
]);

export const DEFAULT_GROUP = "coding";

export const DEFAULT_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
    "coding-architect":      ["design", "architect", "trait", "API design", "system design"],
    "coding-planner":        ["plan", "plan this change", "break this down"],
    "coding-implementer":    ["implement", "code", "do it", "make this change"],
    "coding-tester":         ["write tests", "test this", "add coverage"],
    "coding-reviewer":       ["review this diff", "review", "check this"],
    "coding-mapper":         ["map", "repo map", "what's in this repo"],
    "coding-profiler":       ["profile this", "this is slow", "why is X slow"],
    "coding-auditor":        ["audit", "audit security", "check for vulnerabilities",
                              "what could go wrong"],
    "coding-canary":         ["is the relay real", "which group answered", "canary check"],
    "coding-docs":           ["write README", "document this", "user-facing copy",
                              "frontend"],
};

export const DEFAULT_FRAMEWORK_VERSION = "0.2.0";

export class ProfileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProfileError";
    }
}

// ─────────────────────────────────────────────────────────────────────
// Types (mirror Python dataclasses)
// ─────────────────────────────────────────────────────────────────────

export interface ForbiddenPattern {
    pattern: string;
    message: string;
    compiled: RegExp;
}

export interface NonNegotiables {
    forbidden_patterns: ForbiddenPattern[];
    scope_constraints: Record<string, unknown>;
    required_gates: string[];
}

export interface CustomRole {
    name: string;
    description: string;
    agent_file: string;
    default_alias: string;
    default_channels: string[];
    triggers: string[];
}

export interface Binding {
    alias: string;
    channels: string[];
    fallback_chain: string[];
    role_group: string;
    role_name: string;
}

export interface WorkflowConfig {
    role_groups: string[];
}

export interface Escalation {
    max_attempts: number;
    on_permanent_failure: "stop" | "continue";
    preserve_logs: boolean;
    /**
     * v0.6.0: cap on audit-phase resubmissions. `null` (default) = unbounded,
     * honouring ADR-0007's "no retry brake on audit" principle. A finite
     * number aborts the audit gate after that many rejected resubmissions.
     */
    audit_max_resubmits: number | null;
    /**
     * v0.7.0 (E1.1) — session-level gate-attempt ceiling. Distinct from the
     * per-phase `PhaseDef.max_attempts` knob: this caps the total number of
     * attempts the gate runner will run *across all phases* before declaring
     * the gate failed. `null` (default) = unbounded.
     */
    gate_max_attempts: number | null;
    /**
     * v0.7.0 (E1.2) — cap on consecutive non_negotiable violations before the
     * gate runner hard-fails. Each phase result reports its non-negotiable
     * violation count; when the cumulative count across the gate run
     * reaches this cap, the runner fails immediately. `null` (default) =
     * unbounded.
     */
    non_negotiable_max_retries: number | null;
}

export interface RoleDef {
    full_name: string;
    group: string;
    role: string;
    description: string;
    triggers: string[];
    requires: Record<string, unknown>;
    preferences: Record<string, unknown>;
    file_path: string | null;
    // v0.6.0 (A2): optional whitelist of tool names this role may invoke.
    // When present, sync_settings writes a "Tool restrictions" block into
    // the generated agent file body; the framework does NOT enforce the
    // restriction at the framework layer (per ADR-0008, audit-seat
    // narrowing is a prompt-level contract, not a runtime gate). When
    // absent, the role may use any tool.
    allowed_tools: string[] | null;
    // v0.6.0 (A3): relative path from this role file to a shared "soul"
    // markdown file (e.g. "../souls/coding/_common.md"). sync_settings
    // prepends the soul content to the generated agent file body, after
    // frontmatter. The role's own body is treated as the "host overlay"
    // per ADR-0005.
    soul_path: string | null;
    // v0.6.0 (A5): literal-substring bash seatbelt (ADR-0008). sync_settings
    // writes a "Bash seatbelt" block listing these patterns; the framework
    // does NOT enforce (seatbelt is 防呆不防坏). When empty/absent, no block
    // is written.
    forbidden_bash_patterns: string[];
}

export interface Model {
    id: string;
    vendor: string;
    capabilities: Record<string, unknown>;
    channels: Array<{ id: string; trust: string }>;
    cost_tier: string;
    status: string;
}

export interface Alias {
    name: string;
    preferred: string;
    fallback_chain: string[];
    notes: string;
}

export interface ResolvedModel {
    model_id: string;
    channel_id: string;
    trust: string;
    via_fallback: boolean;
    warning: string | null;
}

export interface ResolvedBinding {
    role: string;
    alias: string;
    model_id: string;
    channel_id: string;
    trust: string;
    warning: string | null;
    via_fallback: boolean;
}

export interface Profile {
    framework_version: string;
    name: string;
    description: string;
    gates: Record<string, Record<string, unknown>>;
    bindings: Record<string, Binding>;
    non_negotiables: NonNegotiables;
    escalation: Escalation;
    trigger_overrides: Record<string, unknown>;
    custom_roles: CustomRole[];
    workflow: WorkflowConfig;
    /**
     * v0.6.0: per-role output-contract JSON Schemas. Validated structurally
     * by `scaffolder validate` (see src/contracts.ts); not enforced at dispatch.
     */
    contracts: Record<string, unknown>;
    /**
     * v0.6.0: warnings collected during load (e.g. legacy role-name bindings
     * resolved via LEGACY_ROLE_ALIASES; contract for undeclared role).
     * Surface these from `scaffolder validate` so users see them.
     */
    load_warnings: string[];
    resolved_bindings: Record<string, ResolvedBinding>;
}

/**
 * v0.6.0 → v0.7.0: legacy role-name redirect table.
 *
 * Used ONLY to produce a clear migration error when a profile still
 * declares a binding or contract under a v0.6.0-era role name. Profiles
 * that pre-date v0.6.0 used bare `implement`, `review`, `docs`, etc.;
 * profiles that dated to v0.6.0 used `coding-implementer`, `coding-reviewer`,
 * `coding-docs`, and `coding-orchestrator`. v0.7.0 removed the rewrite
 * shim so all four old names now produce a hard error pointing to the
 * new name (or to "removed entirely" for `coding-orchestrator`).
 *
 * `null` target = role is fully removed; no new name exists.
 */
export const LEGACY_ROLE_REDIRECTS: Readonly<Record<string, string | null>> = Object.freeze({
    "coding-reviewer":      "coding-judge",
    "coding-implementer":  "coding-coder",
    "coding-docs":          "coding-diarist",
    "coding-orchestrator":  null,
});

// ─────────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ─────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---\s*\n/s;

function parseFrontmatter(text: string): Record<string, unknown> {
    const m = text.match(FRONTMATTER_RE);
    if (!m) return {};
    const loaded = yaml.load(m[1]!) as unknown;
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        return loaded as Record<string, unknown>;
    }
    return {};
}

// ─────────────────────────────────────────────────────────────────────
// Role discovery from role-packs/<group>/<role>.md
// ─────────────────────────────────────────────────────────────────────

export function discoverRolePacks(frameworkRoot: string): Record<string, RoleDef[]> {
    const root = path.join(frameworkRoot, "role-packs");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return {};
    }
    const out: Record<string, RoleDef[]> = {};
    const groups = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    for (const group of groups) {
        const groupDir = path.join(root, group);
        const roles: RoleDef[] = [];
        const mdFiles = fs.readdirSync(groupDir)
            .filter((f) => f.endsWith(".md"))
            .sort();
        for (const mdName of mdFiles) {
            const mdPath = path.join(groupDir, mdName);
            let role = mdName.replace(/\.md$/, "");
            // Strip optional `<group>-` prefix from filename
            const prefix = `${group}-`;
            if (role.startsWith(prefix)) {
                role = role.slice(prefix.length);
            }
            const text = fs.readFileSync(mdPath, "utf8");
            const fm = parseFrontmatter(text);
            // v0.7.0: skip role-pack files that declare `deprecated_redirect`
            // in their frontmatter. The four legacy v0.6.0 roles
            // (coding-implementer, coding-reviewer, coding-docs,
            // coding-orchestrator) ship on disk for one release with
            // `deprecated_redirect` set, then the file is removed in v0.8.x.
            // Skipping here keeps the runtime `allowedRoles` clean so the
            // migration hint path (LEGACY_ROLE_REDIRECTS) can fire when a
            // profile still references the old name.
            if ("deprecated_redirect" in fm) {
                continue;
            }
            const nameFromFm = typeof fm["name"] === "string"
                ? (fm["name"] as string).trim() : "";
            const fullName = nameFromFm || `${group}-${role}`;
            const desc = typeof fm["description"] === "string"
                ? (fm["description"] as string).trim() : "";
            const requiresRaw = (fm["requires"] && typeof fm["requires"] === "object" && !Array.isArray(fm["requires"]))
                ? fm["requires"] as Record<string, unknown>
                : {};
            const preferencesRaw = (fm["preferences"] && typeof fm["preferences"] === "object" && !Array.isArray(fm["preferences"]))
                ? fm["preferences"] as Record<string, unknown>
                : {};
            // v0.6.0: allowed_tools (A2). Optional list of strings; missing
            // or non-array → null (= no restriction documented).
            const allowedToolsRaw = fm["allowed_tools"];
            let allowedTools: string[] | null = null;
            if (Array.isArray(allowedToolsRaw)) {
                const filtered = allowedToolsRaw.filter((x): x is string => typeof x === "string");
                if (filtered.length > 0) allowedTools = filtered;
            }
            // v0.6.0: soul_path (A3). Relative path from this role file to a
            // shared soul markdown. Will be resolved to an absolute path at
            // sync time; for the RoleDef we just record the raw string.
            const soulPath = typeof fm["soul"] === "string"
                ? (fm["soul"] as string).trim() || null
                : null;
            // v0.6.0: forbidden_bash_patterns (A5). Literal substrings.
            const fbpRaw = fm["forbidden_bash_patterns"];
            const forbiddenBashPatterns: string[] = Array.isArray(fbpRaw)
                ? fbpRaw.filter((x): x is string => typeof x === "string")
                : [];
            roles.push({
                full_name: fullName,
                group,
                role,
                description: desc,
                triggers: [],
                requires: { ...requiresRaw },
                preferences: { ...preferencesRaw },
                file_path: mdPath,
                allowed_tools: allowedTools,
                soul_path: soulPath,
                forbidden_bash_patterns: forbiddenBashPatterns,
            });
        }
        if (roles.length > 0) {
            out[group] = roles;
        }
    }
    return out;
}

export function availableRoles(
    frameworkRoot: string,
    groups?: readonly string[],
): Record<string, RoleDef> {
    const packs = discoverRolePacks(frameworkRoot);
    const out: Record<string, RoleDef> = {};
    const targetGroups = groups ?? Object.keys(packs);
    for (const g of targetGroups) {
        for (const rd of packs[g] ?? []) {
            out[rd.full_name] = rd;
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────
// Loader entrypoint
// ─────────────────────────────────────────────────────────────────────

export const LEGACY_PROFILE_FILENAMES = ["agent-workflow.yaml"] as const;

export function findProfile(cwd: string = "."): string | null {
    const newPath = path.join(cwd, ".pi", "rolecast.yaml");
    if (fs.existsSync(newPath) && fs.statSync(newPath).isFile()) {
        return newPath;
    }
    for (const legacy of LEGACY_PROFILE_FILENAMES) {
        const cand = path.join(cwd, ".pi", legacy);
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            return cand;
        }
    }
    return null;
}

function defaultFrameworkRoot(): string {
    // Equivalent of Python: Path(__file__).resolve().parent.parent
    // This file lives at src/profile_loader.ts; project root is one level up.
    return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function loadProfile(
    profilePath: string,
    frameworkRoot?: string,
): Profile {
    if (!fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) {
        throw new ProfileError(`profile not found: ${profilePath}`);
    }
    const raw = yaml.load(fs.readFileSync(profilePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProfileError(`profile ${profilePath} is not a YAML mapping`);
    }
    const root = frameworkRoot ?? defaultFrameworkRoot();
    const profile = parseProfile(raw as Record<string, unknown>, root);
    const registry = loadRegistry(root);
    profile.resolved_bindings = resolveBindings(profile, registry);
    return profile;
}

export function parseProfile(
    raw: Record<string, unknown>,
    frameworkRoot?: string,
): Profile {
    const fv = raw["framework_version"];
    if (!fv) {
        throw new ProfileError("profile.framework_version is required");
    }
    const name = raw["name"];
    if (!name) {
        throw new ProfileError("profile.name is required");
    }
    const description = raw["description"];
    if (!description) {
        throw new ProfileError("profile.description is required");
    }

    const gatesRaw = raw["gates"];
    const gates = (gatesRaw && typeof gatesRaw === "object" && !Array.isArray(gatesRaw))
        ? gatesRaw as Record<string, Record<string, unknown>>
        : {};
    if (gatesRaw !== undefined && (typeof gatesRaw !== "object" || Array.isArray(gatesRaw))) {
        throw new ProfileError("profile.gates must be a mapping");
    }

    const workflow = parseWorkflow(raw["workflow"] ?? {});
    const customRoles = parseCustomRoles(raw["custom_roles"] ?? []);

    const root = frameworkRoot ?? defaultFrameworkRoot();
    const packs = availableRoles(root, workflow.role_groups);
    const allowedRoles = new Set<string>([
        ...Object.keys(packs),
        ...customRoles.map((r) => r.name),
    ]);

    const { bindings: rawBindings, bindingsWarnings } = {
        bindings: parseBindings(raw["bindings"] ?? {}, allowedRoles, packs),
        bindingsWarnings: [] as string[],
    };
    const triggerOverridesRaw = raw["trigger_overrides"];
    if (triggerOverridesRaw !== undefined &&
        (typeof triggerOverridesRaw !== "object" || Array.isArray(triggerOverridesRaw))) {
        throw new ProfileError("profile.trigger_overrides must be a mapping");
    }
    const triggerOverrides = (triggerOverridesRaw && typeof triggerOverridesRaw === "object")
        ? triggerOverridesRaw as Record<string, unknown>
        : {};
    const nonNegotiables = parseNonNegotiables(raw["non_negotiables"] ?? {});
    const escalation = parseEscalation(raw["escalation"] ?? {});

    const contractsRaw = raw["contracts"];
    if (contractsRaw !== undefined && contractsRaw !== null
        && (typeof contractsRaw !== "object" || Array.isArray(contractsRaw))) {
        throw new ProfileError("profile.contracts must be a mapping of role-name -> schema");
    }
    const contracts = (contractsRaw && typeof contractsRaw === "object" && !Array.isArray(contractsRaw))
        ? contractsRaw as Record<string, unknown>
        : {};
    // v0.7.0: reject contracts declared against v0.6.0-era legacy role
    // names. Symmetric with the parseBindings check: profiles that still
    // reference `coding-implementer`, `coding-reviewer`, `coding-docs`,
    // or `coding-orchestrator` in `contracts:` get the same migration
    // hint. Note this only fires at load time; `validateProfile` will
    // also surface the legacy name through `validateAllContracts`, but
    // failing fast here gives a clearer trace.
    for (const roleName of Object.keys(contracts)) {
        if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_REDIRECTS, roleName)) {
            const target = LEGACY_ROLE_REDIRECTS[roleName];
            if (target === null) {
                throw new ProfileError(
                    `contracts.${roleName}: REMOVED in v0.6.0. Callers should dispatch via the Agent tool directly. `
                    + `Remove the '${roleName}' entry from your .pi/rolecast.yaml contracts.`,
                );
            }
            throw new ProfileError(
                `contracts.${roleName}: renamed to '${target}' in v0.6.0. Update your .pi/rolecast.yaml `
                + `contracts to use the new name. See references/v0.6.0-optimization-roadmap.md.`,
            );
        }
    }

    const profile: Profile = {
        framework_version: String(fv),
        name: String(name),
        description: String(description),
        gates,
        bindings: rawBindings,
        non_negotiables: nonNegotiables,
        escalation,
        trigger_overrides: triggerOverrides,
        custom_roles: customRoles,
        workflow,
        contracts,
        load_warnings: bindingsWarnings,
        resolved_bindings: {},
    };

    checkTriggerCollisions(profile, packs);
    return profile;
}

// ─────────────────────────────────────────────────────────────────────
// Sub-parsers
// ─────────────────────────────────────────────────────────────────────

function parseWorkflow(raw: unknown): WorkflowConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProfileError("profile.workflow must be a mapping");
    }
    const obj = raw as Record<string, unknown>;
    const rg = obj["role_groups"] ?? [];
    if (!Array.isArray(rg)) {
        throw new ProfileError("workflow.role_groups must be a list of strings");
    }
    const bad = rg.filter((g) => typeof g !== "string" || g === "");
    if (bad.length > 0) {
        throw new ProfileError(`workflow.role_groups has non-string entries: ${JSON.stringify(bad)}`);
    }
    return { role_groups: rg as string[] };
}

function parseCustomRoles(items: unknown): CustomRole[] {
    if (!Array.isArray(items)) {
        if (items === undefined || items === null) return [];
        throw new ProfileError("custom_roles must be a list");
    }
    const out: CustomRole[] = [];
    const seen = new Set<string>();
    const required = ["name", "description", "agent_file", "default_alias", "default_channels"];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new ProfileError(`custom_roles[${i}] must be a mapping`);
        }
        const obj = item as Record<string, unknown>;
        const missing = required.filter((k) => !(k in obj));
        if (missing.length > 0) {
            throw new ProfileError(`custom_roles[${i}] missing fields: ${missing}`);
        }
        const name = String(obj["name"]);
        if (seen.has(name)) {
            throw new ProfileError(`custom_roles[${i}].name duplicates ${name}`);
        }
        seen.add(name);
        const channels = obj["default_channels"];
        if (!Array.isArray(channels) || channels.length === 0) {
            throw new ProfileError(`custom_roles[${i}].default_channels must be non-empty list`);
        }
        const triggers = obj["triggers"] ?? [];
        if (!Array.isArray(triggers)) {
            throw new ProfileError(`custom_roles[${i}].triggers must be a list`);
        }
        out.push({
            name,
            description: String(obj["description"]),
            agent_file: String(obj["agent_file"]),
            default_alias: String(obj["default_alias"]),
            default_channels: channels as string[],
            triggers: triggers as string[],
        });
    }
    return out;
}

function parseBindings(
    raw: unknown,
    allowedRoles: Set<string>,
    packs: Record<string, RoleDef>,
): Record<string, Binding> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProfileError("profile.bindings must be a mapping");
    }
    const out: Record<string, Binding> = {};
    for (const [role, b] of Object.entries(raw)) {
        if (!allowedRoles.has(role)) {
            let hint = "";
            if (LEGACY_CORE_ROLES.has(role)) {
                hint = (` (hint: '${role}' is a legacy coding role name; `
                        + `use 'coding-${role}' in v0.2.0+, and add `
                        + `\`workflow.role_groups: [coding]\` to your profile)`);
            } else if (Object.prototype.hasOwnProperty.call(LEGACY_ROLE_REDIRECTS, role)) {
                // v0.7.0: a profile still references a v0.6.0-era legacy
                // name. The rewrite shim was removed; surface a hard error
                // telling the user the new role to use (or "removed entirely"
                // for coding-orchestrator). The runtime dispatcher
                // (extension.ts) reuses the same table for the same purpose.
                const target = LEGACY_ROLE_REDIRECTS[role];
                if (target === null) {
                    hint = (` (hint: '${role}' was REMOVED in v0.6.0. `
                            + `Callers should dispatch via the Agent tool directly `
                            + `instead of binding a dispatch surface for it. Remove `
                            + `the '${role}' binding from your .pi/rolecast.yaml.)`);
                } else {
                    hint = (` (hint: '${role}' was renamed to '${target}' in v0.6.0. `
                            + `Update your .pi/rolecast.yaml bindings to use the new `
                            + `name. See references/v0.6.0-optimization-roadmap.md.)`);
                }
            }
            throw new ProfileError(
                `bindings key '${role}' is not in any enabled role group `
                + `and is not declared in custom_roles${hint}`,
            );
        }
        if (!b || typeof b !== "object" || Array.isArray(b)) {
            throw new ProfileError(`bindings.${role} must be a mapping`);
        }
        const obj = b as Record<string, unknown>;
        if (!("alias" in obj)) {
            throw new ProfileError(`bindings.${role}.alias is required`);
        }
        const channels = obj["channels"];
        if (!Array.isArray(channels) || channels.length === 0) {
            throw new ProfileError(`bindings.${role}.channels must be a non-empty list`);
        }
        let fallbackChain: unknown[] = (obj["fallback_chain"] as unknown[] | undefined) ?? [];
        if (fallbackChain === null) fallbackChain = [];
        if (!Array.isArray(fallbackChain) || fallbackChain.some((x) => typeof x !== "string")) {
            throw new ProfileError(
                `bindings.${role}.fallback_chain must be a list of model id strings`,
            );
        }
        const rdef = packs[role];
        out[role] = {
            alias: String(obj["alias"]),
            channels: channels as string[],
            fallback_chain: fallbackChain as string[],
            role_group: rdef?.group ?? "",
            role_name: rdef?.role ?? "",
        };
    }
    return out;
}


/**
 * v0.7.0: legacy role-name rewrite shim was removed. Profiles declaring
 * a v0.6.0-era binding name now fail loudly via `parseBindings` (which
 * consults LEGACY_ROLE_REDIRECTS to produce a migration hint).
 */


function parseNonNegotiables(raw: unknown): NonNegotiables {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProfileError("profile.non_negotiables must be a mapping");
    }
    const obj = raw as Record<string, unknown>;
    const patterns = Array.isArray(obj["forbidden_patterns"])
        ? (obj["forbidden_patterns"] as unknown[]).map((p) => forbiddenPatternFromDict(p))
        : [];
    const scopeConstraints = (obj["scope_constraints"] && typeof obj["scope_constraints"] === "object"
        && !Array.isArray(obj["scope_constraints"]))
        ? obj["scope_constraints"] as Record<string, unknown>
        : {};
    const requiredGates = Array.isArray(obj["required_gates"])
        ? obj["required_gates"] as string[]
        : [];
    return {
        forbidden_patterns: patterns,
        scope_constraints: scopeConstraints,
        required_gates: requiredGates,
    };
}

function forbiddenPatternFromDict(d: unknown): ForbiddenPattern {
    if (!d || typeof d !== "object" || Array.isArray(d)) {
        throw new ProfileError("forbidden_pattern entry must be a mapping");
    }
    const obj = d as Record<string, unknown>;
    if (!("pattern" in obj) || !("message" in obj)) {
        throw new ProfileError("forbidden_pattern entry needs {pattern, message}");
    }
    const patternStr = String(obj["pattern"]);
    const message = String(obj["message"]);
    let compiled: RegExp;
    try {
        compiled = new RegExp(patternStr);
    } catch (e) {
        throw new ProfileError(
            `forbidden_pattern regex invalid: ${JSON.stringify(patternStr)} (${(e as Error).message})`,
        );
    }
    return { pattern: patternStr, message, compiled };
}

function parseEscalation(raw: unknown): Escalation {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProfileError("profile.escalation must be a mapping");
    }
    const obj = raw as Record<string, unknown>;
    const opf = obj["on_permanent_failure"] ?? "stop";
    if (opf !== "stop" && opf !== "continue") {
        throw new ProfileError("escalation.on_permanent_failure must be 'stop' or 'continue'");
    }
    return {
        max_attempts: parseNonNegIntOrNull(obj["max_attempts"], "escalation.max_attempts") ?? 2,
        on_permanent_failure: opf,
        preserve_logs: obj["preserve_logs"] === undefined ? true : Boolean(obj["preserve_logs"]),
        audit_max_resubmits: parseNonNegIntOrNull(obj["audit_max_resubmits"], "escalation.audit_max_resubmits"),
        gate_max_attempts: parseNonNegIntOrNull(obj["gate_max_attempts"], "escalation.gate_max_attempts"),
        non_negotiable_max_retries: parseNonNegIntOrNull(obj["non_negotiable_max_retries"], "escalation.non_negotiable_max_retries"),
    };
}

/**
 * v0.7.0 (E1.3) — strict non-negative-integer-or-null validator for all
 * numeric Escalation knobs. `null` is permitted (means "unbounded").
 * Anything else (negative, non-integer, wrong type) throws ProfileError
 * with the dotted field path so the user can find the bad value.
 */
function parseNonNegIntOrNull(raw: unknown, fieldPath: string): number | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw new ProfileError(
            `${fieldPath} must be a non-negative integer or null`,
        );
    }
    return raw;
}

// ─────────────────────────────────────────────────────────────────────
// Trigger collision check
// ─────────────────────────────────────────────────────────────────────

function checkTriggerCollisions(
    profile: Profile,
    packs: Record<string, RoleDef>,
): void {
    const phraseToRoles: Record<string, Set<string>> = {};
    for (const [fullName, phrases] of Object.entries(DEFAULT_TRIGGERS)) {
        for (const p of phrases) {
            const k = p.toLowerCase();
            if (!phraseToRoles[k]) phraseToRoles[k] = new Set();
            phraseToRoles[k].add(fullName);
        }
    }
    for (const rd of Object.values(packs)) {
        for (const p of rd.triggers) {
            const k = p.toLowerCase();
            if (!phraseToRoles[k]) phraseToRoles[k] = new Set();
            phraseToRoles[k].add(rd.full_name);
        }
    }
    for (const [phrase, override] of Object.entries(profile.trigger_overrides)) {
        const target = (override && typeof override === "object" && !Array.isArray(override))
            ? (override as Record<string, unknown>).role
            : null;
        if (!target) {
            throw new ProfileError(
                `trigger_overrides['${phrase}'] must map to {role: <role>}`,
            );
        }
        const targetStr = String(target);
        if (!(targetStr in profile.bindings) &&
            !profile.custom_roles.some((r) => r.name === targetStr)) {
            throw new ProfileError(
                `trigger_overrides['${phrase}'] targets unknown role '${targetStr}'`,
            );
        }
        const k = phrase.toLowerCase();
        if (!phraseToRoles[k]) phraseToRoles[k] = new Set();
        phraseToRoles[k].add(targetStr);
    }
    for (const role of profile.custom_roles) {
        for (const p of role.triggers) {
            const k = p.toLowerCase();
            if (!phraseToRoles[k]) phraseToRoles[k] = new Set();
            phraseToRoles[k].add(role.name);
        }
    }

    const collisions: Record<string, string[]> = {};
    for (const [phrase, roles] of Object.entries(phraseToRoles)) {
        if (roles.size > 1) {
            collisions[phrase] = Array.from(roles).sort();
        }
    }
    if (Object.keys(collisions).length > 0) {
        const msg = Object.entries(collisions)
            .map(([p, r]) => `  '${p}' -> ${JSON.stringify(r)}`)
            .join("\n");
        throw new ProfileError(`trigger phrase collision:\n${msg}`);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Registry + alias resolution
// ─────────────────────────────────────────────────────────────────────

export interface RegistryLike {
    hasModel(modelId: string): boolean;
    getModel(modelId: string): Model;
    resolveAlias(name: string): ResolvedModel;
}

export class Registry implements RegistryLike {
    private _models: Record<string, Model>;
    private _aliases: Record<string, Alias>;

    constructor(models: Record<string, Model>, aliases: Record<string, Alias>) {
        this._models = models;
        this._aliases = aliases;
    }

    hasModel(modelId: string): boolean {
        return modelId in this._models;
    }

    getModel(modelId: string): Model {
        if (!(modelId in this._models)) {
            throw new ProfileError(`unknown model: ${modelId}`);
        }
        return this._models[modelId]!;
    }

    resolveAlias(name: string): ResolvedModel {
        if (!(name in this._aliases)) {
            throw new ProfileError(`unknown alias: ${name}`);
        }
        const alias = this._aliases[name]!;
        const m = this._models[alias.preferred];
        if (!m) {
            throw new ProfileError(
                `alias '${name}' preferred model '${alias.preferred}' `
                + `not in merged registry`,
            );
        }
        if (m.status === "withdrawn") {
            throw new ProfileError(
                `alias '${name}' resolves to withdrawn model '${m.id}'`,
            );
        }
        const ch = m.channels[0];
        if (!ch) {
            throw new ProfileError(
                `alias '${name}' model '${m.id}' has no channels`,
            );
        }
        const warning = m.status === "deprecated"
            ? `alias '${name}' resolves to deprecated model '${m.id}' — update profile to a stable alias`
            : null;
        return {
            model_id: m.id,
            channel_id: ch.id,
            trust: ch.trust,
            via_fallback: false,
            warning,
        };
    }
}

export function loadRegistry(frameworkRoot: string): Registry {
    const root = path.resolve(frameworkRoot);
    const [builtinModels, builtinAliases] = readRegistryPair(path.join(root, "registry"));

    const userDir = userGlobalDir();
    const [userModels] = readRegistryPair(path.join(userDir, "registry-overrides.yaml"));
    const [, userAliases] = readRegistryPair(path.join(userDir, "aliases-overrides.yaml"));

    const cwd = process.cwd();
    const [projModels, projAliases] = readRegistryPair(
        path.join(cwd, ".pi", "rolecast-registry.yaml"),
        { models: [], aliases: {} },
    );

    const mergedModels = mergeModels(builtinModels, userModels, projModels);
    const mergedAliases = mergeAliases(builtinAliases, userAliases, projAliases);
    return new Registry(mergedModels, mergedAliases);
}

export function userGlobalDir(): string {
    return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "rolecast");
}

function readRegistryPair(
    p: string,
    defaultValue: { models: unknown[]; aliases: Record<string, unknown> } | null = null,
): [unknown[], Record<string, unknown>] {
    const def = defaultValue ?? { models: [], aliases: {} };
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const builtinP = path.join(p, "built_in.yaml");
        const aliasP = path.join(p, "aliases.yaml");
        const models = fs.existsSync(builtinP)
            ? ((yaml.load(fs.readFileSync(builtinP, "utf8")) as Record<string, unknown>)["models"] as unknown[])
            : undefined;
        const aliases = fs.existsSync(aliasP)
            ? ((yaml.load(fs.readFileSync(aliasP, "utf8")) as Record<string, unknown>)["aliases"] as Record<string, unknown>)
            : undefined;
        return [models ?? [], aliases ?? {}];
    }
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const raw = yaml.load(fs.readFileSync(p, "utf8")) as Record<string, unknown> | null;
        const obj = raw ?? def;
        const models = Array.isArray(obj["models"]) ? obj["models"] : [];
        const aliases = (obj["aliases"] && typeof obj["aliases"] === "object")
            ? obj["aliases"] as Record<string, unknown>
            : {};
        return [models, aliases];
    }
    const models = Array.isArray(def["models"]) ? def["models"] : [];
    const aliases = (def["aliases"] && typeof def["aliases"] === "object")
        ? def["aliases"] as Record<string, unknown>
        : {};
    return [models, aliases];
}

function mergeModels(...layers: unknown[][]): Record<string, Model> {
    const mergedRaw: Record<string, Record<string, unknown>> = {};
    for (const layer of layers) {
        for (const m of layer) {
            if (!m || typeof m !== "object" || Array.isArray(m)) continue;
            const obj = m as Record<string, unknown>;
            if (typeof obj["id"] !== "string") continue;
            const id = obj["id"];
            const base = mergedRaw[id] ?? {};
            mergedRaw[id] = { ...base, ...obj };
        }
    }
    const out: Record<string, Model> = {};
    for (const [id, m] of Object.entries(mergedRaw)) {
        out[id] = {
            id,
            vendor: typeof m["vendor"] === "string" ? m["vendor"] : "",
            capabilities: (m["capabilities"] && typeof m["capabilities"] === "object")
                ? m["capabilities"] as Record<string, unknown>
                : {},
            channels: Array.isArray(m["channels"])
                ? (m["channels"] as Array<{ id: string; trust: string }>)
                : [],
            cost_tier: typeof m["cost_tier"] === "string" ? m["cost_tier"] : "",
            status: typeof m["status"] === "string" ? m["status"] : "stable",
        };
    }
    return out;
}

function mergeAliases(...layers: Record<string, unknown>[]): Record<string, Alias> {
    const mergedRaw: Record<string, Record<string, unknown>> = {};
    for (const layer of layers) {
        for (const [name, aRaw] of Object.entries(layer)) {
            const a = (aRaw && typeof aRaw === "object" && !Array.isArray(aRaw))
                ? aRaw as Record<string, unknown>
                : {};
            const base = mergedRaw[name] ?? {};
            mergedRaw[name] = { ...base, ...a };
        }
    }
    const out: Record<string, Alias> = {};
    for (const [name, a] of Object.entries(mergedRaw)) {
        if (!("preferred" in a)) {
            throw new ProfileError(
                `alias '${name}' missing required field 'preferred' after merge`,
            );
        }
        const obj = a as Record<string, unknown>;
        out[name] = {
            name,
            preferred: String(obj["preferred"]),
            fallback_chain: Array.isArray(obj["fallback_chain"])
                ? obj["fallback_chain"] as string[]
                : [],
            notes: typeof obj["notes"] === "string" ? obj["notes"] : "",
        };
    }
    return out;
}

export function resolveBindings(
    profile: Profile,
    registry: RegistryLike,
): Record<string, ResolvedBinding> {
    const out: Record<string, ResolvedBinding> = {};
    for (const [role, binding] of Object.entries(profile.bindings)) {
        out[role] = resolveBinding(role, binding, registry);
    }
    return out;
}

function resolveBinding(
    role: string,
    binding: Binding,
    registry: RegistryLike,
): ResolvedBinding {
    let primary: ResolvedModel;
    try {
        primary = registry.resolveAlias(binding.alias);
    } catch (e) {
        throw new ProfileError(`bindings.${role}: ${(e as Error).message}`);
    }
    const primaryModel = registry.getModel(primary.model_id);
    for (const ch of primaryModel.channels) {
        if (binding.channels.includes(ch.id)) {
            return {
                role,
                alias: binding.alias,
                model_id: primaryModel.id,
                channel_id: ch.id,
                trust: ch.trust,
                warning: primary.warning,
                via_fallback: false,
            };
        }
    }
    const available = primaryModel.channels.map((c) => c.id);
    throw new ProfileError(
        `bindings.${role}: no channel in ${JSON.stringify(binding.channels)} is available `
        + `for preferred model '${primaryModel.id}' (model exposes: ${JSON.stringify(available)})`,
    );
}