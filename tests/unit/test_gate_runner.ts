/**
 * tests/unit/test_gate_runner.ts
 *
 * Tests for src/gate_runner.ts (v0.5.0: TypeScript port of
 * scripts/gate_runner.py).
 *
 * Run with: npx tsx --test tests/unit/test_gate_runner.ts
 */
import { test as testApi } from "node:test";
import assertLib from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate, resolveAuditRoles, type RunGateOptions } from "../../src/gate_runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const test = testApi;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rolecast-gate-"));
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

function rmTemp(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // best-effort
    }
}

/** Build a minimal but valid v0.2.0 profile; commands/timing overridable. */
function profileYaml(opts: {
    phases?: Record<string, { commands: string[]; timeout: number }>;
    maxAttempts?: number;
    onFailure?: "stop" | "continue";
    auditRoles?: Record<string, string[]>;
    bindings?: Record<string, { alias: string; channels: string[] }>;
}): string {
    const phases = opts.phases ?? {
        phase_a: { commands: ["true"], timeout: 10 },
    };
    const maxAttempts = opts.maxAttempts ?? 1;
    const onFailure = opts.onFailure ?? "stop";
    const auditRoles = opts.auditRoles ?? {};
    // phaseBlock is indented 10 spaces so that, after the template's
    // 8-space dedent pass in writeProfile(), the gates: keys end up
    // at 2-space indent — a child of the top-level gates: mapping.
    const phaseLines: string[] = [];
    for (const [name, def] of Object.entries(phases)) {
        phaseLines.push(`          ${name}:`);
        phaseLines.push(`            commands:`);
        for (const cmd of def.commands) {
            phaseLines.push(`              - ${JSON.stringify(cmd)}`);
        }
        phaseLines.push(`            timeout: ${def.timeout}`);
        if (auditRoles[name]) {
            phaseLines.push(`            audit_roles:`);
            for (const r of auditRoles[name]!) {
                phaseLines.push(`              - ${JSON.stringify(r)}`);
            }
        }
    }
    const phaseBlock = phaseLines.join("\n");
    const bindings = opts.bindings ?? {
        "coding-architect": { alias: "opus-thinking-medium", channels: ["official"] },
        "coding-planner": { alias: "deepseek-verifiable", channels: ["official"] },
    };
    const bindingLines: string[] = ["        bindings:"];
    for (const [name, def] of Object.entries(bindings)) {
        bindingLines.push(`          ${name}: {alias: ${def.alias}, channels: [${def.channels.join(", ")}]}`);
    }
    const bindingBlock = bindingLines.join("\n");
    return `
        framework_version: 0.2.0
        name: gate-runner-test-fixture
        description: |
          Inline fixture for gate_runner.ts tests.

        workflow:
          role_groups: [coding]

        gates:
${phaseBlock}

${bindingBlock}

        non_negotiables:
          forbidden_patterns: []

        escalation:
          max_attempts: ${maxAttempts}
          on_permanent_failure: ${onFailure}
          preserve_logs: true
    `;
}

function baseOpts(profilePath: string, extra?: Partial<RunGateOptions>): RunGateOptions {
    return {
        profilePath,
        frameworkRoot: PROJECT_ROOT,
        logDir: makeTempDir(),
        phase: "all",
        ...extra,
    };
}

function cleanup(...dirs: string[]): void {
    for (const d of dirs) rmTemp(d);
}

// ─────────────────────────────────────────────────────────────────────
// Profile-load error paths
// ─────────────────────────────────────────────────────────────────────

test("runGate: nonexistent profile returns exitCode 2 with errorTail", async () => {
    const tmp = makeTempDir();
    try {
        const r = await runGate({
            profilePath: path.join(tmp, "does-not-exist.yaml"),
            frameworkRoot: PROJECT_ROOT,
            logDir: makeTempDir(),
        });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 2);
        assertLib.match(r.errorTail, /profile error/i);
    } finally {
        rmTemp(tmp);
    }
});

