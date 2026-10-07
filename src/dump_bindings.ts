/**
 * pi-rolecast/src/dump_bindings.ts
 *
 * Emit a snapshot of the loaded profile (bindings + role frontmatter
 * `requires:` / `preferences:`) for the rest of the TypeScript extension
 * to consume. Replaces the `scripts/dump_bindings.py` subprocess that
 * the extension used to spawn at session_start — now an in-process
 * function call with the same JSON shape, so the extension can no longer
 * fail with a Python traceback.
 *
 * Schema-parsing still lives in `src/profile_loader.ts`. This module is
 * just the emitter that combines `loadProfile` output with `availableRoles`
 * role-pack frontmatter into the shape the extension's `loadBindings`
 * hook expects.
 */
import * as path from "node:path";

import {
    availableRoles,
    findProfile,
    loadProfile,
    ProfileError,
    type Profile,
} from "./profile_loader.js";

export interface BindingPayload {
    alias: string;
    channels: string[];
    fallback_chain: string[];
    requires: Record<string, unknown>;
    preferences: Record<string, unknown>;
    // v0.6.0: runtime hook fields (A2 + A5). Optional so older extensions
    // that pre-date these fields still load.
    allowed_tools?: string[] | null;
    forbidden_bash_patterns?: string[];
}

export interface DumpBindingsResult {
    role_groups: string[];
    bindings: Record<string, BindingPayload>;
    loadError?: string;
}

export interface DumpBindingsOptions {
    /** Explicit profile path. Default = findProfile(cwd). */
    profile?: string | null;
    /** Framework root (where role-packs/, registry/, scripts/ live). */
    frameworkRoot?: string;
    /** Working directory used by findProfile when profile is omitted. */
    cwd?: string;
}

function bindingPayload(
    role: string,
    binding: Profile["bindings"][string],
    rolePack: ReturnType<typeof availableRoles>[string] | undefined,
): BindingPayload {
    const requires = rolePack !== undefined
        ? { ...(rolePack.requires ?? {}) }
        : {};
    const preferences = rolePack !== undefined
        ? { ...(rolePack.preferences ?? {}) }
        : {};
    const out: BindingPayload = {
        alias: binding.alias,
        channels: [...binding.channels],
        fallback_chain: [...(binding.fallback_chain ?? [])],
        requires,
        preferences,
    };
    // v0.6.0: surface runtime-hook fields when the role-pack declares
    // them. The extension's tool_call hook reads allowed_tools /
    // forbidden_bash_patterns to enforce narrowing at dispatch time.
    if (rolePack !== undefined) {
        out.allowed_tools = rolePack.allowed_tools ?? null;
        out.forbidden_bash_patterns = [...(rolePack.forbidden_bash_patterns ?? [])];
    }
    return out;
}

function defaultFrameworkRoot(profilePath: string): string {
    // Mirror Python: profile_path.parent.parent.parent. The extension
    // always passes --framework-root explicitly, so this fallback rarely
    // fires; it preserves the original behaviour for ad-hoc invocations.
    return path.resolve(path.dirname(profilePath), "..", "..", "..");
}

/**
 * Load the profile at `opts.profile` (or the first one findProfile(cwd)
 * surfaces) and emit the `{role_groups, bindings}` snapshot the extension
 * consumes. Returns `{role_groups: [], bindings: {}}` when no profile is
 * found, or `{role_groups: [], bindings: {}, loadError: "..."}` when
 * the load fails — both shapes the extension already handles.
 */
export function dumpBindings(opts: DumpBindingsOptions = {}): DumpBindingsResult {
    const cwd = opts.cwd ?? process.cwd();
    const profilePath = opts.profile !== undefined
        ? opts.profile
        : findProfile(cwd);

    if (profilePath === null || profilePath === undefined) {
        return { role_groups: [], bindings: {} };
    }

    let profile: Profile;
    try {
        profile = loadProfile(profilePath, opts.frameworkRoot);
    } catch (e) {
        // js-yaml is bundled, so ImportError is no longer a runtime concern.
        // ProfileError covers YAML schema violations; anything else is a
        // genuine bug — either way the extension must fall back to set mode.
        const msg = e instanceof Error ? e.message : String(e);
        return {
            role_groups: [],
            bindings: {},
            loadError: `load_profile failed: ${msg}`,
        };
    }

    const root = opts.frameworkRoot ?? defaultFrameworkRoot(profilePath);
    const packs = availableRoles(root, profile.workflow.role_groups);

    const bindings: Record<string, BindingPayload> = {};
    for (const [role, binding] of Object.entries(profile.bindings)) {
        bindings[role] = bindingPayload(role, binding, packs[role]);
    }

    return {
        role_groups: [...profile.workflow.role_groups],
        bindings,
    };
}

/**
 * v0.7.0: legacy-name rewrite shim removed. `LEGACY_ROLE_ALIASES` no
 * longer exists; profiles declaring v0.6.0-era role names fail at
 * load time via `parseBindings` + `LEGACY_ROLE_REDIRECTS` with a clear
 * migration error pointing to the new role name (or "removed entirely"
 * for `coding-orchestrator`). The runtime dispatcher
 * (src/extension.ts) uses the same redirect table to surface the same
 * error when an `@coding-implementer` at-handle reaches the extension.
 *
 * CLI wrapper — emit JSON to stdout, exit code to the OS. Kept so that
 * any out-of-band scripts that used to shell out to `dump_bindings.py`
 * can be rewritten to call `node dist/dump_bindings.js` instead.
 *
 * Usage: node dist/dump_bindings.js [--framework-root <path>] [--cwd <path>] [--profile <path>]
 */
export function main(argv: string[]): number {
    const args: DumpBindingsOptions = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--framework-root") {
            args.frameworkRoot = argv[++i];
        } else if (a === "--cwd") {
            args.cwd = argv[++i];
        } else if (a === "--profile") {
            args.profile = argv[++i] ?? null;
        }
    }
    const result = dumpBindings(args);
    if (result.loadError) {
        process.stdout.write(JSON.stringify({ error: result.loadError }) + "\n");
        return 2;
    }
    process.stdout.write(JSON.stringify({
        role_groups: result.role_groups,
        bindings: result.bindings,
    }) + "\n");
    return 0;
}

// CLI entrypoint: run only when this file is the process entry point.
const isMain = (() => {
    try {
        // import.meta.url under ESM. Compare paths case-insensitively on
        // Windows; node:path handles separator differences.
        const entry = process.argv[1];
        if (!entry) return false;
        const here = path.resolve(path.dirname(new URL(import.meta.url).pathname));
        const there = path.resolve(path.dirname(entry));
        return here === there;
    } catch {
        return false;
    }
})();

if (isMain) {
    process.exit(main(process.argv.slice(2)));
}