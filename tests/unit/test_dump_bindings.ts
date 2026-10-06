/**
 * tests/unit/test_dump_bindings.ts
 *
 * Tests for src/dump_bindings.ts (v0.5.0: TypeScript port of
 * scripts/dump_bindings.py).
 *
 * Run with: npx tsx --test tests/unit/test_dump_bindings.ts
 */
import { test as testApi } from "node:test";
import assertLib from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { dumpBindings } from "../../src/dump_bindings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rolecast-dump-"));
}

function writeProfile(dir: string, content: string): string {
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

const test = testApi;

// ─────────────────────────────────────────────────────────────────────
// Core behaviours
// ─────────────────────────────────────────────────────────────────────

test("dumpBindings: no profile returns empty result, no error", () => {
    const tmp = makeTempDir();
    try {
        const result = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd: tmp });
        assertLib.equal(result.role_groups.length, 0);
        assertLib.deepEqual(result.bindings, {});
        assertLib.equal(result.loadError, undefined);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("dumpBindings: real fixture emits bindings with expected keys", () => {
    const result = dumpBindings({
        frameworkRoot: PROJECT_ROOT,
        cwd: path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust"),
    });
    assertLib.equal(result.loadError, undefined, `unexpected loadError: ${result.loadError}`);
    assertLib.ok(result.role_groups.includes("coding"), "expected 'coding' role group");
    const bindings = Object.keys(result.bindings).sort();
    // The sample fixture binds all 11 legacy coding roles.
    assertLib.ok(bindings.includes("coding-architect"));
    assertLib.ok(bindings.includes("coding-planner"));
    assertLib.ok(bindings.includes("coding-implementer"));
    assertLib.ok(bindings.includes("coding-tester"));
    assertLib.ok(bindings.includes("coding-reviewer"));
    assertLib.ok(bindings.includes("coding-orchestrator"));
});

test("dumpBindings: each binding has alias/channels/fallback_chain/requires/preferences", () => {
    const result = dumpBindings({
        frameworkRoot: PROJECT_ROOT,
        cwd: path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust"),
    });
    for (const [name, binding] of Object.entries(result.bindings)) {
        assertLib.equal(typeof binding.alias, "string", `${name}: missing alias`);
        assertLib.ok(Array.isArray(binding.channels), `${name}: channels not array`);
        assertLib.ok(binding.channels.length > 0, `${name}: channels empty`);
        assertLib.ok(Array.isArray(binding.fallback_chain), `${name}: fallback_chain not array`);
        assertLib.ok(
            typeof binding.requires === "object" && binding.requires !== null,
            `${name}: requires not object`,
        );
        assertLib.ok(
            typeof binding.preferences === "object" && binding.preferences !== null,
            `${name}: preferences not object`,
        );
    }
});

test("dumpBindings: channels match the YAML binding's channels list", () => {
    const result = dumpBindings({
        frameworkRoot: PROJECT_ROOT,
        cwd: path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust"),
    });
    // sample-rust: coding-reviewer has [official, relay-default]
    const reviewer = result.bindings["coding-reviewer"];
    assertLib.ok(reviewer, "coding-reviewer binding missing");
    assertLib.deepEqual(reviewer.channels, ["official", "relay-default"]);
});

test("dumpBindings: malformed YAML returns loadError, no throw", () => {
    const tmp = makeTempDir();
    try {
        writeProfile(tmp, "framework_version: 0.2.0\nbindings:\n  bad: [\nunbalanced");
        const result = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd: tmp });
        assertLib.ok(result.loadError, "expected loadError on malformed YAML");
        assertLib.equal(typeof result.loadError, "string");
        assertLib.ok(result.loadError.length > 0);
        // bindings may be empty or partially populated; either way no throw.
        assertLib.ok(typeof result.bindings === "object");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("dumpBindings: role_groups missing defaults to []", () => {
    const tmp = makeTempDir();
    try {
        writeProfile(tmp, "framework_version: 0.2.0\n");
        const result = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd: tmp });
        assertLib.deepEqual(result.role_groups, []);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("dumpBindings: bindings dict empty when none declared", () => {
    const tmp = makeTempDir();
    try {
        writeProfile(
            tmp,
            "framework_version: 0.2.0\nname: empty-bindings-test\ndescription: empty bindings for smoke test\nworkflow:\n  role_groups: [coding]\n",
        );
        const result = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd: tmp });
        assertLib.deepEqual(result.role_groups, ["coding"]);
        assertLib.deepEqual(result.bindings, {});
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("dumpBindings: framework root with no rolecast.yaml anywhere returns empty", () => {
    const tmp = makeTempDir();
    try {
        // No profile file at all — neither in tmp nor in parents (mkdtemp is
        // under /tmp, no rolecast.yaml there).
        const result = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd: tmp });
        assertLib.equal(result.loadError, undefined);
        assertLib.deepEqual(result.bindings, {});
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// Cross-implementation equivalence: TS output matches Python output
// for the same profile + cwd.
// ─────────────────────────────────────────────────────────────────────

test("dumpBindings: TS output equals Python dump_bindings.py output", () => {
    const cwd = path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust");
    const tsResult = dumpBindings({ frameworkRoot: PROJECT_ROOT, cwd });

    const proc = spawnSync(
        "python3",
        ["scripts/dump_bindings.py", "--framework-root", PROJECT_ROOT, "--cwd", cwd],
        { encoding: "utf8", cwd: PROJECT_ROOT },
    );
    assertLib.equal(proc.status, 0, `python3 dump_bindings.py failed:\n${proc.stderr}`);
    const pyResult = JSON.parse(proc.stdout);

    // Strip fields that may legitimately differ (TS may surface a richer
    // requires/preferences object; PY also surfaces them — assert they
    // match in shape and value).
    assertLib.deepEqual(tsResult.role_groups, pyResult.role_groups);
    assertLib.deepEqual(
        Object.keys(tsResult.bindings).sort(),
        Object.keys(pyResult.bindings).sort(),
    );
    for (const role of Object.keys(tsResult.bindings).sort()) {
        const t = tsResult.bindings[role]!;
        const p = pyResult.bindings[role]!;
        assertLib.equal(t.alias, p.alias, `${role}: alias mismatch`);
        assertLib.deepEqual(t.channels, p.channels, `${role}: channels mismatch`);
        assertLib.deepEqual(t.fallback_chain, p.fallback_chain, `${role}: fallback_chain mismatch`);
        assertLib.deepEqual(t.requires, p.requires, `${role}: requires mismatch`);
        assertLib.deepEqual(t.preferences, p.preferences, `${role}: preferences mismatch`);
    }
});