test("runGate: malformed profile returns exitCode 2 with errorTail", async () => {
    const tmp = makeTempDir();
    try {
        const profilePath = path.join(tmp, ".pi", "rolecast.yaml");
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, "this is: not: valid: yaml: [\n");
        const r = await runGate({
            profilePath,
            frameworkRoot: PROJECT_ROOT,
            logDir: makeTempDir(),
        });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 2);
        assertLib.match(r.errorTail, /profile error/i);
    } finally {
        rmTemp(tmp);
    }
});

// ─────────────────────────────────────────────────────────────────────
// Pass / fail / retry
// ─────────────────────────────────────────────────────────────────────

test("runGate: single passing phase returns exitCode 0, ok=true", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, true);
        assertLib.equal(r.exitCode, 0);
        assertLib.equal(r.summary.phases.length, 1);
        assertLib.equal(r.summary.phases[0]?.name, "phase_a");
        assertLib.equal(r.summary.phases[0]?.status, "pass");
        assertLib.equal(r.errorTail, "");
        // Log file written under .pi/rolecast-logs/<ts>/phase_a-attempt1.log
        assertLib.ok(r.summary.phases[0]?.log);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: failing phase returns exitCode 1 with last_failure", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["false"], timeout: 10 } },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        assertLib.equal(r.summary.phases.length, 1);
        assertLib.equal(r.summary.phases[0]?.status, "fail");
        const lf = r.summary.phases[0]?.last_failure;
        assertLib.ok(lf);
        assertLib.equal(lf.returncode, 1);
        assertLib.equal(lf.attempt, 1);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: max_attempts retries a failing phase and surfaces last_failure attempt count", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["false"], timeout: 10 } },
            maxAttempts: 3,
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        const lf = r.summary.phases[0]?.last_failure;
        assertLib.ok(lf);
        assertLib.equal(lf.attempt, 3);
        assertLib.equal(r.summary.phases[0]?.attempts, 3);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: phase eventually passes within max_attempts", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        // Marker-file trick: false on attempt 1, true on attempt 2.
        const marker = path.join(tmp, "marker");
        const failThenPass =
            `if [ -f ${JSON.stringify(marker)} ]; then true; else touch ${JSON.stringify(marker)}; false; fi`;
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: [failThenPass], timeout: 10 } },
            maxAttempts: 3,
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, true);
        assertLib.equal(r.exitCode, 0);
        assertLib.equal(r.summary.phases[0]?.status, "pass");
        assertLib.equal(r.summary.phases[0]?.attempts, 2);
    } finally {
        cleanup(tmp, logDir);
    }
});

// ─────────────────────────────────────────────────────────────────────
// Phase ordering / halt policy
// ─────────────────────────────────────────────────────────────────────

test("runGate: on_permanent_failure=stop halts after first failure", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: {
                phase_a: { commands: ["false"], timeout: 10 },
                phase_b: { commands: ["true"], timeout: 10 },
            },
            onFailure: "stop",
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        assertLib.equal(r.summary.phases.length, 2);
        assertLib.equal(r.summary.phases[0]?.status, "fail");
        assertLib.equal(r.summary.phases[1]?.status, "skipped");
        assertLib.match(r.summary.phases[1]?.reason ?? "", /previous phase failed/);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: on_permanent_failure=continue runs every phase despite failure", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: {
                phase_a: { commands: ["false"], timeout: 10 },
                phase_b: { commands: ["true"], timeout: 10 },
            },
            onFailure: "continue",
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        assertLib.equal(r.summary.phases.length, 2);
        assertLib.equal(r.summary.phases[0]?.status, "fail");
        assertLib.equal(r.summary.phases[1]?.status, "pass");
    } finally {
        cleanup(tmp, logDir);
    }
});

// ─────────────────────────────────────────────────────────────────────
// Phase filter
// ─────────────────────────────────────────────────────────────────────

test("runGate: phase filter runs only the named phase", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: {
                phase_a: { commands: ["true"], timeout: 10 },
                phase_b: { commands: ["false"], timeout: 10 },
            },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir, phase: "phase_a" }) });
        assertLib.equal(r.ok, true);
        assertLib.equal(r.exitCode, 0);
        assertLib.equal(r.summary.phases.length, 1);
        assertLib.equal(r.summary.phases[0]?.name, "phase_a");
        assertLib.equal(r.summary.phases[0]?.status, "pass");
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: unknown phase filter returns exitCode 2", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir, phase: "nope" }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 2);
        assertLib.match(r.errorTail, /unknown phase/);
    } finally {
        cleanup(tmp, logDir);
    }
});

