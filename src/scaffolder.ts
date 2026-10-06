/**
 * pi-rolecast/src/scaffolder.ts
 *
 * Init / diff / validate logic for project profiles. Replaces the
 * `scripts/scaffolder.py` subprocess the extension used to spawn for
 * `scaffolder_init` / `scaffolder_validate` / `scaffolder_diff` tools
 * and the `/rolecast-init` / `-validate` / `-diff` slash commands. Now
 * an in-process module that the extension imports directly.
 *
 * Spec §9.2 (language detection), §9.4 (diff), §9.5 (validate).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";

import { loadProfile, ProfileError } from "./profile_loader.js";

// ─────────────────────────────────────────────────────────────────────
// Language auto-detect (spec §9.2)
// ─────────────────────────────────────────────────────────────────────

/** Language → list of files; ALL required for a confident match. */
const LANGUAGE_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["rust", ["Cargo.toml"]],
    ["python", ["pyproject.toml"]],
    ["python", ["setup.py"]],
    ["typescript", ["package.json", "tsconfig.json"]],
    ["go", ["go.mod"]],
];

/**
 * Return ALL detected languages for a project (multi-lang aware).
 *
 * Spec §9.2: package.json alone is ambiguous — caller must prompt user.
 * Both "typescript" and "javascript" are surfaced so the prompt can offer
 * both. detectLanguage() returns null in that case.
 */
export function autoDetectLanguages(projectRoot: string): string[] {
    const root = path.resolve(projectRoot);
    const detected = new Set<string>();
    // package.json alone is ambiguous — handled separately.
    if (fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "tsconfig.json"))) {
        detected.add("typescript");
        detected.add("javascript");
    }
    for (const [lang, files] of LANGUAGE_MARKERS) {
        if (files.every((f) => fs.existsSync(path.join(root, f)))) {
            detected.add(lang);
        }
    }
    return Array.from(detected);
}

/**
 * Return the single best-guess language (spec §9.2 priority order),
 * or null if ambiguous / unknown.
 *
 * Ambiguity is narrow: detected == ["typescript", "javascript"]
 * (package.json-only). Other languages override the ambiguity — e.g.
 * Cargo.toml + package.json still yields "rust" via priority order.
 */
export function detectLanguage(projectRoot: string): string | null {
    const detected = autoDetectLanguages(projectRoot);
    if (detected.length === 2 && detected.includes("typescript") && detected.includes("javascript")) {
        return null;
    }
    const confident = detected.filter((l) => l !== "javascript");
    if (confident.length === 1) return confident[0]!;
    if (confident.length === 0) return null;
    const priority = ["rust", "python", "typescript", "go"];
    for (const p of priority) {
        if (confident.includes(p)) return p;
    }
    return confident[0]!;
}

// ─────────────────────────────────────────────────────────────────────
// init subcommand
// ─────────────────────────────────────────────────────────────────────

export interface ScaffoldInitOptions {
    projectRoot: string;
    frameworkRoot: string;
    /** Explicit template name; skips auto-detect. */
    template?: string | null;
    /** Emit a profile with no fields pre-filled (loads templates/blank.yaml). */
    blank?: boolean;
    /** Print what would be created, do not write. */
    dryRun?: boolean;
    /** Overwrite an existing profile. */
    force?: boolean;
    /** Write to .pi/agent-workflow.yaml instead of .pi/rolecast.yaml. */
    legacyName?: boolean;
}

export interface ScaffoldInitResult {
    ok: boolean;
    profilePath?: string;
    template: string;
    message: string;
}

export function scaffoldInit(opts: ScaffoldInitOptions): ScaffoldInitResult {
    const projectRoot = path.resolve(opts.projectRoot);
    const frameworkRoot = path.resolve(opts.frameworkRoot);
    const templatesDir = path.join(frameworkRoot, "templates");
    const profileDir = path.join(projectRoot, ".pi");
    const profilePath = opts.legacyName
        ? path.join(profileDir, "agent-workflow.yaml")
        : path.join(profileDir, "rolecast.yaml");

    let lang: string | null;
    if (opts.template) {
        lang = opts.template;
    } else if (opts.blank) {
        lang = null;
    } else {
        lang = detectLanguage(projectRoot);
        if (lang === null) {
            const detected = autoDetectLanguages(projectRoot);
            return {
                ok: false,
                profilePath,
                template: "(blank)",
                message: `could not auto-detect language (detected: ${JSON.stringify(detected)}). Pass --template to pick one.`,
            };
        }
    }

    if (opts.dryRun) {
        return {
            ok: true,
            profilePath,
            template: lang ?? "(blank)",
            message: `DRY RUN — would create: ${profilePath}\ntemplate: ${lang ?? "(blank)"}`,
        };
    }

    let templateData: Record<string, unknown>;
    try {
        templateData = lang !== null
            ? loadTemplate(templatesDir, lang)
            : blankTemplate(frameworkRoot);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, profilePath, template: lang ?? "(blank)", message: msg };
    }

    if (fs.existsSync(profilePath) && !opts.force) {
        return {
            ok: false,
            profilePath,
            template: lang ?? "(blank)",
            message: `profile already exists at ${profilePath}; pass --force to overwrite`,
        };
    }

    fs.mkdirSync(profileDir, { recursive: true });
    writeProfile(profilePath, templateData);
    return {
        ok: true,
        profilePath,
        template: lang ?? "(blank)",
        message: [
            `wrote ${profilePath}`,
            "next steps:",
            `  /rolecast-validate         # validate ${profilePath}`,
            `  /rolecast-run [phase]      # run the gate-runner (defaults to all phases)`,
            `  /rolecast-sync             # sync profile bindings to .pi/agents/*.md`,
        ].join("\n"),
    };
}

