/**
 * tests/unit/test_profile_loader.ts
 *
 * Cross-implementation equivalence tests for src/profile_loader.ts.
 * Mirrors tests/unit/test_profile_loader.py — every case that the Python
 * suite covers must also pass here. If a Python test breaks after a TS
 * port change, we update both files in the same commit to keep the two
 * implementations aligned.
 *
 * Run with: npx tsx --test tests/unit/test_profile_loader.ts
 */
import { test as testApi } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
    loadProfile,
    parseProfile,
    findProfile,
    discoverRolePacks,
    availableRoles,
    loadRegistry,
    ProfileError,
    LEGACY_CORE_ROLES,
    DEFAULT_TRIGGERS,
    DEFAULT_FRAMEWORK_VERSION,
    type Profile,
    type RoleDef,
} from "../../src/profile_loader.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers (mirror tests/unit/test_profile_loader.py fixture style)
// ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function writeProfile(dir: string, content: string): string {
    // Python's textwrap.dedent strips the *common* leading whitespace from
    // every line, preserving relative indentation. Replicate that here.
    const lines = content.split("\n");
    let minIndent = Infinity;
    for (const line of lines) {
        if (line.trim() === "") continue;
        const indent = line.match(/^\s*/)![0]!.length;
        if (indent < minIndent) minIndent = indent;
    }
    if (minIndent === Infinity) minIndent = 0;
    const dedented = lines.map((l) => l.slice(minIndent)).join("\n");
    const p = path.join(dir, ".pi", "rolecast.yaml");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, dedented.replace(/^\n/, "").replace(/\n$/, "") + "\n");
    return p;
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "profile-loader-ts-"));
}

// ─────────────────────────────────────────────────────────────────────
// Top-level profile parsing
// ─────────────────────────────────────────────────────────────────────

