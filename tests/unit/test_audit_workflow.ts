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