function loadTemplate(templatesDir: string, lang: string): Record<string, unknown> {
    const p = path.join(templatesDir, `${lang}.yaml`);
    if (!fs.existsSync(p)) {
        throw new Error(`no template for language '${lang}': ${p}`);
    }
    return yamlLoad(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/**
 * v0.4.3: load templates/blank.yaml instead of hardcoding empty
 * name/description. The hardcoded dict produced profiles that failed
 * parse_profile validation (profile.name is required), which surfaced
 * as "failed to load bindings" warnings every time the user opened pi
 * from a directory containing the bad profile. Loading the actual
 * template keeps the blank scaffolder in lockstep with the file shipped
 * in templates/, and ensures the generated profile always satisfies the
 * schema.
 */
function blankTemplate(frameworkRoot: string): Record<string, unknown> {
    return loadTemplate(path.join(frameworkRoot, "templates"), "blank");
}

function writeProfile(profilePath: string, data: Record<string, unknown>): void {
    fs.writeFileSync(profilePath, yamlDump(data, { sortKeys: false }));
}

// ─────────────────────────────────────────────────────────────────────
// diff subcommand (spec §9.4)
// ─────────────────────────────────────────────────────────────────────

export interface DiffProfileOptions {
    profilePath: string;
    frameworkRoot: string;
}

export interface DiffProfileResult {
    ok: boolean;
    profileVersion?: string;
    output: string;
}

export function diffProfile(opts: DiffProfileOptions): DiffProfileResult {
    const profilePath = path.resolve(opts.profilePath);
    const fwRoot = path.resolve(opts.frameworkRoot);
    if (!fs.existsSync(profilePath)) {
        return { ok: false, output: `profile not found: ${profilePath}` };
    }
    let raw: unknown;
    try {
        raw = yamlLoad(fs.readFileSync(profilePath, "utf8"));
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, output: `failed to parse profile YAML: ${msg}` };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, output: "profile is not a YAML mapping" };
    }
    const obj = raw as Record<string, unknown>;
    const profileVersion = obj["framework_version"];
    if (!profileVersion || typeof profileVersion !== "string") {
        return { ok: false, output: "profile.framework_version is required for diff" };
    }

    const profileFields = new Set(flattenKeys(obj));

    const addedFile = path.join(fwRoot, "added-fields.yaml");
    const removedFile = path.join(fwRoot, "removed-fields.yaml");

    const missing: string[] = [];
    if (fs.existsSync(addedFile)) {
        const addedData = (yamlLoad(fs.readFileSync(addedFile, "utf8")) as Record<string, unknown> | null) ?? {};
        const added = Array.isArray(addedData["added"]) ? (addedData["added"] as string[]) : [];
        for (const f of added) {
            if (!profileFields.has(f)) missing.push(f);
        }
    }

    const lines: string[] = [];
    lines.push(`profile framework_version: ${profileVersion}`);
    if (missing.length > 0) {
        lines.push("fields missing from profile (added in newer framework):");
        for (const f of missing) lines.push(`  - ${f}`);
    } else {
        lines.push("no missing fields");
    }

    const deprecated: string[] = [];
    if (fs.existsSync(removedFile)) {
        const removedData = (yamlLoad(fs.readFileSync(removedFile, "utf8")) as Record<string, unknown> | null) ?? {};
        const removed = Array.isArray(removedData["removed"]) ? (removedData["removed"] as string[]) : [];
        for (const f of removed) {
            if (profileFields.has(f)) deprecated.push(f);
        }
    }
    if (deprecated.length > 0) {
        lines.push("fields deprecated in newer framework:");
        for (const f of deprecated) lines.push(`  - ${f}`);
    }
    lines.push("no auto-merge. apply changes manually.");
    return { ok: true, profileVersion, output: lines.join("\n") };
}

