/**
 * tests/unit/test_scaffolder.ts
 *
 * Tests for src/scaffolder.ts (v0.5.0: TypeScript port of
 * scripts/scaffolder.py).
 *
 * Run with: npx tsx --test tests/unit/test_scaffolder.ts
 */
import { test as testApi } from "node:test";
import assertLib from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

import {
    autoDetectLanguages,
    detectLanguage,
    diffProfile,
    scaffoldInit,
    validateProfile,
} from "../../src/scaffolder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const FRAMEWORK_ROOT = PROJECT_ROOT;

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rolecast-scaffold-"));
}

function touchFile(dir: string, name: string): void {
    fs.writeFileSync(path.join(dir, name), "");
}

const test = testApi;

// ─────────────────────────────────────────────────────────────────────
// autoDetectLanguages + detectLanguage
// ─────────────────────────────────────────────────────────────────────

test("autoDetectLanguages: rust project detects rust", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        assertLib.deepEqual(autoDetectLanguages(tmp), ["rust"]);
        assertLib.equal(detectLanguage(tmp), "rust");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("autoDetectLanguages: python project (pyproject.toml) detects python", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "pyproject.toml");
        assertLib.deepEqual(autoDetectLanguages(tmp), ["python"]);
        assertLib.equal(detectLanguage(tmp), "python");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("autoDetectLanguages: typescript project (package.json + tsconfig.json) detects typescript", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "package.json");
        touchFile(tmp, "tsconfig.json");
        assertLib.deepEqual(autoDetectLanguages(tmp), ["typescript"]);
        assertLib.equal(detectLanguage(tmp), "typescript");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("autoDetectLanguages: package.json-only falls back to javascript", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "package.json");
        const detected = autoDetectLanguages(tmp);
        assertLib.ok(detected.includes("typescript"));
        assertLib.ok(detected.includes("javascript"));
        // v0.5.2: absence of tsconfig.json is a JS signal, so detectLanguage
        // defaults to "javascript" instead of returning null. Users with a
        // TS project that hasn't committed tsconfig.json yet can pass
        // --template typescript explicitly.
        assertLib.equal(detectLanguage(tmp), "javascript");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("autoDetectLanguages: go project detects go", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "go.mod");
        assertLib.deepEqual(autoDetectLanguages(tmp), ["go"]);
        assertLib.equal(detectLanguage(tmp), "go");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("autoDetectLanguages: empty project returns []", () => {
    const tmp = makeTempDir();
    try {
        assertLib.deepEqual(autoDetectLanguages(tmp), []);
        assertLib.equal(detectLanguage(tmp), null);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// scaffoldInit
// ─────────────────────────────────────────────────────────────────────

test("scaffoldInit: --template rust writes Cargo.toml-detected template", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
            template: "rust",
        });
        assertLib.equal(r.ok, true);
        assertLib.ok(r.profilePath !== undefined);
        assertLib.ok(fs.existsSync(r.profilePath!));
        const content = fs.readFileSync(r.profilePath!, "utf8");
        assertLib.ok(content.includes("framework_version"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: auto-detects rust when no --template", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
        });
        assertLib.equal(r.ok, true);
        assertLib.equal(r.template, "rust");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: blank emits templates/blank.yaml content (not empty dict)", () => {
    const tmp = makeTempDir();
    try {
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
            blank: true,
        });
        assertLib.equal(r.ok, true);
        assertLib.equal(r.template, "(blank)");
        assertLib.ok(r.profilePath !== undefined);
        const content = fs.readFileSync(r.profilePath!, "utf8");
        // v0.4.3 regression guard — blank template must include name/description.
        assertLib.ok(content.includes("name:"), "blank template missing name");
        assertLib.ok(content.includes("description:"), "blank template missing description");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: refuses to overwrite without --force", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".pi", "rolecast.yaml"), "name: pre-existing\n");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
        });
        assertLib.equal(r.ok, false);
        assertLib.ok(r.message.includes("already exists"));
        // File unchanged.
        assertLib.equal(
            fs.readFileSync(path.join(tmp, ".pi", "rolecast.yaml"), "utf8"),
            "name: pre-existing\n",
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: --force overwrites existing profile", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        fs.mkdirSync(path.join(tmp, ".pi"), { recursive: true });
        fs.writeFileSync(path.join(tmp, ".pi", "rolecast.yaml"), "name: pre-existing\n");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
            force: true,
        });
        assertLib.equal(r.ok, true);
        const content = fs.readFileSync(r.profilePath!, "utf8");
        assertLib.ok(!content.includes("pre-existing"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: --dry-run does not write", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "Cargo.toml");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
            dryRun: true,
        });
        assertLib.equal(r.ok, true);
        assertLib.ok(r.message.includes("DRY RUN"));
        assertLib.ok(!fs.existsSync(path.join(tmp, ".pi", "rolecast.yaml")));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("scaffoldInit: package.json-only falls back to javascript template (v0.5.2)", () => {
    const tmp = makeTempDir();
    try {
        touchFile(tmp, "package.json");
        const r = scaffoldInit({
            projectRoot: tmp,
            frameworkRoot: FRAMEWORK_ROOT,
        });
        assertLib.equal(r.ok, true, `expected ok=true but got: ${r.message ?? "(no message)"}`);
        assertLib.equal(r.template, "javascript");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// diffProfile
// ─────────────────────────────────────────────────────────────────────

test("diffProfile: profile not found returns ok=false", () => {
    const tmp = makeTempDir();
    try {
        const r = diffProfile({
            profilePath: path.join(tmp, "nope.yaml"),
            frameworkRoot: FRAMEWORK_ROOT,
        });
        assertLib.equal(r.ok, false);
        assertLib.ok(r.output.includes("not found"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("diffProfile: framework_version missing returns ok=false", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "rolecast.yaml");
        fs.writeFileSync(p, "name: test\ndescription: x\n");
        const r = diffProfile({ profilePath: p, frameworkRoot: FRAMEWORK_ROOT });
        assertLib.equal(r.ok, false);
        assertLib.ok(r.output.includes("framework_version"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test("diffProfile: sample-rust fixture emits no-missing-fields", () => {
    const r = diffProfile({
        profilePath: path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust", ".pi", "rolecast.yaml"),
        frameworkRoot: FRAMEWORK_ROOT,
    });
    assertLib.equal(r.ok, true);
    assertLib.ok(r.output.includes("no missing fields"));
});

// ─────────────────────────────────────────────────────────────────────
// validateProfile
// ─────────────────────────────────────────────────────────────────────

test("validateProfile: sample-rust fixture reports VALID with resolved bindings", () => {
    const r = validateProfile({
        profilePath: path.join(PROJECT_ROOT, "tests", "fixtures", "sample-rust", ".pi", "rolecast.yaml"),
        frameworkRoot: FRAMEWORK_ROOT,
    });
    assertLib.equal(r.ok, true);
    assertLib.ok(r.output.includes("is valid"));
    // v0.6.0: coding-orchestrator binding is dropped (REMOVED warning),
    // so 10 of the 11 fixture bindings resolve.
    assertLib.ok(r.output.includes("bindings resolved: 10"));
    assertLib.ok(r.output.includes("coding-architect"));
    assertLib.ok(
        r.output.match(/coding-orchestrator.*REMOVED/),
        "expected REMOVED warning for coding-orchestrator in validateProfile output",
    );
});

test("validateProfile: malformed profile returns INVALID", () => {
    const tmp = makeTempDir();
    try {
        const p = path.join(tmp, "rolecast.yaml");
        fs.writeFileSync(p, "framework_version: 0.2.0\nbindings:\n  bad: [\nunbalanced");
        const r = validateProfile({ profilePath: p, frameworkRoot: FRAMEWORK_ROOT });
        assertLib.equal(r.ok, false);
        assertLib.ok(r.output.startsWith("INVALID:"));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