// ─────────────────────────────────────────────────────────────────────
// Timeout
// ─────────────────────────────────────────────────────────────────────

test("runGate: phase timeout kills long-running command and fails the phase", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["sleep 5"], timeout: 1 } },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        assertLib.equal(r.summary.phases[0]?.status, "fail");
    } finally {
        cleanup(tmp, logDir);
    }
}, { timeout: 30_000 });

// ─────────────────────────────────────────────────────────────────────
// Abort signal
// ─────────────────────────────────────────────────────────────────────

test("runGate: pre-aborted signal skips all phases", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: {
                phase_a: { commands: ["true"], timeout: 10 },
                phase_b: { commands: ["true"], timeout: 10 },
            },
        }));
        const ac = new AbortController();
        ac.abort();
        const r = await runGate({
            ...baseOpts(profilePath, { logDir }),
            signal: ac.signal,
        });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        assertLib.equal(r.summary.phases.length, 2);
        for (const p of r.summary.phases) {
            assertLib.equal(p.status, "skipped");
            assertLib.match(p.reason ?? "", /aborted/);
        }
    } finally {
        cleanup(tmp, logDir);
    }
});

// ─────────────────────────────────────────────────────────────────────
// JSON summary shape
// ─────────────────────────────────────────────────────────────────────

test("runGate: summary shape is JSON-serialisable with required keys", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: {
                phase_a: { commands: ["true"], timeout: 10 },
                phase_b: { commands: ["false"], timeout: 10 },
            },
            onFailure: "continue",
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        const s = JSON.parse(JSON.stringify(r.summary));
        assertLib.equal(s.profile, "gate-runner-test-fixture");
        assertLib.equal(s.framework_version, "0.2.0");
        assertLib.equal(s.ok, false);
        assertLib.equal(s.exitCode, 1);
        assertLib.ok(Array.isArray(s.phases));
        assertLib.equal(s.phases.length, 2);
    } finally {
        cleanup(tmp, logDir);
    }
});

// ─────────────────────────────────────────────────────────────────────
// v0.6.0 (D2) — audit_roles metadata + typo-safety
// ─────────────────────────────────────────────────────────────────────

test("resolveAuditRoles: empty declared list => no unresolved", () => {
    assertLib.deepEqual(resolveAuditRoles([], { "coding-judge": {} }), []);
    assertLib.deepEqual(resolveAuditRoles([], undefined), []);
});

test("resolveAuditRoles: all roles resolve against the bindings map => no unresolved", () => {
    assertLib.deepEqual(
        resolveAuditRoles(["coding-judge", "notary"], {
            "coding-judge": {},
            "notary": {},
        }),
        [],
    );
});

test("resolveAuditRoles: unknown role is reported as unresolved", () => {
    assertLib.deepEqual(
        resolveAuditRoles(["coding-judge", "ghost-role"], {
            "coding-judge": {},
        }),
        ["ghost-role"],
    );
});

test("resolveAuditRoles: bindings undefined means everything is unresolved", () => {
    // Defensive: when profile has no resolved_bindings, we cannot
    // validate, so the safe call is to surface every declared role.
    assertLib.deepEqual(
        resolveAuditRoles(["coding-judge", "notary"], undefined),
        ["coding-judge", "notary"],
    );
});

test("runGate: audit_roles that all resolve is recorded on the phase result", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect", "coding-planner"] },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, true);
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.deepEqual(ph?.audit_roles, ["coding-architect", "coding-planner"]);
        assertLib.deepEqual(ph?.audit_unresolved, []);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: unresolved audit_roles fails the phase even when commands pass", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect", "ghost-role"] },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        assertLib.equal(r.exitCode, 1);
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.status, "fail");
        assertLib.deepEqual(ph?.audit_unresolved, ["ghost-role"]);
        assertLib.match(ph?.last_failure?.stderr_tail ?? "", /ghost-role/);
    } finally {
        cleanup(tmp, logDir);
    }
});

