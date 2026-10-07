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

// ──────────────────────────────────────────────────────────────────────────
// v0.8.0 (F3) — audit dispatch helpers.
//
// The audit-team reshaper pattern (ADR-0007 / ADR-0034) places audit
// *dispatch* in the workflow orchestrator's hands — the framework only
// declares the audit_roles surface and (now) consumes audit-verdicts from
// the run directory. To keep gate_runner.ts decoupled from the dispatch
// surface, the helpers below live here.
// ──────────────────────────────────────────────────────────────────────────

import type { ResolvedBinding } from "./profile_loader.js";

/**
 * One entry in the audit-dispatch plan. Carries enough information for a
 * workflow orchestrator to invoke `Agent(subagent_type, model)` with the
 * right model alias. `channels` is the declared channel list (callers may
 * use this for fallback when the resolved channel is unavailable).
 */
export interface AuditDispatch {
    /** Role-pack name (e.g. "coding-judge"). */
    role: string;
    /** Model alias from the resolved binding (e.g. "sonnet"). */
    alias: string;
    /** Resolved model id from the binding resolver. */
    model_id: string;
    /** Resolved channel id from the binding resolver. */
    channel_id: string;
}

export interface AuditDispatchPlan {
    /** The gate phase this plan applies to. */
    phase: string;
    /** Resolved dispatch entries, one per audit_role. */
    dispatch: AuditDispatch[];
    /**
     * audit_roles that did not resolve against `profile.resolved_bindings`.
     * Surfaced separately so the workflow can hard-fail rather than
     * silently drop a declared role.
     */
    unresolved: string[];
}

/**
 * Build the audit-dispatch plan for a gate phase. Returns:
 *   * `dispatch` — one entry per audit_role that resolves.
 *   * `unresolved` — audit_roles that did not match a resolved_binding.
 *
 * The shape intentionally accepts a loose `profile` rather than the full
 * Profile type so gate_runner.ts and other call-sites can pass the minimal
 * slice they have.
 */
export function resolveAuditDispatchPlan(
    profile: {
        gates: Record<string, { audit_roles?: string[] | undefined }>;
        resolved_bindings: Record<string, ResolvedBinding>;
    },
    phaseName: string,
): AuditDispatchPlan {
    const phase = profile.gates[phaseName];
    const auditRoles = phase?.audit_roles ?? [];
    const dispatch: AuditDispatch[] = [];
    const unresolved: string[] = [];
    for (const role of auditRoles) {
        const rb = profile.resolved_bindings[role];
        if (!rb) {
            unresolved.push(role);
            continue;
        }
        dispatch.push({
            role,
            alias: rb.alias,
            model_id: rb.model_id,
            channel_id: rb.channel_id,
        });
    }
    return { phase: phaseName, dispatch, unresolved };
}

/**
 * Verdict emitted by an audit role. Workflow orchestrators write this
 * verdict into `<runDir>/audit-verdicts.json` after dispatching the role.
 *
 *   * `approved`     — work passes, no resubmit.
 *   * `needs_rework` — work needs another pass; counter increments.
 *   * `rejected`     — same as needs_rework for counter purposes
 *                     (caller's choice to escalate differently).
 */
export type AuditVerdict = "approved" | "needs_rework" | "rejected";

export interface AuditVerdictResult {
    /** 0-indexed attempt count *after* this verdict was recorded. */
    attempt: number;
    /** True iff recording this verdict reached the escalation cap. */
    capReached: boolean;
}

/**
 * Record an audit verdict into the persistence counter and return the
 * post-record state. `approved` does NOT increment (the work is done);
 * `needs_rework` and `rejected` both increment (caller decides whether
 * to actually resubmit on `rejected`).
 *
 * The caller pattern:
 *
 *     const r = recordAuditVerdict(logDir, "coding-judge", "needs_rework", escalation);
 *     if (r.capReached) {
 *         throw new Error(`audit cap exhausted after ${r.attempt}`);
 *     }
 *     // resubmit the work to coding-coder
 */