testApi("minimal profile loads", () => {
    const tmp = makeTempDir();
    try {
        const p = writeProfile(tmp, `
            framework_version: 0.2.0
            name: test
            description: minimal
            workflow:
              role_groups: [coding]
        `);
        const profile = loadProfile(p, PROJECT_ROOT);
        assert.equal(profile.framework_version, "0.2.0");
        assert.equal(profile.name, "test");
        assert.equal(profile.description, "minimal");
        assert.deepEqual(profile.workflow.role_groups, ["coding"]);
        assert.equal(profile.bindings["coding-architect"]?.alias, undefined);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("missing framework_version rejected", () => {
    const tmp = makeTempDir();
    try {
        const p = writeProfile(tmp, `
            name: t
            description: d
            workflow:
              role_groups: [coding]
        `);
        assert.throws(() => loadProfile(p, PROJECT_ROOT), ProfileError);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("missing name rejected", () => {
    const tmp = makeTempDir();
    try {
        const p = writeProfile(tmp, `
            framework_version: 0.2.0
            description: d
            workflow:
              role_groups: [coding]
        `);
        assert.throws(() => loadProfile(p, PROJECT_ROOT), ProfileError);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("missing description rejected", () => {
    const tmp = makeTempDir();
    try {
        const p = writeProfile(tmp, `
            framework_version: 0.2.0
            name: t
            workflow:
              role_groups: [coding]
        `);
        assert.throws(() => loadProfile(p, PROJECT_ROOT), ProfileError);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("non-mapping root rejected", () => {
    const tmp = makeTempDir();
    try {
        const p = writeProfile(tmp, `
            - a
            - b
        `);
        assert.throws(() => loadProfile(p, PROJECT_ROOT), ProfileError);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// findProfile + legacy filename
// ─────────────────────────────────────────────────────────────────────

testApi("findProfile prefers rolecast.yaml over legacy", () => {
    const tmp = makeTempDir();
    try {
        fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".pi", "agent-workflow.yaml"), "old: 1\n");
        fs.writeFileSync(path.join(tmp, ".pi", "rolecast.yaml"), "new: 1\n");
        const found = findProfile(tmp);
        assert.equal(found, path.join(tmp, ".pi", "rolecast.yaml"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("findProfile falls back to legacy agent-workflow.yaml", () => {
    const tmp = makeTempDir();
    try {
        fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".pi", "agent-workflow.yaml"), "old: 1\n");
        const found = findProfile(tmp);
        assert.equal(found, path.join(tmp, ".pi", "agent-workflow.yaml"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("findProfile returns null when no profile exists", () => {
    const tmp = makeTempDir();
    try {
        const found = findProfile(tmp);
        assert.equal(found, null);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// Role pack discovery
// ─────────────────────────────────────────────────────────────────────

testApi("discoverRolePacks finds coding group from real role-packs/", () => {
    const packs = discoverRolePacks(PROJECT_ROOT);
    assert.ok("coding" in packs, "coding group must be discoverable");
    const roles = packs["coding"]!;
    const names = roles.map((r) => r.full_name).sort();
    // Spot-check: the 11 standard coding roles are present.
    for (const expected of [
        "coding-architect", "coding-planner", "coding-implementer",
        "coding-tester", "coding-reviewer", "coding-mapper",
        "coding-profiler", "coding-auditor", "coding-canary",
        "coding-docs", "coding-orchestrator",
    ]) {
        assert.ok(names.includes(expected), `missing role: ${expected}`);
    }
});

testApi("availableRoles respects role_groups filter", () => {
    const roles = availableRoles(PROJECT_ROOT, ["coding"]);
    // All returned roles should belong to the coding group
    for (const r of Object.values(roles)) {
        assert.equal(r.group, "coding");
    }
});

testApi("availableRoles with no groups returns all", () => {
    const roles = availableRoles(PROJECT_ROOT);
    const groups = new Set(Object.values(roles).map((r) => r.group));
    assert.ok(groups.size >= 1);
});

// ─────────────────────────────────────────────────────────────────────
// Workflow parsing
// ─────────────────────────────────────────────────────────────────────

testApi("workflow.role_groups must be a list", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: "coding" },
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("workflow.role_groups entries must be strings", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: [123] },
        }, PROJECT_ROOT),
    ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// Custom roles
// ─────────────────────────────────────────────────────────────────────

testApi("custom_roles: missing required fields rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: [] },
            custom_roles: [{ name: "r1", description: "d" }],
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("custom_roles: duplicate names rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: [] },
            custom_roles: [
                { name: "r1", description: "d", agent_file: "a.md",
                  default_alias: "x", default_channels: ["c"] },
                { name: "r1", description: "d", agent_file: "a.md",
                  default_alias: "x", default_channels: ["c"] },
            ],
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("custom_roles: empty default_channels rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: [] },
            custom_roles: [
                { name: "r1", description: "d", agent_file: "a.md",
                  default_alias: "x", default_channels: [] },
            ],
        }, PROJECT_ROOT),
    ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// Bindings
// ─────────────────────────────────────────────────────────────────────

testApi("bindings: unknown role rejected with legacy hint", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: [DEFAULT_FRAMEWORK_VERSION === "0.2.0" ? "coding" : ""] },
            bindings: {
                architect: { alias: "x", channels: ["c"] },
            },
        }, PROJECT_ROOT),
    (e: Error) => {
        assert.match(e.message, /legacy coding role name/);
        return true;
    });
});

testApi("bindings: alias required", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            bindings: {
                "coding-architect": { channels: ["c"] },
            },
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("bindings: channels must be non-empty list", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            bindings: {
                "coding-architect": { alias: "x", channels: [] },
            },
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("bindings: happy path with coding roles", () => {
    const profile = parseProfile({
        framework_version: "0.2.0",
        name: "x",
        description: "y",
        workflow: { role_groups: ["coding"] },
        bindings: {
            "coding-architect": {
                alias: "opus-thinking-medium",
                channels: ["official"],
            },
        },
    }, PROJECT_ROOT);
    const b = profile.bindings["coding-architect"]!;
    assert.equal(b.alias, "opus-thinking-medium");
    assert.deepEqual(b.channels, ["official"]);
    assert.equal(b.role_group, "coding");
    assert.equal(b.role_name, "architect");
});

// ─────────────────────────────────────────────────────────────────────
// Non-negotiables
// ─────────────────────────────────────────────────────────────────────

testApi("non_negotiables: forbidden_patterns compile and validate", () => {
    const profile = parseProfile({
        framework_version: "0.2.0",
        name: "x",
        description: "y",
        workflow: { role_groups: ["coding"] },
        non_negotiables: {
            forbidden_patterns: [
                { pattern: "unsafe_", message: "no unsafe_ prefix" },
            ],
            required_gates: ["test"],
        },
    }, PROJECT_ROOT);
    assert.equal(profile.non_negotiables.forbidden_patterns.length, 1);
    assert.equal(profile.non_negotiables.forbidden_patterns[0]!.message, "no unsafe_ prefix");
    assert.deepEqual(profile.non_negotiables.required_gates, ["test"]);
});

testApi("non_negotiables: invalid regex rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            non_negotiables: {
                forbidden_patterns: [
                    { pattern: "[unclosed", message: "bad" },
                ],
            },
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("non_negotiables: missing pattern/message fields rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            non_negotiables: {
                forbidden_patterns: [{ pattern: "x" }],
            },
        }, PROJECT_ROOT),
    ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// Escalation
// ─────────────────────────────────────────────────────────────────────

testApi("escalation: defaults applied", () => {
    const profile = parseProfile({
        framework_version: "0.2.0",
        name: "x",
        description: "y",
        workflow: { role_groups: ["coding"] },
    }, PROJECT_ROOT);
    assert.equal(profile.escalation.max_attempts, 2);
    assert.equal(profile.escalation.on_permanent_failure, "stop");
    assert.equal(profile.escalation.preserve_logs, true);
});

testApi("escalation: invalid on_permanent_failure rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            escalation: { on_permanent_failure: "halt" },
        }, PROJECT_ROOT),
    ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// Trigger collision
// ─────────────────────────────────────────────────────────────────────

testApi("trigger collision: trigger_overrides targeting unknown role rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            trigger_overrides: {
                "design": { role: "nonexistent-role" },
            },
        }, PROJECT_ROOT),
    ProfileError);
});

testApi("trigger collision: trigger_overrides without role key rejected", () => {
    assert.throws(() =>
        parseProfile({
            framework_version: "0.2.0",
            name: "x",
            description: "y",
            workflow: { role_groups: ["coding"] },
            trigger_overrides: {
                "design": { something: "coding-architect" },
            },
        }, PROJECT_ROOT),
    ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────

testApi("loadRegistry returns merged built-in models + aliases", () => {
    const reg = loadRegistry(PROJECT_ROOT);
    // Spot-check a few well-known built-in models
    assert.ok(reg.hasModel("claude-opus-5-5"));
    assert.ok(reg.hasModel("gpt-6.1-sol"));
    assert.ok(reg.hasModel("deepseek-v4.1-flash"));
    // Spot-check a few aliases
    assert.throws(() => reg.resolveAlias("nonexistent-alias"), ProfileError);
    const opus = reg.resolveAlias("opus-thinking-medium");
    assert.equal(opus.model_id, "claude-opus-5-5");
    assert.equal(opus.trust, "trusted");
});

testApi("Registry.resolveAlias: unknown alias throws", () => {
    const reg = loadRegistry(PROJECT_ROOT);
    assert.throws(() => reg.resolveAlias("not-a-real-alias"), ProfileError);
});

testApi("Registry.resolveAlias: deprecated model surfaces warning", () => {
    // Build a synthetic framework root with a deprecated model + alias,
    // mirroring the Python test_profile_loader.py pattern.
    const tmp = makeTempDir();
    try {
        const fwRoot = path.join(tmp, "fw");
        fs.mkdirSync(path.join(fwRoot, "registry"), { recursive: true });
        fs.writeFileSync(path.join(fwRoot, "registry", "built_in.yaml"),
            "models:\n  - id: old-model\n    vendor: v\n    capabilities: {}\n    channels: [{id: official, trust: trusted}]\n    status: deprecated\n");
        fs.writeFileSync(path.join(fwRoot, "registry", "aliases.yaml"),
            "aliases:\n  old-alias:\n    preferred: old-model\n    fallback_chain: []\n");
        const reg = loadRegistry(fwRoot);
        const res = reg.resolveAlias("old-alias");
        assert.ok(res.warning, "deprecated alias must surface warning");
        assert.match(res.warning!, /deprecated/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("Registry.resolveAlias: withdrawn model throws", () => {
    const tmp = makeTempDir();
    try {
        const fwRoot = path.join(tmp, "fw");
        fs.mkdirSync(path.join(fwRoot, "registry"), { recursive: true });
        fs.writeFileSync(path.join(fwRoot, "registry", "built_in.yaml"),
            "models:\n  - id: gone-model\n    vendor: v\n    capabilities: {}\n    channels: [{id: official, trust: trusted}]\n    status: withdrawn\n");
        fs.writeFileSync(path.join(fwRoot, "registry", "aliases.yaml"),
            "aliases:\n  gone-alias:\n    preferred: gone-model\n    fallback_chain: []\n");
        const reg = loadRegistry(fwRoot);
        assert.throws(() => reg.resolveAlias("gone-alias"), /withdrawn/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testApi("Registry.getModel: unknown model throws", () => {
    const reg = loadRegistry(PROJECT_ROOT);
    assert.throws(() => reg.getModel("no-such-model"), ProfileError);
});

// ─────────────────────────────────────────────────────────────────────
// End-to-end: real project profile loads + binding resolution
// ─────────────────────────────────────────────────────────────────────

testApi("real project fixture (minimal) loads end-to-end", () => {
    const fixtureDir = path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust");
    if (!fs.existsSync(fixtureDir)) {
        // Fixture absent in this checkout — skip silently
        return;
    }
    const found = findProfile(fixtureDir);
    if (!found) return;
    const profile = loadProfile(found, PROJECT_ROOT);
    assert.ok(profile.bindings["coding-architect"]);
    const resolved = profile.resolved_bindings["coding-architect"];
    assert.ok(resolved);
    assert.ok(resolved.model_id);
    assert.ok(resolved.channel_id);
});

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

testApi("LEGACY_CORE_ROLES contains the 11 legacy role names", () => {
    const expected = [
        "orchestrator", "architect", "planner", "implementer", "tester",
        "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
    ];
    for (const name of expected) {
        assert.ok(LEGACY_CORE_ROLES.has(name), `missing legacy role: ${name}`);
    }
});

testApi("DEFAULT_TRIGGERS covers 10 coding roles (orchestrator excluded)", () => {
    const keys = Object.keys(DEFAULT_TRIGGERS);
    assert.equal(keys.length, 10);
    assert.ok(!("coding-orchestrator" in DEFAULT_TRIGGERS));
});

testApi("DEFAULT_FRAMEWORK_VERSION is 0.2.0", () => {
    assert.equal(DEFAULT_FRAMEWORK_VERSION, "0.2.0");
});