test("runGate: phases without audit_roles are unaffected (backward compatible)", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.status, "pass");
        assertLib.equal(ph?.audit_roles, undefined);
        assertLib.equal(ph?.audit_unresolved, undefined);
    } finally {
        cleanup(tmp, logDir);
    }
});

// ───────────────────────────────────────────────────────────────────
// v0.8.0 (F3) — audit dispatch surface integration
// ───────────────────────────────────────────────────────────────────

/** Write an audit-verdicts.json file into a run directory. */
function writeAuditVerdicts(logDir: string, verdicts: unknown, phase?: string): void {
    const payload = { phase: phase ?? "phase_a", verdicts };
    fs.writeFileSync(path.join(logDir, "audit-verdicts.json"), JSON.stringify(payload), "utf8");
}

/**
 * Pre-create the runGate runDir with a predicted timestamp so the test
 * can drop an audit-verdicts.json file at the exact location the runner
 * will read. Uses the exported `__testing.formatTimestamp` helper so
 * the test stays in sync with the production format.
 */
async function prepareRunDirWithVerdicts(
    logDir: string,
    verdicts: unknown,
    phase?: string,
): Promise<string> {
    const mod = (await import("../../src/gate_runner.js")) as {
        __testing: { formatTimestamp: (d: Date) => string };
    };
    const ts = mod.__testing.formatTimestamp(new Date());
    const runDir = path.join(logDir, ts);
    fs.mkdirSync(runDir, { recursive: true });
    writeAuditVerdicts(runDir, verdicts, phase);
    return runDir;
}

test("F3 runGate: declares audit_required + audit_plan when audit_roles is non-empty", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect", "coding-planner"] },
        }));
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.audit_required, true, "phase must declare audit_required=true");
        assertLib.ok(ph?.audit_plan);
        assertLib.equal(ph?.audit_plan?.length, 2);
        const judge = ph?.audit_plan?.find((d) => d.role === "coding-architect");
        assertLib.ok(judge, "audit_plan must include coding-architect");
        assertLib.equal(judge?.alias, "opus-thinking-medium");
        assertLib.equal(judge?.channel_id, "official");
    } finally {
        cleanup(tmp, logDir);
    }
});

test("F3 runGate: approved audit verdict lets a passing phase pass", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect"] },
        }));
        await prepareRunDirWithVerdicts(logDir, [
            { role: "coding-architect", verdict: "approved" },
        ]);
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.status, "pass");
        assertLib.equal(ph?.audit_verdict, "approved");
    } finally {
        cleanup(tmp, logDir);
    }
});

test("F3 runGate: needs_rework audit verdict short-circuits the phase to fail", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect"] },
        }));
        await prepareRunDirWithVerdicts(logDir, [
            { role: "coding-architect", verdict: "needs_rework", reason: "missing tests" },
        ]);
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.status, "fail");
        assertLib.equal(ph?.audit_verdict, "needs_rework");
        assertLib.match(ph?.reason ?? "", /audit:needs_rework/);
        assertLib.equal(ph?.attempts, 0, "needs_rework must short-circuit before commands run");
    } finally {
        cleanup(tmp, logDir);
    }
});

test("F3 runGate: rejected audit verdict short-circuits with rejected summary", async () => {
    const tmp = makeTempDir();
    const logDir = makeTempDir();
    try {
        const profilePath = writeProfile(tmp, profileYaml({
            phases: { phase_a: { commands: ["true"], timeout: 10 } },
            auditRoles: { phase_a: ["coding-architect", "coding-planner"] },
        }));
        await prepareRunDirWithVerdicts(logDir, [
            { role: "coding-architect", verdict: "approved" },
            { role: "coding-planner", verdict: "rejected", reason: "scope creep" },
        ]);
        const r = await runGate({ ...baseOpts(profilePath, { logDir }) });
        assertLib.equal(r.ok, false);
        const ph = r.summary.phases[0];
        assertLib.ok(ph);
        assertLib.equal(ph?.status, "fail");
        assertLib.equal(ph?.audit_verdict, "rejected");
        assertLib.match(ph?.reason ?? "", /audit:rejected/);
    } finally {
        cleanup(tmp, logDir);
    }
});

