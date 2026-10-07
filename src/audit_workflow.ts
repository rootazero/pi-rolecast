/**
 * v0.7.0 (E2) — audit-workflow helpers.
 *
 * Audit-team reshapers are a workflow-level concept, not a gate-runner
 * concept. The gate runner only validates the *declaration* via
 * `audit_roles`; the actual resubmit loop is the caller's responsibility
 * (see ADR-0007 — "no retry brake on audit", i.e. no auto-retry).
 *
 * This module provides a small, pure-function surface so workflow
 * orchestrators can implement the resubmit cap without rolling their
 * own counter logic. Persistence format is
 * `logDir/counters/audit-counter.json`, holding `{ "audit_attempt": number }`.
 *
 * Counter semantics:
 *   * readAuditCounter returns the current count (0 if file missing).
 *   * incrementAuditCounter atomically writes count+1 and returns the
 *     new value. This is the call to make *after* a rejected audit
 *     verdict, before resubmitting the work to the coder/fixer.
 *   * canResubmit consults escalation.counter + the on-disk count and
 *     returns a structured verdict the workflow can branch on.
 *   * resetAuditCounter removes the file). Useful for graceful reset
 *     between gate-runs that share the same logDir.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Escalation } from "./profile_loader.js";

/**
 * Structured can-submit verdict. The workflow caller is responsible for
 * inspecting `allowed`; the others are diagnostic surface so the caller can
 * include "attempt 3 of 7" in user-visible messages.
 */

export interface ResubmitVerdict {
    /** True iff the caller may resubmit (attempt < max or max is null). */
    allowed: boolean;
    /** 0-indexed attempt count after the most recent increment. */
    attempt: number;
    /** `null` if no cap declared. */
    max: number | null;
    /** `max - attempt` if max declared; `null` if unbounded. */
    remaining: number | null;
}

const COUNTERS_DIR = "counters";
const COUNTER_FILENAME = "audit-counter.json";

function counterPath(logDir: string): string {
    return path.join(logDir, COUNTERS_DIR, COUNTER_FILENAME);
}

interface PersistedCounter {
    audit_attempt: number;
}

/**
 * Read the persisted audit-attempt counter. Returns 0 if the file is
 * missing or malformed. Atomic w.r.t. incrementAuditCounter (writers
 * use rename so partial writes never appear).
 */
export function readAuditCounter(logDir: string): number {
    if (!logDir) {
        throw new Error("audit_workflow.readAuditCounter: logDir must be non-empty");
    }
    const p = counterPath(logDir);
    if (!fs.existsSync(p)) return 0;
    try {
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw) as Partial<PersistedCounter>;
        const v = parsed.audit_attempt;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return 0;
        return v;
    } catch {
        return 0;
    }
}

/**
 * Increment the audit-attempt counter atomically. Creates the
 * counters directory if missing. Returns the post-increment count.
 * On a fresh logDir, the first call returns 1.
 */
export function incrementAuditCounter(logDir: string): number {
    if (!logDir) {
        throw new Error("audit_workflow.incrementAuditCounter: logDir must be non-empty");
    }
    const countersDir = path.join(logDir, COUNTERS_DIR);
    const p = counterPath(logDir);
    const current = readAuditCounter(logDir);
    const next = current + 1;
    fs.mkdirSync(countersDir, { recursive: true });
    const payload: PersistedCounter = { audit_attempt: next };
    // Atomic write: tmp + rename so concurrent readers never see a
    // half-written file.
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, p);
    return next;
}

/**
 * Reset the audit-attempt counter (delete the file). Safe to call
 * when the file does not exist. Useful between gate-runs that share
 * the same logDir but should not share an audit-resubmit count.
 */
export function resetAuditCounter(logDir: string): void {
    if (!logDir) {
        throw new Error("audit_workflow.resetAuditCounter: logDir must be non-empty");
    }
    const p = counterPath(logDir);
    if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
    }
}

/**
 * Decide whether the workflow may resubmit. Does NOT mutate state.
 * Caller pattern:
 *
 *     const allowed = canResubmit(profile.escalation, logDir);
 *     if (!allowed.allowed) {
 *         throw new Error(
 *             `audit cap exhausted after ${allowed.attempt} of
 *              ${profile.escalation.audit_max_resubmits}`,
 *         );
 *     }
 *     incrementAuditCounter(logDir);
 *     // resubmit the work
 *
 * Note that this returns the count as-is (no increment) so the caller
 * can branch on the current value without side effects.
 */
export function canResubmit(
    escalation: Escalation,
    logDir: string,
): ResubmitVerdict {
    const max = escalation.audit_max_resubmits;
    const attempt = readAuditCounter(logDir);
    if (max === null) {
        return { allowed: true, attempt, max: null, remaining: null };
    }
    const remaining = Math.max(0, max - attempt);
    return {
        allowed: attempt < max,
        attempt,
        max,
        remaining,
    };
}