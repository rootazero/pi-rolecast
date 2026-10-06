/**
 * src/sync_settings.ts
 *
 * v0.5.0: TypeScript port of scripts/sync_settings.py.
 *
 * Syncs profile model bindings to two destinations:
 *
 *   1. **Project-local agent files** (`.pi/agents/<full-role-name>.md`):
 *      authoritative dispatch path — pi-subagents reads these and wins
 *      over any global settings.json hint.
 *
 *   2. **settings.json** (`~/.pi/agent/settings.json`, opt-in via
 *      `--settings-write`): NOT authoritative; preserved only for
 *      parity with earlier skill designs.
 *
 * Pure TS: no PyYAML, no python3, no subprocess. File I/O uses
 * node:fs; YAML frontmatter manipulation is plain string surgery (no
 * full YAML parse — we only touch one `field: value` line).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    availableRoles,
    discoverRolePacks,
    findProfile,
    loadProfile,
    loadRegistry,
    ProfileError,
    resolveBindings,
    type Profile,
    type Registry,
    type RegistryLike,
    type RoleDef,
} from "./profile_loader.js";

// pi uses different provider keys than our registry's `vendor` field.
const VENDOR_TO_PROVIDER: Record<string, string> = {
    minimax: "minimax-cn",
    deepseek: "deepseek",
    openai: "openai-codex",
    anthropic: "anthropic",
    moonshotai: "kimi-coding",
    "kimi-coding": "kimi-coding",
    typesafe: "typesafe",
};

export const DEFAULT_SETTINGS_PATH = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "settings.json",
);

export interface AgentOverride {
    model: string;
    channel: string;
}

/** Result of a sync operation — for tests + status output. */
export interface SyncResult {
    /** settings.json written (opt-in only; absent otherwise). */
    settingsWritten?: string;
    /** Number of .md agent files written. */
    agentsWritten: number;
    /** Where .md agent files went. */
    agentsDir: string;
    /** Per-role actions (for status / debug). */
    perRole: Record<string, { model: string; provider: string; writtenTo?: string }>;
}

export interface ClearResult {
    settingsRemoved: number;
    agentsRemoved: number;
    agentsDir: string;
}

export interface SyncStatusEntry {
    role: string;
    profileModel: string;
    profileChannel: string;
    agentFile: string;
    agentFileExists: boolean;
    agentFileModel: string | null;
    drift: boolean;
}

export interface SyncStatus {
    profile: string;
    settings: string;
    agentsDir: string;
    entries: SyncStatusEntry[];
    frameworkOverridesInSettings: number;
    expectedOverrides: number;
}

// ─────────────────────────────────────────────────────────────────────
// Provider resolution
// ─────────────────────────────────────────────────────────────────────

export function providerForModel(modelId: string, registry: RegistryLike | null): string {
    if (registry === null) return "";
    if (!registry.hasModel(modelId)) return "";
    const model = registry.getModel(modelId);
    const vendor = model.vendor ?? "";
    if (vendor in VENDOR_TO_PROVIDER) return VENDOR_TO_PROVIDER[vendor]!;
    if (vendor !== "") return vendor;
    return "";
}

// ─────────────────────────────────────────────────────────────────────
// YAML frontmatter manipulation
// ─────────────────────────────────────────────────────────────────────

/** Replace or insert `field: value` in the file's frontmatter block. */
export function setFrontmatterField(body: string, field: string, value: string): string {
    const lines = body.split(/\r?\n/);
    if (lines.length === 0 || lines[0]!.trim() !== "---") {
        const newFront = ["---", `${field}: ${value}`, "---", ""];
        return newFront.join("\n") + body;
    }
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---") {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) return body;
    const prefix = `${field}:`;
    const newLines: string[] = [];
    let replaced = false;
    for (let i = 1; i < endIdx; i++) {
        const ln = lines[i]!;
        if (ln.startsWith(prefix) && !replaced) {
            newLines.push(`${field}: ${value}`);
            replaced = true;
        } else {
            newLines.push(ln);
        }
    }
    if (!replaced) newLines.push(`${field}: ${value}`);
    return [...lines.slice(0, 1), ...newLines, ...lines.slice(endIdx)].join("\n");
}

