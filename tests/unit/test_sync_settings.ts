/**
 * tests/unit/test_sync_settings.ts
 *
 * Tests for src/sync_settings.ts (v0.5.0: TypeScript port of
 * scripts/sync_settings.py).
 *
 * Run with: npx tsx --test tests/unit/test_sync_settings.ts
 */
import { test as testApi } from "node:test";
import assertLib from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
    clearAgents,
    clearSettings,
    clearSync,
    DEFAULT_SETTINGS_PATH,
    mergeAndWriteSettings,
    providerForModel,
    readSettings,
    setFrontmatterField,
    showStatus,
    syncSettings,
    tryLoadRegistry,
    writeAgents,
    writeSettings,
} from "../../src/sync_settings.js";

import { discoverRolePacks } from "../../src/profile_loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FRAMEWORK_ROOT = PROJECT_ROOT;

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rolecast-sync-"));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

const test = testApi;

// ─────────────────────────────────────────────────────────────────────
// providerForModel
// ─────────────────────────────────────────────────────────────────────

test("providerForModel: null registry returns empty string", () => {
    assertLib.equal(providerForModel("anything", null), "");
});

test("providerForModel: maps vendor to pi provider", () => {
    const registry = tryLoadRegistry(FRAMEWORK_ROOT);
    if (registry === null) return;
    // minimax-m3 has vendor=minimax → provider=minimax-cn
    assertLib.equal(providerForModel("minimax-m3", registry), "minimax-cn");
    // deepseek-v4.1-flash → deepseek
    assertLib.equal(providerForModel("deepseek-v4.1-flash", registry), "deepseek");
    // gpt-6.1-sol → openai-codex
    assertLib.equal(providerForModel("gpt-6.1-sol", registry), "openai-codex");
});

test("providerForModel: unknown model returns empty string", () => {
    const registry = tryLoadRegistry(FRAMEWORK_ROOT);
    if (registry === null) return;
    assertLib.equal(providerForModel("nonexistent-model", registry), "");
});

// ─────────────────────────────────────────────────────────────────────
// setFrontmatterField
// ─────────────────────────────────────────────────────────────────────

test("setFrontmatterField: replaces existing field", () => {
    const body = [
        "---",
        "name: coder",
        "model: old-model",
        "description: foo",
        "---",
        "",
        "# Body",
    ].join("\n");
    const out = setFrontmatterField(body, "model", "new-model");
    assertLib.match(out, /^model: new-model$/m);
    assertLib.doesNotMatch(out, /^model: old-model$/m);
});

test("setFrontmatterField: inserts missing field", () => {
    const body = ["---", "name: coder", "description: foo", "---", "", "x"].join("\n");
    const out = setFrontmatterField(body, "model", "new-model");
    assertLib.match(out, /^model: new-model$/m);
    assertLib.match(out, /^name: coder$/m);
});

test("setFrontmatterField: prepends frontmatter if missing", () => {
    const body = "# Just a body\nno frontmatter here";
    const out = setFrontmatterField(body, "model", "x-model");
    assertLib.match(out, /^---\nmodel: x-model\n---\n/);
});

// ─────────────────────────────────────────────────────────────────────
// readSettings / writeSettings
// ─────────────────────────────────────────────────────────────────────

test("readSettings: returns {} for missing file", () => {
    const tmp = makeTempDir();
    try {
        assertLib.deepEqual(readSettings(path.join(tmp, "missing.json")), {});
    } finally {
        cleanup(tmp);
    }
});

test("readSettings: returns {} for empty file", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        fs.writeFileSync(p, "");
        assertLib.deepEqual(readSettings(p), {});
    } finally {
        cleanup(tmp);
    }
});

test("readSettings: returns {} for malformed JSON", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        fs.writeFileSync(p, "{not json");
        assertLib.deepEqual(readSettings(p), {});
    } finally {
        cleanup(tmp);
    }
});