function flattenKeys(d: Record<string, unknown>, prefix = ""): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(d)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
            out.push(...flattenKeys(v as Record<string, unknown>, key));
        } else {
            out.push(key);
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────
// validate subcommand (spec §9.5)
// ─────────────────────────────────────────────────────────────────────

export interface ValidateProfileOptions {
    profilePath: string;
    frameworkRoot: string;
}

export interface ValidateProfileResult {
    ok: boolean;
    output: string;
}

export function validateProfile(opts: ValidateProfileOptions): ValidateProfileResult {
    try {
        const profile = loadProfile(opts.profilePath, opts.frameworkRoot);
        const lines: string[] = [];
        lines.push(`profile '${profile.name}' is valid (framework ${profile.framework_version})`);
        lines.push(`  bindings resolved: ${Object.keys(profile.resolved_bindings).length}`);
        for (const [role, rb] of Object.entries(profile.resolved_bindings)) {
            const warn = rb.warning ? ` [WARN: ${rb.warning}]` : "";
            lines.push(`    ${role}: ${rb.alias} -> ${rb.model_id} on ${rb.channel_id}${warn}`);
        }
        return { ok: true, output: lines.join("\n") };
    } catch (e) {
        if (e instanceof ProfileError) {
            return { ok: false, output: `INVALID: ${e.message}` };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, output: `INVALID: ${msg}` };
    }
}

// ─────────────────────────────────────────────────────────────────────
// CLI wrapper (kept for parity with the old `python3 scripts/scaffolder.py`
// entry point — any out-of-band shell script can call `node dist/dump_bindings.js`)
// ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): number {
    const args = argv.slice(2);
    const command = args[0];
    const opts = parseCliFlags(args.slice(1));
    switch (command) {
        case "init": {
            const r = scaffoldInit({
                projectRoot: opts.projectRoot ?? process.cwd(),
                frameworkRoot: opts.frameworkRoot ?? defaultFrameworkRoot(),
                template: opts.template ?? null,
                blank: opts.blank === true,
                dryRun: opts.dryRun === true,
                force: opts.force === true,
                legacyName: opts.legacyName === true,
            });
            process.stdout.write(r.message + "\n");
            return r.ok ? 0 : 1;
        }
        case "diff": {
            const profilePath = opts.profile;
            if (!profilePath) {
                process.stderr.write("--profile is required for diff\n");
                return 1;
            }
            const r = diffProfile({
                profilePath,
                frameworkRoot: opts.frameworkRoot ?? defaultFrameworkRoot(),
            });
            process.stdout.write(r.output + "\n");
            return r.ok ? 0 : 1;
        }
        case "validate": {
            const profilePath = opts.profile;
            if (!profilePath) {
                process.stderr.write("--profile is required for validate\n");
                return 1;
            }
            const r = validateProfile({
                profilePath,
                frameworkRoot: opts.frameworkRoot ?? defaultFrameworkRoot(),
            });
            process.stdout.write(r.output + "\n");
            return r.ok ? 0 : 1;
        }
        default:
            process.stderr.write(
                `usage: scaffolder {init|diff|validate} [--framework-root|--project-root|--profile|--template|--blank|--dry-run|--force|--legacy-name]\n`,
            );
            return 2;
    }
}

interface ParsedFlags {
    frameworkRoot?: string;
    projectRoot?: string;
    profile?: string;
    template?: string;
    blank?: boolean;
    dryRun?: boolean;
    force?: boolean;
    legacyName?: boolean;
}

function parseCliFlags(args: string[]): ParsedFlags {
    const out: ParsedFlags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        switch (a) {
            case "--framework-root":
                out.frameworkRoot = args[++i];
                break;
            case "--project-root":
                out.projectRoot = args[++i];
                break;
            case "--profile":
                out.profile = args[++i];
                break;
            case "--template":
                out.template = args[++i];
                break;
            case "--blank":
                out.blank = true;
                break;
            case "--dry-run":
                out.dryRun = true;
                break;
            case "--force":
                out.force = true;
                break;
            case "--legacy-name":
                out.legacyName = true;
                break;
        }
    }
    return out;
}

function defaultFrameworkRoot(): string {
    // Mirror Python: src/scaffolder.ts → ../.. is the framework root.
    // src/profile_loader.ts exposes a similar helper but we keep this
    // self-sufficient so the CLI works without re-importing.
    return path.resolve(__dirname, "..", "..");
}

export const __testing = {
    flattenKeys,
    loadTemplate,
};