function readFrontmatterModel(text: string): string | null {
    const m = text.match(/^model:\s*(.+?)\s*$/m);
    return m ? m[1]! : null;
}

// ─────────────────────────────────────────────────────────────────────
// settings.json I/O
// ─────────────────────────────────────────────────────────────────────

export function readSettings(settingsPath: string): Record<string, unknown> {
    if (!fs.existsSync(settingsPath)) return {};
    const text = fs.readFileSync(settingsPath, "utf8");
    if (text.trim() === "") return {};
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return {};
    }
}

export function writeSettings(
    settingsPath: string,
    settings: Record<string, unknown>,
    dryRun: boolean,
    summary: string,
): number {
    if (dryRun) {
        process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
        return 0;
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
        settingsPath,
        `${JSON.stringify(settings, null, 2)}\n`,
    );
    process.stdout.write(`${summary}: ${settingsPath}\n`);
    return 0;
}

export function mergeAndWriteSettings(
    settingsPath: string,
    newOverrides: Record<string, AgentOverride>,
    dryRun: boolean,
): number {
    const settings = readSettings(settingsPath);
    const subagents = (settings["subagents"] as Record<string, unknown> | undefined) ?? {};
    const existing = (subagents["agentOverrides"] as Record<string, AgentOverride> | undefined) ?? {};
    const merged: Record<string, AgentOverride> = { ...existing };
    for (const [role, override] of Object.entries(newOverrides)) {
        merged[role] = override;
    }
    subagents["agentOverrides"] = merged;
    settings["subagents"] = subagents;
    return writeSettings(
        settingsPath,
        settings,
        dryRun,
        `synced ${Object.keys(newOverrides).length} roles in settings.json`,
    );
}

export function clearSettings(settingsPath: string, dryRun: boolean): number {
    const settings = readSettings(settingsPath);
    const subagents = (settings["subagents"] as Record<string, unknown> | undefined) ?? {};
    const existing = (subagents["agentOverrides"] as Record<string, AgentOverride> | undefined) ?? {};
    const removed = Object.keys(existing);
    subagents["agentOverrides"] = {};
    settings["subagents"] = subagents;
    return writeSettings(
        settingsPath,
        settings,
        dryRun,
        `removed ${removed.length} agent overrides from settings.json`,
    );
}

// ─────────────────────────────────────────────────────────────────────
// Project-local .md agent file write / clear
// ─────────────────────────────────────────────────────────────────────

export interface WriteAgentsResult {
    written: number;
    perRole: Record<string, { model: string; provider: string; writtenTo?: string }>;
}

export function writeAgents(opts: {
    agentsDir: string;
    frameworkRoot: string;
    enabledGroups: readonly string[];
    overrides: Record<string, AgentOverride>;
    dryRun: boolean;
    registry: RegistryLike | null;
}): WriteAgentsResult {
    const roles = availableRoles(opts.frameworkRoot, opts.enabledGroups.length > 0 ? opts.enabledGroups : undefined);
    const perRole: Record<string, { model: string; provider: string; writtenTo?: string }> = {};
    let written = 0;
    const sorted = Object.keys(roles).sort();
    for (const fullName of sorted) {
        if (!(fullName in opts.overrides)) continue;
        const rd: RoleDef = roles[fullName]!;
        const modelId = opts.overrides[fullName]!.model;
        const provider = providerForModel(modelId, opts.registry);
        const full = provider !== "" ? `${provider}/${modelId}` : modelId;
        const dst = path.join(opts.agentsDir, `${fullName}.md`);
        if (opts.dryRun) {
            process.stdout.write(`would write ${dst} model=${full}\n`);
            perRole[fullName] = { model: full, provider };
            continue;
        }
        const src = rd.file_path;
        if (src === null || !fs.existsSync(src)) {
            process.stderr.write(`warning: role-packs file not found: ${rd.file_path}\n`);
            continue;
        }
        const body = fs.readFileSync(src, "utf8");
        const updated = setFrontmatterField(body, "model", full);
        fs.mkdirSync(opts.agentsDir, { recursive: true });
        fs.writeFileSync(dst, updated);
        written++;
        perRole[fullName] = { model: full, provider, writtenTo: dst };
    }
    if (!opts.dryRun) {
        process.stdout.write(`wrote ${written} project-local agent files to ${opts.agentsDir}\n`);
    }
    return { written, perRole };
}

