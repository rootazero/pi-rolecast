/**
 * tests/unit/test_audit_workflow.ts
 *
 * Tests for src/audit_workflow.ts (v0.7.0 E2). Pure-function surface for
 * workflow callers that need to honor escalation.audit_max_resubmits.
 */
import { test as testApi } from "node:test";
import assertLib from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    readAuditCounter,
    incrementAuditCounter,
    canResubmit,
    resetAuditCounter,
} from "../../src/audit_workflow.js";
import type { Escalation } from "../../src/profile_loader.js";

const test = testApi;
const assert = assertLib;

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-rolecast-audit-"));
}

function makeEscalation(overrides: Partial<Escalation> = {}): Escalation {
    return {
        max_attempts: 3,
        gate_max_attempts: null,
        audit_max_resubmits: 3,
        non_negotiable_max_retries: null,
        on_permanent_failure: "stop",
        preserve_logs: true,
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────
// readAuditCounter
// ─────────────────────────────────────────────────────────────────────

test("readAuditCounter: returns 0 when file missing", () => {
    const dir = makeTempDir();
    try {
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readAuditCounter: returns parsed value on valid file", () => {
    const dir = makeTempDir();
    try {
        const countersDir = path.join(dir, "counters");
        fs.mkdirSync(countersDir, { recursive: true });
        fs.writeFileSync(
            path.join(countersDir, "audit-counter.json"),
            JSON.stringify({ audit_attempt: 7 }),
            "utf8",
        );
        assert.equal(readAuditCounter(dir), 7);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readAuditCounter: returns 0 on malformed JSON", () => {
    const dir = makeTempDir();
    try {
        const countersDir = path.join(dir, "counters");
        fs.mkdirSync(countersDir, { recursive: true });
        fs.writeFileSync(
            path.join(countersDir, "audit-counter.json"),
            "not-json{",
            "utf8",
        );
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readAuditCounter: returns 0 on non-integer value", () => {
    const dir = makeTempDir();
    try {
        const countersDir = path.join(dir, "counters");
        fs.mkdirSync(countersDir, { recursive: true });
        fs.writeFileSync(
            path.join(countersDir, "audit-counter.json"),
            JSON.stringify({ audit_attempt: "seven" }),
            "utf8",
        );
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readAuditCounter: returns 0 on negative value", () => {
    const dir = makeTempDir();
    try {
        const countersDir = path.join(dir, "counters");
        fs.mkdirSync(countersDir, { recursive: true });
        fs.writeFileSync(
            path.join(countersDir, "audit-counter.json"),
            JSON.stringify({ audit_attempt: -1 }),
            "utf8",
        );
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readAuditCounter: throws on empty logDir", () => {
    assert.throws(() => readAuditCounter(""), /logDir must be non-empty/);
});

// ─────────────────────────────────────────────────────────────────────
// incrementAuditCounter
// ─────────────────────────────────────────────────────────────────────

test("incrementAuditCounter: creates counters/ dir + file on fresh logDir", () => {
    const dir = makeTempDir();
    try {
        const v = incrementAuditCounter(dir);
        assert.equal(v, 1);
        assert.equal(
            fs.existsSync(path.join(dir, "counters", "audit-counter.json")),
            true,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("incrementAuditCounter: is monotonic across calls", () => {
    const dir = makeTempDir();
    try {
        assert.equal(incrementAuditCounter(dir), 1);
        assert.equal(incrementAuditCounter(dir), 2);
        assert.equal(incrementAuditCounter(dir), 3);
        assert.equal(readAuditCounter(dir), 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("incrementAuditCounter: persists across processes (read-after-write)", () => {
    const dir = makeTempDir();
    try {
        incrementAuditCounter(dir);
        incrementAuditCounter(dir);
        // readAuditCounter is the public read API; verify it sees the
        // persisted state.
        assert.equal(readAuditCounter(dir), 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("incrementAuditCounter: throws on empty logDir", () => {
    assert.throws(() => incrementAuditCounter(""), /logDir must be non-empty/);
});

// ─────────────────────────────────────────────────────────────────────
// canResubmit
// ─────────────────────────────────────────────────────────────────────

test("canResubmit: allows when audit_max_resubmits is null (unbounded)", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: null });
        for (let i = 0; i < 100; i++) {
            const v = canResubmit(esc, dir);
            assert.equal(v.allowed, true);
            assert.equal(v.max, null);
            assert.equal(v.remaining, null);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("canResubmit: allows when attempt < max", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 3 });
        // a=0
        let v = canResubmit(esc, dir);
        assert.equal(v.allowed, true);
        assert.equal(v.attempt, 0);
        assert.equal(v.max, 3);
        assert.equal(v.remaining, 3);
        // bump to 1
        incrementAuditCounter(dir);
        v = canResubmit(esc, dir);
        assert.equal(v.allowed, true);
        assert.equal(v.attempt, 1);
        assert.equal(v.remaining, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("canResubmit: blocks when attempt >= max", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 2 });
        incrementAuditCounter(dir);
        incrementAuditCounter(dir);
        const v = canResubmit(esc, dir);
        assert.equal(v.allowed, false);
        assert.equal(v.attempt, 2);
        assert.equal(v.max, 2);
        assert.equal(v.remaining, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("canResubmit: blocks at attempt > max (e.g. counter already over cap)", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 2 });
        // Seed 5 directly.
        const countersDir = path.join(dir, "counters");
        fs.mkdirSync(countersDir, { recursive: true });
        fs.writeFileSync(
            path.join(countersDir, "audit-counter.json"),
            JSON.stringify({ audit_attempt: 5 }),
            "utf8",
        );
        const v = canResubmit(esc, dir);
        assert.equal(v.allowed, false);
        assert.equal(v.attempt, 5);
        assert.equal(v.remaining, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("canResubmit: does not mutate state (pure read)", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 3 });
        canResubmit(esc, dir);
        canResubmit(esc, dir);
        canResubmit(esc, dir);
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// resetAuditCounter
// ─────────────────────────────────────────────────────────────────────

test("resetAuditCounter: removes the file when present", () => {
    const dir = makeTempDir();
    try {
        incrementAuditCounter(dir);
        incrementAuditCounter(dir);
        assert.equal(readAuditCounter(dir), 2);
        resetAuditCounter(dir);
        assert.equal(readAuditCounter(dir), 0);
        assert.equal(
            fs.existsSync(path.join(dir, "counters", "audit-counter.json")),
            false,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("resetAuditCounter: no-op when file missing", () => {
    const dir = makeTempDir();
    try {
        resetAuditCounter(dir); // must not throw
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("resetAuditCounter: throws on empty logDir", () => {
    assert.throws(() => resetAuditCounter(""), /logDir must be non-empty/);
});

// ─────────────────────────────────────────────────────────────────────
// Integration: increment + canResubmit pattern (workflow-style usage)
// ─────────────────────────────────────────────────────────────────────

test("integration: workflow-style loop honors the resubmit cap", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 2 });
        const calls: number[] = [];
        // Simulate: for each iteration, check, increment, record.
        for (let i = 0; i < 5; i++) {
            const v = canResubmit(esc, dir);
            if (!v.allowed) break;
            incrementAuditCounter(dir);
            calls.push(v.attempt + 1);
        }
        // Cap is 2; loop runs exactly twice.
        assert.deepEqual(calls, [1, 2]);
        assert.equal(readAuditCounter(dir), 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("integration: reset between runs clears the cap", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 1 });
        incrementAuditCounter(dir);
        assert.equal(canResubmit(esc, dir).allowed, false);
        resetAuditCounter(dir);
        assert.equal(canResubmit(esc, dir).allowed, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ─────────────────────────────────────────────────────────────────────
// Atomic write (tmp + rename) — sanity checks
// ─────────────────────────────────────────────────────────────────────

test("incrementAuditCounter: does not leave .tmp files behind", () => {
    const dir = makeTempDir();
    try {
        for (let i = 0; i < 5; i++) {
            incrementAuditCounter(dir);
        }
        const countersDir = path.join(dir, "counters");
        const files = fs.readdirSync(countersDir);
        assert.deepEqual(files, ["audit-counter.json"]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("incrementAuditCounter: written JSON parses with audit_attempt key", () => {
    const dir = makeTempDir();
    try {
        incrementAuditCounter(dir);
        incrementAuditCounter(dir);
        const raw = fs.readFileSync(
            path.join(dir, "counters", "audit-counter.json"),
            "utf8",
        );
        const parsed = JSON.parse(raw) as { audit_attempt?: unknown };
        assert.equal(parsed.audit_attempt, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ───────────────────────────────────────────────────────────────────
// v0.8.0 (F3) — audit dispatch helpers
// ───────────────────────────────────────────────────────────────────

import {
    recordAuditVerdict,
    readAuditVerdicts,
    resolveAuditDispatchPlan,
    summarizeAuditVerdicts,
    type AuditDispatch,
    type AuditVerdict,
    type ResolvedBinding,
} from "../../src/audit_workflow.js";

function makeResolvedBinding(
    role: string,
    overrides: Partial<ResolvedBinding> = {},
): ResolvedBinding {
    return {
        role,
        alias: "sonnet",
        model_id: "anthropic/claude-sonnet",
        channel_id: "anthropic",
        trust: "trusted",
        warning: null,
        via_fallback: false,
        ...overrides,
    };
}

test("F3 resolveAuditDispatchPlan: happy path returns one entry per resolved audit_role", () => {
    const profile = {
        gates: {
            review: {
                audit_roles: ["coding-judge", "coding-countersign"],
            },
        },
        resolved_bindings: {
            "coding-judge": makeResolvedBinding("coding-judge", { alias: "opus" }),
            "coding-countersign": makeResolvedBinding("coding-countersign"),
        },
    };
    const plan = resolveAuditDispatchPlan(profile, "review");
    assert.equal(plan.phase, "review");
    assert.equal(plan.dispatch.length, 2);
    assert.equal(plan.unresolved.length, 0);
    const judge = plan.dispatch.find((d) => d.role === "coding-judge");
    assert.ok(judge);
    assert.equal(judge?.alias, "opus");
    assert.equal(judge?.model_id, "anthropic/claude-sonnet");
});

test("F3 resolveAuditDispatchPlan: unresolved roles surface separately from dispatch", () => {
    const profile = {
        gates: {
            review: {
                audit_roles: ["coding-judge", "coding-notary", "coding-secretariat"],
            },
        },
        resolved_bindings: {
            "coding-judge": makeResolvedBinding("coding-judge"),
            // coding-notary + coding-secretariat deliberately omitted
        },
    };
    const plan = resolveAuditDispatchPlan(profile, "review");
    assert.equal(plan.dispatch.length, 1);
    assert.equal(plan.dispatch[0]?.role, "coding-judge");
    assert.deepEqual(plan.unresolved, ["coding-notary", "coding-secretariat"]);
});

test("F3 resolveAuditDispatchPlan: missing phase yields empty plan", () => {
    const profile = {
        gates: {
            review: { audit_roles: ["coding-judge"] },
        },
        resolved_bindings: {
            "coding-judge": makeResolvedBinding("coding-judge"),
        },
    };
    const plan = resolveAuditDispatchPlan(profile, "ship");
    assert.equal(plan.phase, "ship");
    assert.equal(plan.dispatch.length, 0);
    assert.equal(plan.unresolved.length, 0);
});

test("F3 recordAuditVerdict: approved does not increment the counter", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 3 });
        const r = recordAuditVerdict(dir, "coding-judge", "approved", esc);
        assert.equal(r.attempt, 0);
        assert.equal(r.capReached, false);
        assert.equal(readAuditCounter(dir), 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("F3 recordAuditVerdict: needs_rework increments and reports capReached=false while under cap", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 3 });
        const r1 = recordAuditVerdict(dir, "coding-judge", "needs_rework", esc);
        assert.equal(r1.attempt, 1);
        assert.equal(r1.capReached, false);
        const r2 = recordAuditVerdict(dir, "coding-judge", "needs_rework", esc);
        assert.equal(r2.attempt, 2);
        assert.equal(r2.capReached, false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("F3 recordAuditVerdict: cap reached when increment meets the limit", () => {
    const dir = makeTempDir();
    try {
        const esc = makeEscalation({ audit_max_resubmits: 2 });
        recordAuditVerdict(dir, "coding-judge", "needs_rework", esc);
        const r = recordAuditVerdict(dir, "coding-judge", "needs_rework", esc);
        assert.equal(r.attempt, 2);
        assert.equal(r.capReached, true, "attempt 2 of cap 2 must report capReached");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("F3 readAuditVerdicts + summarizeAuditVerdicts: rejects takes priority over needs_rework", () => {
    const dir = makeTempDir();
    try {
        const payload = {
            phase: "review",
            verdicts: [
                { role: "coding-judge", verdict: "needs_rework" as AuditVerdict },
                { role: "coding-countersign", verdict: "rejected" as AuditVerdict },
            ],
        };
        fs.writeFileSync(path.join(dir, "audit-verdicts.json"), JSON.stringify(payload), "utf8");
        const file = readAuditVerdicts(dir);
        assert.ok(file);
        assert.equal(summarizeAuditVerdicts(file.verdicts), "rejected");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("F3 readAuditVerdicts: missing file returns null, malformed file returns null with stderr warning", () => {
    const dir = makeTempDir();
    try {
        assert.equal(readAuditVerdicts(dir), null, "missing file → null");
        // Silence the expected stderr warning from the malformed case.
        const origStderr = process.stderr.write.bind(process.stderr);
        let captured = "";
        (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
            captured += s;
            return true;
        };
        try {
            fs.writeFileSync(path.join(dir, "audit-verdicts.json"), "{not json", "utf8");
            assert.equal(readAuditVerdicts(dir), null);
            assert.match(captured, /malformed audit-verdicts\.json/);
        } finally {
            process.stderr.write = origStderr;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});