export function recordAuditVerdict(
    logDir: string,
    _role: string,
    verdict: AuditVerdict,
    escalation: Escalation,
): AuditVerdictResult {
    if (verdict === "approved") {
        // No increment — just report the current state. capReached reflects
        // the *future* cap state, but since the workflow is done, false is
        // the safe semantic for callers asking "may I proceed?".
        const attempt = readAuditCounter(logDir);
        return { attempt, capReached: false };
    }
    const attempt = incrementAuditCounter(logDir);
    const allowed = canResubmit(escalation, logDir);
    return { attempt, capReached: !allowed.allowed };
}

/**
 * Persisted verdict file written by the workflow orchestrator after
 * dispatching the audit roles. Format:
 *
 *     {
 *       "phase": "review",
 *       "verdicts": [
 *         { "role": "coding-judge",    "verdict": "needs_rework", "reason": "..." },
 *         { "role": "coding-countersign", "verdict": "approved" }
 *       ]
 *     }
 *
 * The file lives at `<runDir>/audit-verdicts.json`. The gate runner
 * reads it before executing commands; if it is missing, the gate
 * proceeds normally (audit is advisory, not blocking).
 */
export interface AuditVerdictRecord {
    role: string;
    verdict: AuditVerdict;
    reason?: string;
}

export interface AuditVerdictsFile {
    phase?: string;
    verdicts: AuditVerdictRecord[];
}

export type AuditVerdictSummary =
    | "approved"
    | "needs_rework"
    | "rejected"
    | "cap_exhausted";

const AUDIT_VERDICTS_FILENAME = "audit-verdicts.json";

/**
 * Read the audit-verdicts file from a run directory. Returns null when
 * the file does not exist (audit is advisory, not blocking). Malformed
 * files are also surfaced as null + a stderr warning, since silently
 * dropping a verdict would mask the workflow's bug.
 */
export function readAuditVerdicts(logDir: string): AuditVerdictsFile | null {
    if (!logDir) {
        throw new Error("audit_workflow.readAuditVerdicts: logDir must be non-empty");
    }
    const p = path.join(logDir, AUDIT_VERDICTS_FILENAME);
    if (!fs.existsSync(p)) return null;
    try {
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw) as Partial<AuditVerdictsFile>;
        if (!parsed || !Array.isArray(parsed.verdicts)) return null;
        const verdicts: AuditVerdictRecord[] = [];
        for (const v of parsed.verdicts) {
            if (
                v &&
                typeof v.role === "string" &&
                (v.verdict === "approved" ||
                    v.verdict === "needs_rework" ||
                    v.verdict === "rejected")
            ) {
                verdicts.push({
                    role: v.role,
                    verdict: v.verdict,
                    reason: typeof v.reason === "string" ? v.reason : undefined,
                });
            }
        }
        return {
            phase: typeof parsed.phase === "string" ? parsed.phase : undefined,
            verdicts,
        };
    } catch (e) {
        process.stderr.write(
            `[audit_workflow] malformed audit-verdicts.json at ${p}: ${(e as Error).message}\n`,
        );
        return null;
    }
}

/**
 * Reduce a list of verdict records into a single summary suitable for
 * gate_runner.ts to branch on:
 *
 *   * any `rejected` → "rejected"
 *   * any `needs_rework` → "needs_rework"
 *   * all `approved` (or empty) → "approved"
 *
 * `cap_exhausted` is returned only when the caller has combined this
 * summary with `recordAuditVerdict` results — see gate_runner.ts.
 */
export function summarizeAuditVerdicts(
    verdicts: AuditVerdictRecord[],
): AuditVerdictSummary {
    let anyNeedsRework = false;
    for (const v of verdicts) {
        if (v.verdict === "rejected") return "rejected";
        if (v.verdict === "needs_rework") anyNeedsRework = true;
    }
    return anyNeedsRework ? "needs_rework" : "approved";
}