test("writeSettings: writes JSON", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        writeSettings(p, { foo: 1 }, false, "test");
        assertLib.equal(fs.existsSync(p), true);
        const got = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        assertLib.deepEqual(got, { foo: 1 });
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// mergeAndWriteSettings
// ─────────────────────────────────────────────────────────────────────

test("mergeAndWriteSettings: merges new overrides with existing", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        fs.writeFileSync(p, JSON.stringify({
            subagents: { agentOverrides: { existing: { model: "old-model", channel: "official" } } },
        }));
        mergeAndWriteSettings(p, { fresh: { model: "new-model", channel: "official" } }, false);
        const got = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        const sub = got["subagents"] as Record<string, unknown>;
        const overrides = sub["agentOverrides"] as Record<string, { model: string; channel: string }>;
        assertLib.equal(overrides["existing"]!.model, "old-model");
        assertLib.equal(overrides["fresh"]!.model, "new-model");
    } finally {
        cleanup(tmp);
    }
});

test("mergeAndWriteSettings: overwrites existing role with new value", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        fs.writeFileSync(p, JSON.stringify({
            subagents: { agentOverrides: { "coding-architect": { model: "old", channel: "official" } } },
        }));
        mergeAndWriteSettings(p, { "coding-architect": { model: "new", channel: "official" } }, false);
        const got = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        const sub = got["subagents"] as Record<string, unknown>;
        const overrides = sub["agentOverrides"] as Record<string, { model: string }>;
        assertLib.equal(overrides["coding-architect"]!.model, "new");
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// clearSettings
// ─────────────────────────────────────────────────────────────────────

test("clearSettings: removes all agentOverrides", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "settings.json");
        fs.writeFileSync(p, JSON.stringify({
            subagents: { agentOverrides: { a: { model: "x", channel: "y" }, b: { model: "z", channel: "y" } } },
        }));
        clearSettings(p, false);
        const got = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        const sub = got["subagents"] as Record<string, unknown>;
        const overrides = sub["agentOverrides"] as Record<string, unknown>;
        assertLib.deepEqual(Object.keys(overrides).sort(), []);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// writeAgents / clearAgents
// ─────────────────────────────────────────────────────────────────────

test("writeAgents: writes .md files with updated frontmatter", () => {
    const tmp = makeTempDir();
    try {
        const agentsDir = path.join(tmp, "agents");
        const result = writeAgents({
            agentsDir,
            frameworkRoot: FRAMEWORK_ROOT,
            enabledGroups: ["coding"],
            overrides: { "coding-planner": { model: "deepseek-v4.1-flash", channel: "official" } },
            dryRun: false,
            registry: tryLoadRegistry(FRAMEWORK_ROOT),
        });
        assertLib.equal(result.written, 1);
        const f = path.join(agentsDir, "coding-planner.md");
        assertLib.equal(fs.existsSync(f), true);
        const body = fs.readFileSync(f, "utf8");
        assertLib.match(body, /^model: deepseek\/deepseek-v4\.1-flash$/m);
        assertLib.doesNotMatch(body, /^model: MiniMax/m);
    } finally {
        cleanup(tmp);
    }
});

test("writeAgents: dry-run writes nothing", () => {
    const tmp = makeTempDir();
    try {
        const agentsDir = path.join(tmp, "agents");
        const result = writeAgents({
            agentsDir,
            frameworkRoot: FRAMEWORK_ROOT,
            enabledGroups: ["coding"],
            overrides: { "coding-planner": { model: "deepseek-v4.1-flash", channel: "official" } },
            dryRun: true,
            registry: tryLoadRegistry(FRAMEWORK_ROOT),
        });
        assertLib.equal(result.written, 0);
        assertLib.equal(fs.existsSync(agentsDir), false);
    } finally {
        cleanup(tmp);
    }
});

test("writeAgents: dry-run emits missing-soul warning without writing", () => {
    // v0.9.0 (T1.5): dry-run must walk the soul-preload code path so a
    // broken `soul:` path surfaces as a warning, even when no file is
    // written. Set up a tmp framework root with a role-pack that points
    // at a non-existent soul, override the role, and assert that:
    //   (a) the missing-soul warning is emitted on stderr
    //   (b) result.written === 0
    //   (c) nothing is written to agentsDir (no fs.writeFileSync side effect)
    const tmp = makeTempDir();
    try {
        const codingDir = path.join(tmp, "role-packs", "coding");
        fs.mkdirSync(codingDir, { recursive: true });
        const rolePath = path.join(codingDir, "coding-broken-soul.md");
        fs.writeFileSync(rolePath, [
            "---",
            "name: coding-broken-soul",
            "soul: ../../souls/does-not-exist.md",
            "---",
            "",
            "# body",
        ].join("\n"));

        const agentsDir = path.join(tmp, "agents");

        // Capture process.stderr.write while writeAgents runs.
        const origWrite = process.stderr.write.bind(process.stderr);
        let captured = "";
        (process.stderr as { write: typeof process.stderr.write }).write = ((
            chunk: string | Uint8Array,
            ...rest: unknown[]
        ) => {
            captured += typeof chunk === "string" ? chunk : chunk.toString();
            return origWrite(chunk as string, ...(rest as []));
        }) as typeof process.stderr.write;

        let result: ReturnType<typeof writeAgents>;
        try {
            result = writeAgents({
                agentsDir,
                frameworkRoot: tmp,
                enabledGroups: ["coding"],
                overrides: {
                    "coding-broken-soul": { model: "deepseek-v4.1-flash", channel: "official" },
                },
                dryRun: true,
                registry: tryLoadRegistry(FRAMEWORK_ROOT),
            });
        } finally {
            (process.stderr as { write: typeof process.stderr.write }).write = origWrite;
        }

        // (a) warning surfaces in dry-run
        assertLib.match(
            captured,
            /warning: role 'coding-broken-soul' declares soul '..\/..\/souls\/does-not-exist\.md' but the file is missing/,
        );
        // (b) no write counter increment
        assertLib.equal(result.written, 0);
        // (c) agentsDir was never created, no .md was emitted
        assertLib.equal(fs.existsSync(agentsDir), false);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// v0.9.0 (A4) — souls_extra frontmatter
// ─────────────────────────────────────────────────────────────────────

test("discoverRolePacks: parses souls_extra from frontmatter", () => {
    // Set up a tmp framework root with a role-pack that declares both
    // `soul:` (primary) and `souls_extra:` (additional). After
    // discovery, the role's `souls_extra` field MUST equal the declared
    // list, in order. Missing/non-array → [].
    const tmp = makeTempDir();
    try {
        const codingDir = path.join(tmp, "role-packs", "coding");
        fs.mkdirSync(codingDir, { recursive: true });
        fs.writeFileSync(
            path.join(codingDir, "coding-extra-soul.md"),
            [
                "---",
                "name: coding-extra-soul",
                "soul: ../../souls/primary-law.md",
                "souls_extra:",
                "  - ../../souls/secondary-law.md",
                "  - ../../souls/tertiary-law.md",
                "---",
                "",
                "# body",
            ].join("\n"),
        );

        const packs = discoverRolePacks(tmp);
        const coding = packs["coding"]!;
        const role = coding.find((r) => r.full_name === "coding-extra-soul");
        assertLib.ok(role !== undefined, "role must be discoverable");
        assertLib.deepEqual(role!.souls_extra, [
            "../../souls/secondary-law.md",
            "../../souls/tertiary-law.md",
        ]);
        assertLib.equal(role!.soul_path, "../../souls/primary-law.md");
    } finally {
        cleanup(tmp);
    }
});

test("discoverRolePacks: missing souls_extra defaults to empty array", () => {
    // Backward-compat: roles that pre-date v0.9.0 do NOT declare
    // souls_extra at all; the field MUST default to [] (not undefined)
    // so sync_role_file can iterate without a guard.
    const tmp = makeTempDir();
    try {
        const codingDir = path.join(tmp, "role-packs", "coding");
        fs.mkdirSync(codingDir, { recursive: true });
        fs.writeFileSync(
            path.join(codingDir, "coding-no-extra.md"),
            [
                "---",
                "name: coding-no-extra",
                "soul: ../../souls/primary-law.md",
                "---",
                "",
                "# body",
            ].join("\n"),
        );

        const packs = discoverRolePacks(tmp);
        const role = packs["coding"]!.find((r) => r.full_name === "coding-no-extra")!;
        assertLib.deepEqual(role.souls_extra, []);
    } finally {
        cleanup(tmp);
    }
});

test("writeAgents: primary soul prepended before souls_extra entries", () => {
    // v0.9.0 (A4) order matters: the most generic law MUST come first
    // because the role's interpretation of a specific law depends on
    // the generic constraints being established. Set up a role with
    // soul=primary (audit-law style) and souls_extra=[secondary,
    // tertiary]; assert that PRIMARY content appears BEFORE SECONDARY
    // BEFORE TERTIARY BEFORE the role body in the generated agent
    // file.
    const tmp = makeTempDir();
    try {
        // souls/ sits at the tmp root so ../../souls/<name>.md resolves
        // correctly from role-packs/coding/<role>.md.
            const soulsDir = path.join(tmp, "souls");
            fs.mkdirSync(soulsDir, { recursive: true });
            fs.writeFileSync(
                path.join(soulsDir, "primary-law.md"),
                "## Primary Law\n\nGENERIC-LAW-MARKER-AAA\n",
            );
            fs.writeFileSync(
                path.join(soulsDir, "secondary-law.md"),
                "## Secondary Law\n\nROLE-SPECIFIC-MARKER-BBB\n",
            );
            fs.writeFileSync(
                path.join(soulsDir, "tertiary-law.md"),
                "## Tertiary Law\n\nEXTRA-MARKER-CCC\n",
            );

        const codingDir = path.join(tmp, "role-packs", "coding");
        fs.mkdirSync(codingDir, { recursive: true });
        fs.writeFileSync(
            path.join(codingDir, "coding-multi-law.md"),
            [
                "---",
                "name: coding-multi-law",
                "soul: ../../souls/primary-law.md",
                "souls_extra:",
                "  - ../../souls/secondary-law.md",
                "  - ../../souls/tertiary-law.md",
                "---",
                "",
                "# Role Body",
                "",
                "ROLE-BODY-MARKER-ZZZ",
            ].join("\n"),
        );

        const agentsDir = path.join(tmp, "agents");
        writeAgents({
            agentsDir,
            frameworkRoot: tmp,
            enabledGroups: ["coding"],
            overrides: {
                "coding-multi-law": { model: "deepseek-v4.1-flash", channel: "official" },
            },
            dryRun: false,
            registry: tryLoadRegistry(FRAMEWORK_ROOT),
        });

        const out = fs.readFileSync(path.join(agentsDir, "coding-multi-law.md"), "utf8");
        const idxPrimary   = out.indexOf("GENERIC-LAW-MARKER-AAA");
        const idxSecondary = out.indexOf("ROLE-SPECIFIC-MARKER-BBB");
        const idxTertiary  = out.indexOf("EXTRA-MARKER-CCC");
        const idxBody      = out.indexOf("ROLE-BODY-MARKER-ZZZ");

        // All four markers must be present.
        assertLib.ok(idxPrimary >= 0, "primary soul content must be present");
        assertLib.ok(idxSecondary >= 0, "secondary soul content must be present");
        assertLib.ok(idxTertiary >= 0, "tertiary soul content must be present");
        assertLib.ok(idxBody >= 0, "role body must be present");

        // Order: primary < secondary < tertiary < body.
        assertLib.ok(
            idxPrimary < idxSecondary,
            `primary (${idxPrimary}) must precede secondary (${idxSecondary})`,
        );
        assertLib.ok(
            idxSecondary < idxTertiary,
            `secondary (${idxSecondary}) must precede tertiary (${idxTertiary})`,
        );
        assertLib.ok(
            idxTertiary < idxBody,
            `tertiary (${idxTertiary}) must precede role body (${idxBody})`,
        );
    } finally {
        cleanup(tmp);
    }
});

test("writeAgents: missing souls_extra entry emits warning, does not throw", () => {
    // Mirror the T1.5 dry-run test for the primary `soul:` path, but
    // for the souls_extra list. A bad entry must surface a warning,
    // other valid entries must still be prepended, and the role must
    // still be written.
    const tmp = makeTempDir();
    try {
        const soulsDir = path.join(tmp, "souls");
        fs.mkdirSync(soulsDir, { recursive: true });
        fs.writeFileSync(path.join(soulsDir, "primary-law.md"), "## Primary\n\nOK-MARKER\n");
        // Intentionally do NOT create secondary-law.md.

        const codingDir = path.join(tmp, "role-packs", "coding");
        fs.mkdirSync(codingDir, { recursive: true });
        fs.writeFileSync(
            path.join(codingDir, "coding-broken-extra.md"),
            [
                "---",
                "name: coding-broken-extra",
                "soul: ../../souls/primary-law.md",
                "souls_extra:",
                "  - ../../souls/secondary-law.md",
                "---",
                "",
                "# body",
            ].join("\n"),
        );

        const agentsDir = path.join(tmp, "agents");

        const origWrite = process.stderr.write.bind(process.stderr);
        let captured = "";
        (process.stderr as { write: typeof process.stderr.write }).write = ((
            chunk: string | Uint8Array,
            ...rest: unknown[]
        ) => {
            captured += typeof chunk === "string" ? chunk : chunk.toString();
            return origWrite(chunk as string, ...(rest as []));
        }) as typeof process.stderr.write;

        let result: ReturnType<typeof writeAgents>;
        try {
            result = writeAgents({
                agentsDir,
                frameworkRoot: tmp,
                enabledGroups: ["coding"],
                overrides: {
                    "coding-broken-extra": { model: "deepseek-v4.1-flash", channel: "official" },
                },
                dryRun: false,
                registry: tryLoadRegistry(FRAMEWORK_ROOT),
            });
        } finally {
            (process.stderr as { write: typeof process.stderr.write }).write = origWrite;
        }

        assertLib.match(
            captured,
            /warning: role 'coding-broken-extra' declares souls_extra '..\/..\/souls\/secondary-law\.md' but the file is missing/,
        );
        assertLib.equal(result.written, 1);
        // The role must still be written; primary soul content present.
        const out = fs.readFileSync(path.join(agentsDir, "coding-broken-extra.md"), "utf8");
        assertLib.match(out, /OK-MARKER/);
    } finally {
        cleanup(tmp);
    }
});

test("clearAgents: removes .md files", () => {
    const tmp = makeTempDir();
    try {
        const agentsDir = path.join(tmp, "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, "coding-planner.md"), "x");
        fs.writeFileSync(path.join(agentsDir, "coding-architect.md"), "y");
        fs.writeFileSync(path.join(agentsDir, "other.txt"), "z");
        clearAgents({ agentsDir, frameworkRoot: FRAMEWORK_ROOT, dryRun: false });
        assertLib.equal(fs.existsSync(path.join(agentsDir, "coding-planner.md")), false);
        assertLib.equal(fs.existsSync(path.join(agentsDir, "coding-architect.md")), false);
        assertLib.equal(fs.existsSync(path.join(agentsDir, "other.txt")), true);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// showStatus
// ─────────────────────────────────────────────────────────────────────

test("showStatus: reports drift when agent file missing", () => {
    const tmp = makeTempDir();
    try {
        const status = showStatus({
            profilePath: "fake",
            settingsPath: path.join(tmp, "missing.json"),
            agentsDir: path.join(tmp, "agents"),
            frameworkRoot: FRAMEWORK_ROOT,
            expectedOverrides: { "coding-planner": { model: "deepseek-v4.1-flash", channel: "official" } },
        });
        assertLib.equal(status.entries.length, 1);
        assertLib.equal(status.entries[0]!.drift, true);
        assertLib.equal(status.entries[0]!.agentFileExists, false);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// syncSettings (end-to-end)
// ─────────────────────────────────────────────────────────────────────

test("syncSettings: writes agent files from real profile", () => {
    const tmp = makeTempDir();
    try {
        // Use the bundled sample-rust fixture as the profile source.
        const profilePath = path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust", ".pi", "rolecast.yaml");
        const r = syncSettings({
            profilePath,
            frameworkRoot: FRAMEWORK_ROOT,
            settingsPath: path.join(tmp, "settings.json"),
            agentsDir: path.join(tmp, "agents"),
            settingsWrite: false,
            noAgents: false,
            dryRun: false,
        });
        assertLib.equal(r.agentsWritten >= 1, true);
        assertLib.equal(r.settingsWritten, undefined);
        assertLib.equal(fs.existsSync(path.join(tmp, "agents", "coding-planner.md")), true);
        const body = fs.readFileSync(path.join(tmp, "agents", "coding-planner.md"), "utf8");
        // coding-planner uses deepseek-verifiable → deepseek-v4.1-flash
        assertLib.match(body, /^model: deepseek\/deepseek-v4\.1-flash$/m);
    } finally {
        cleanup(tmp);
    }
});

test("syncSettings: with settingsWrite=true also writes settings.json", () => {
    const tmp = makeTempDir();
    try {
        const profilePath = path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust", ".pi", "rolecast.yaml");
        const settingsPath = path.join(tmp, "settings.json");
        const r = syncSettings({
            profilePath,
            frameworkRoot: FRAMEWORK_ROOT,
            settingsPath,
            agentsDir: path.join(tmp, "agents"),
            settingsWrite: true,
            noAgents: false,
            dryRun: false,
        });
        assertLib.equal(r.settingsWritten, settingsPath);
        assertLib.equal(fs.existsSync(settingsPath), true);
        const got = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        const overrides = ((got["subagents"] as Record<string, unknown>)["agentOverrides"] as Record<string, unknown>);
        assertLib.equal(Object.keys(overrides).length >= 1, true);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// clearSync (end-to-end)
// ─────────────────────────────────────────────────────────────────────

test("clearSync: removes both settings overrides and agents dir", () => {
    const tmp = makeTempDir();
    try {
        const settingsPath = path.join(tmp, "settings.json");
        const agentsDir = path.join(tmp, "agents");
        // Pre-populate both.
        mergeAndWriteSettings(settingsPath, { "x": { model: "y", channel: "official" } }, false);
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, "x.md"), "x");
        // Run clear.
        clearSync({
            settingsPath,
            agentsDir,
            frameworkRoot: FRAMEWORK_ROOT,
            dryRun: false,
        });
        const got = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        const overrides = ((got["subagents"] as Record<string, unknown>)["agentOverrides"] as Record<string, unknown>);
        assertLib.deepEqual(Object.keys(overrides), []);
        assertLib.equal(fs.existsSync(path.join(agentsDir, "x.md")), false);
    } finally {
        cleanup(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

test("DEFAULT_SETTINGS_PATH lives under ~/.pi/agent/settings.json", () => {
    assertLib.match(DEFAULT_SETTINGS_PATH, /[\\/]\.pi[\\/]agent[\\/]settings\.json$/);
});