export function clearAgents(opts: {
    agentsDir: string;
    frameworkRoot: string;
    dryRun: boolean;
}): number {
    if (!fs.existsSync(opts.agentsDir)) {
        process.stdout.write(`no project-local agent dir at ${opts.agentsDir}\n`);
        return 0;
    }
    let removed = 0;
    const files = fs
        .readdirSync(opts.agentsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    for (const f of files) {
        const p = path.join(opts.agentsDir, f);
        if (fs.lstatSync(p).isSymbolicLink()) continue;
        if (opts.dryRun) {
            process.stdout.write(`would remove ${p}\n`);
            removed++;
            continue;
        }
        fs.unlinkSync(p);
        removed++;
    }
    process.stdout.write(`removed ${removed} project-local agent files\n`);
    return 0;
}

// ─────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────

export function showStatus(opts: {
    profilePath: string;
    settingsPath: string;
    agentsDir: string;
    frameworkRoot: string;
    expectedOverrides: Record<string, AgentOverride>;
}): SyncStatus {
    const entries: SyncStatusEntry[] = [];
    for (const role of Object.keys(opts.expectedOverrides).sort()) {
        const ov = opts.expectedOverrides[role]!;
        const agentFile = path.join(opts.agentsDir, `${role}.md`);
        const exists = fs.existsSync(agentFile);
        const fileModel = exists ? readFrontmatterModel(fs.readFileSync(agentFile, "utf8")) : null;
        const expected = ov.model;
        entries.push({
            role,
            profileModel: ov.model,
            profileChannel: ov.channel,
            agentFile,
            agentFileExists: exists,
            agentFileModel: fileModel,
            // Compare model field. settings.json compares by `model` key, but
            // agent files include provider/ prefix; both store the fully-qualified
            // form, so we compare directly.
            drift: exists ? (fileModel ?? "") !== expected : true,
        });
    }
    const settings = readSettings(opts.settingsPath);
    const subagents = (settings["subagents"] as Record<string, unknown> | undefined) ?? {};
    const overrides = (subagents["agentOverrides"] as Record<string, AgentOverride> | undefined) ?? {};
    const expectedKeys = new Set(Object.keys(opts.expectedOverrides));
    const frameworkInSettings = Object.keys(overrides).filter((r) => expectedKeys.has(r)).length;
    return {
        profile: opts.profilePath,
        settings: opts.settingsPath,
        agentsDir: opts.agentsDir,
        entries,
        frameworkOverridesInSettings: frameworkInSettings,
        expectedOverrides: expectedKeys.size,
    };
}

// ─────────────────────────────────────────────────────────────────────
// Main sync orchestration
// ─────────────────────────────────────────────────────────────────────

export interface SyncOptions {
    profilePath: string;
    frameworkRoot: string;
    settingsPath?: string;
    agentsDir?: string;
    settingsWrite?: boolean;
    noAgents?: boolean;
    dryRun?: boolean;
}

export function syncSettings(opts: SyncOptions): SyncResult {
    const settingsPath = opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
    const agentsDir = opts.agentsDir ?? path.join(process.cwd(), ".pi", "agents");
    const dryRun = opts.dryRun ?? false;

    const profile = loadProfile(opts.profilePath, opts.frameworkRoot);
    const registry = tryLoadRegistry(opts.frameworkRoot);
    if (registry === null) {
        throw new ProfileError(
            `cannot sync without a valid registry (framework root: ${opts.frameworkRoot})`,
        );
    }
    const resolved = resolveBindings(profile, registry);

    const overrides: Record<string, AgentOverride> = {};
    for (const [role, binding] of Object.entries(resolved)) {
        overrides[role] = { model: binding.model_id, channel: binding.channel_id };
    }

    const result: SyncResult = {
        agentsWritten: 0,
        agentsDir,
        perRole: {},
    };

    if (opts.settingsWrite === true) {
        mergeAndWriteSettings(settingsPath, overrides, dryRun);
        result.settingsWritten = settingsPath;
    }

    if (opts.noAgents !== true) {
        const r = writeAgents({
            agentsDir,
            frameworkRoot: opts.frameworkRoot,
            enabledGroups: profile.workflow.role_groups,
            overrides,
            dryRun,
            registry,
        });
        result.agentsWritten = r.written;
        result.perRole = r.perRole;
    }

    const writtenTo: string[] = [];
    if (result.settingsWritten !== undefined) writtenTo.push("settings.json");
    if (opts.noAgents !== true) writtenTo.push(agentsDir);
    if (writtenTo.length > 0) {
        process.stdout.write(`synced: ${writtenTo.join(", ")}\n`);
    }
    return result;
}

export function clearSync(opts: {
    settingsPath?: string;
    agentsDir?: string;
    frameworkRoot: string;
    dryRun?: boolean;
}): ClearResult {
    const settingsPath = opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
    const agentsDir = opts.agentsDir ?? path.join(process.cwd(), ".pi", "agents");
    const dryRun = opts.dryRun ?? false;
    const settings = readSettings(settingsPath);
    const subagents = (settings["subagents"] as Record<string, unknown> | undefined) ?? {};
    const existing = (subagents["agentOverrides"] as Record<string, AgentOverride> | undefined) ?? {};
    const settingsRemoved = Object.keys(existing).length;
    if (settingsRemoved > 0 || dryRun) {
        clearSettings(settingsPath, dryRun);
    }
    clearAgents({ agentsDir, frameworkRoot: opts.frameworkRoot, dryRun });
    return { settingsRemoved, agentsRemoved: -1, agentsDir };
}

// ─────────────────────────────────────────────────────────────────────
// Registry loading helper (test seam — mirrors Python's wrapper)
// ─────────────────────────────────────────────────────────────────────

export function tryLoadRegistry(frameworkRoot: string): Registry | null {
    try {
        return loadRegistry(frameworkRoot);
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────
// CLI wrapper (preserved for parity with the old sync_settings.py entry)
// ─────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
    const args = argv.slice(2);
    const opts = parseCliFlags(args);

    if (opts.frameworkRoot === undefined) {
        opts.frameworkRoot = path.resolve(__dirname, "..");
    }

    if (opts.listGroups === true) {
        const packs = discoverRolePacks(opts.frameworkRoot);
        const keys = Object.keys(packs);
        if (keys.length === 0) {
            process.stdout.write("(no role-packs/* directories found under framework root)\n");
            return 0;
        }
        for (const g of keys.sort()) {
            const roles = packs[g]!;
            process.stdout.write(
                `${g}/ (${roles.length} roles): ${roles.map((r) => r.full_name).join(", ")}\n`,
            );
        }
        return 0;
    }

    if (opts.clear === true) {
        const r = clearSync({
            settingsPath: opts.settings,
            agentsDir: opts.agentsDir,
            frameworkRoot: opts.frameworkRoot,
            dryRun: opts.dryRun,
        });
        return r.settingsRemoved > 0 ? 0 : 0;
    }

    if (opts.profile === undefined) {
        const discovered = findProfile(process.cwd());
        if (discovered === null) {
            process.stderr.write(
                "error: no profile found (looked for .pi/rolecast.yaml and legacy .pi/agent-workflow.yaml in cwd)\n",
            );
            return 2;
        }
        opts.profile = discovered;
    }

    if (!fs.existsSync(opts.profile)) {
        process.stderr.write(`error: profile not found: ${opts.profile}\n`);
        return 2;
    }

    let profile: Profile;
    try {
        profile = loadProfile(opts.profile, opts.frameworkRoot);
    } catch (e) {
        if (e instanceof ProfileError) {
            process.stderr.write(`error: profile invalid: ${e.message}\n`);
            return 2;
        }
        throw e;
    }

    const registry = tryLoadRegistry(opts.frameworkRoot);
    if (registry === null) {
        process.stderr.write(`error: could not load registry from ${opts.frameworkRoot}\n`);
        return 2;
    }
    const resolved = resolveBindings(profile, registry);

    const overrides: Record<string, AgentOverride> = {};
    for (const [role, binding] of Object.entries(resolved)) {
        overrides[role] = { model: binding.model_id, channel: binding.channel_id };
    }

    if (opts.status === true) {
        const status = showStatus({
            profilePath: opts.profile,
            settingsPath: opts.settings,
            agentsDir: opts.agentsDir,
            frameworkRoot: opts.frameworkRoot,
            expectedOverrides: overrides,
        });
        printStatus(status);
        return 0;
    }

    if (opts.settingsWrite === true) {
        mergeAndWriteSettings(opts.settings, overrides, opts.dryRun);
    }
    if (opts.noAgents !== true) {
        writeAgents({
            agentsDir: opts.agentsDir,
            frameworkRoot: opts.frameworkRoot,
            enabledGroups: profile.workflow.role_groups,
            overrides,
            dryRun: opts.dryRun,
            registry,
        });
    }
    return 0;
}

function printStatus(status: SyncStatus): void {
    process.stdout.write("=".repeat(70) + "\n");
    process.stdout.write(" pi-rolecast sync status\n");
    process.stdout.write("=".repeat(70) + "\n");

    process.stdout.write(`\nProfile bindings (${status.profile}):\n`);
    if (status.entries.length === 0) {
        process.stdout.write("  (no bindings)\n");
    }
    for (const e of status.entries) {
        process.stdout.write(
            `  ${e.role.padEnd(22)} model=${e.profileModel.padEnd(26)} channel=${e.profileChannel}\n`,
        );
    }

    process.stdout.write(`\nProject-local agent files (${status.agentsDir}):\n`);
    if (status.entries.length === 0) {
        process.stdout.write("  (nothing to check — no profile bindings)\n");
    }
    for (const e of status.entries) {
        if (!e.agentFileExists) {
            process.stdout.write(`  ${e.role.padEnd(22)} (missing)\n`);
            continue;
        }
        const actual = e.agentFileModel ?? "(no model)";
        const match = e.drift ? "DRIFT" : "OK";
        process.stdout.write(
            `  ${e.role.padEnd(22)} model=${actual.padEnd(26)} ${match}\n`,
        );
    }

    process.stdout.write(`\nsettings.json: ${status.settings}\n`);
    process.stdout.write(
        `  framework overrides: ${status.frameworkOverridesInSettings}/${status.expectedOverrides}\n`,
    );
}

interface CliFlags {
    profile?: string;
    settings: string;
    frameworkRoot?: string;
    agentsDir: string;
    clear: boolean;
    dryRun: boolean;
    noAgents: boolean;
    settingsWrite: boolean;
    status: boolean;
    listGroups: boolean;
}

function parseCliFlags(args: string[]): CliFlags {
    const out: CliFlags = {
        settings: DEFAULT_SETTINGS_PATH,
        agentsDir: path.join(process.cwd(), ".pi", "agents"),
        clear: false,
        dryRun: false,
        noAgents: false,
        settingsWrite: false,
        status: false,
        listGroups: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        switch (a) {
            case "--profile":
                out.profile = args[++i];
                break;
            case "--settings":
                out.settings = args[++i]!;
                break;
            case "--framework-root":
                out.frameworkRoot = args[++i];
                break;
            case "--agents-dir":
                out.agentsDir = args[++i]!;
                break;
            case "--clear":
                out.clear = true;
                break;
            case "--dry-run":
                out.dryRun = true;
                break;
            case "--no-agents":
                out.noAgents = true;
                break;
            case "--settings-write":
                out.settingsWrite = true;
                break;
            case "--status":
                out.status = true;
                break;
            case "--list-groups":
                out.listGroups = true;
                break;
        }
    }
    return out;
}

// ESM entry guard — CLI runs only when invoked directly, not when imported.
export const __testing = {
    setFrontmatterField,
    providerForModel,
    readFrontmatterModel,
    mergeAndWriteSettings,
    clearSettings,
    readSettings,
    writeSettings,
    writeAgents,
    clearAgents,
    showStatus,
    syncSettings,
    clearSync,
    tryLoadRegistry,
    parseCliFlags,
};

if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv).then(
        (rc) => process.exit(rc),
        (err) => {
            process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        },
    );
}
