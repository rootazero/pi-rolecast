/**
 * pi-rolecast/src/gate_runner.ts
 *
 * Phase runner — executes profile gates in declared order, halts on
 * permanent failure per the escalation policy. Replaces the
 * `scripts/gate_runner.py` subprocess the extension used to spawn for
 * the `gate_run` tool and the `/rolecast-run` slash command.
 *
 * Consumes src/profile_loader.ts (validated Profile + resolved_bindings).
 * Does NOT enforce non_negotiables — that's the reviewer's job (spec §8.4).
 *
 * Exit codes (preserved from Python):
 *   0 — all requested phases passed
 *   1 — one or more phases failed after retries
 *   2 — config error (profile invalid, --phase unknown, etc)
 */
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { loadProfile, ProfileError } from "./profile_loader.js";
import {
    type AuditDispatch,
    type AuditVerdictSummary,
    readAuditVerdicts,
    resolveAuditDispatchPlan,
    summarizeAuditVerdicts,
} from "./audit_workflow.js";

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface RunGateOptions {
    profilePath: string;
    frameworkRoot?: string;
    /** Phase name or "all" (default "all"). */
    phase?: string;
    /** Where to write per-phase logs. Default ".pi/rolecast-logs". */
    logDir?: string;
    /**
     * Abort signal — if aborted, in-flight shell commands are killed
     * (SIGTERM) and pending phases are marked "skipped". The session
     * start timeout cap (10 min in extension.ts) drives this.
     */
    signal?: AbortSignal;
}

export interface PhaseResult {
    name: string;
    status: "pass" | "fail" | "skipped";
    attempts?: number;
    duration_s?: number;
    log?: string;
    log_dir?: string;
    last_failure?: {
        attempt: number;
        returncode: number;
        stdout_tail: string;
        stderr_tail: string;
    };
    reason?: string;
    /**
     * v0.6.0 (D2) — audit_roles declared on this phase plus how each
     * resolved against the profile's bindings. `audit_unresolved` lists
     * roles that did not match any binding (typo / stale reference) and
     * is the immediate cause of a phase FAIL when audit_roles is the
     * gate's primary enforcement surface.
     */
    audit_roles?: string[];
    audit_unresolved?: string[];
    /**
     * v0.8.0 (F3) — True iff the phase declared `audit_roles`. Surfaced
     * so the workflow orchestrator can decide whether to dispatch the
     * audit team before re-running the gate. Distinct from
     * `audit_unresolved` (typo safety) — `audit_required` is the
     * declaration surface, not the resolution surface.
     */
    audit_required?: boolean;
    /**
     * v0.8.0 (F3) — the dispatch plan the workflow should use to invoke
     * the audit team (one entry per resolved audit_role). Populated
     * whenever `audit_roles` is non-empty so the workflow does not have
     * to call `resolveAuditDispatchPlan` separately.
     */
    audit_plan?: AuditDispatch[];
    /**
     * v0.8.0 (F3) — audit verdict summary derived from the persisted
     * `<runDir>/audit-verdicts.json` file (if present). "approved"
     * means the workflow cleared this phase; "needs_rework" means a
     * resubmit is in order; "rejected" / "cap_exhausted" mean permanent
     * failure. Absent means no verdict file was written (audit was
     * advisory or skipped).
     */
    audit_verdict?: AuditVerdictSummary;
}

export interface GateSummary {
    profile: string;
    framework_version: string;
    phases: PhaseResult[];
    /** True iff all phases passed (or there were no failures with halt policy). */
    ok: boolean;
    exitCode: number;
}

export interface RunGateResult {
    ok: boolean;
    exitCode: number;
    summary: GateSummary;
    /** Captured stderr from any per-phase attempt that failed (capped at 5KB). */
    errorTail: string;
}

// ─────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────

export function runGate(opts: RunGateOptions): Promise<RunGateResult> {
    return runGateAsync(opts);
}

async function runGateAsync(opts: RunGateOptions): Promise<RunGateResult> {
    const phaseFilter = opts.phase ?? "all";
    const logDir = path.resolve(opts.logDir ?? ".pi/rolecast-logs");
    const frameworkRoot = opts.frameworkRoot;

    let profile;
    try {
        profile = loadProfile(opts.profilePath, frameworkRoot);
    } catch (e) {
        if (e instanceof ProfileError) {
            return {
                ok: false,
                exitCode: 2,
                summary: emptySummary("profile"),
                errorTail: `profile error: ${e.message}`,
            };
        }
        const msg = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            exitCode: 2,
            summary: emptySummary("profile"),
            errorTail: `profile error: ${msg}`,
        };
    }

    const phases = Object.keys(profile.gates);
    if (phaseFilter !== "all") {
        if (!phases.includes(phaseFilter)) {
            return {
                ok: false,
                exitCode: 2,
                summary: emptySummary(profile.name),
                errorTail: `unknown phase '${phaseFilter}'; declared phases: ${JSON.stringify(phases)}`,
            };
        }
    }
    const targetPhases = phaseFilter === "all" ? phases : [phaseFilter];

    const timestamp = formatTimestamp(new Date());
    const runDir = path.join(logDir, timestamp);
    fs.mkdirSync(runDir, { recursive: true });

    const { phases: phaseResults, errorTail } = await runPhases(
        profile,
        targetPhases,
        runDir,
        opts.signal,
    );
    // Only "pass" counts as success. "skipped" (aborted, or previous
    // phase failed with halt policy) is a failure, not success.
    const ok = phaseResults.length > 0 && phaseResults.every((p) => p.status === "pass");
    return {
        ok,
        exitCode: ok ? 0 : 1,
        summary: {
            profile: profile.name,
            framework_version: profile.framework_version,
            phases: phaseResults,
            ok,
            exitCode: ok ? 0 : 1,
        },
        errorTail,
    };
}

interface RunStatsInternal {
    phases: PhaseResult[];
    errorTail: string;
}

async function runPhases(
    profile: { name: string; framework_version: string; gates: Record<string, GateDef>; escalation: EscalationDef; resolved_bindings?: Record<string, unknown> },
    phaseNames: string[],
    runDir: string,
    signal?: AbortSignal,
): Promise<RunStatsInternal> {
    const out: PhaseResult[] = [];
    const errorTails: string[] = [];
    let halt = false;
    for (const phaseName of phaseNames) {
        if (halt) {
            out.push({
                name: phaseName,
                status: "skipped",
                reason: "previous phase failed permanently",
            });
            continue;
        }
        if (signal?.aborted) {
            out.push({ name: phaseName, status: "skipped", reason: "aborted" });
            continue;
        }
        const r = await runPhase(profile, phaseName, runDir, signal);
        out.push(r.result);
        if (r.errorTail) errorTails.push(r.errorTail);
        if (r.result.status === "fail" && profile.escalation.on_permanent_failure === "stop") {
            halt = true;
        }
    }
    return { phases: out, errorTail: errorTails.join("\n").slice(-5000) };
}

async function runPhase(
    profile: { gates: Record<string, GateDef>; escalation: EscalationDef; resolved_bindings?: Record<string, unknown> },
    phaseName: string,
    runDir: string,
    signal?: AbortSignal,
): Promise<{ result: PhaseResult; errorTail: string }> {
    const phase = profile.gates[phaseName]!;
    const commands = phase.commands ?? [];
    const auditRoles = Array.isArray(phase.audit_roles) ? phase.audit_roles : [];
    const timeout = typeof phase.timeout === "number" ? phase.timeout : 300;
    const maxAttempts = Math.max(1, profile.escalation.max_attempts);
    const started = Date.now();

    // v0.8.0 (F3) — audit verdict pre-check. The workflow orchestrator
    // writes `<runDir>/audit-verdicts.json` after dispatching the audit
    // team; the gate runner reads it BEFORE attempting commands so an
    // advisory audit can short-circuit the phase with a structured
    // reason. Per ADR-0007 the gate does NOT retry automatically; the
    // workflow owns the resubmit loop.
    const auditVerdictsFile = readAuditVerdicts(runDir);
    const auditVerdictSummary: AuditVerdictSummary | undefined =
        auditVerdictsFile ? summarizeAuditVerdicts(auditVerdictsFile.verdicts) : undefined;
    const auditPlan = auditRoles.length > 0
        ? resolveAuditDispatchPlan(
            {
                gates: profile.gates as Record<string, { audit_roles?: string[] | undefined }>,
                resolved_bindings: (profile.resolved_bindings ?? {}) as Record<string, import("./profile_loader.js").ResolvedBinding>,
            },
            phaseName,
        )
        : null;
    const auditRequired = auditRoles.length > 0;
    const unresolvedAuditRoles = auditRoles.length > 0
        ? resolveAuditRoles(auditRoles, profile.resolved_bindings)
        : [];
    const baseAuditFields = {
        audit_roles: auditRoles.length > 0 ? auditRoles : undefined,
        audit_unresolved: auditRoles.length > 0 ? unresolvedAuditRoles : undefined,
        audit_required: auditRequired ? true : undefined,
        audit_plan: auditPlan && auditPlan.dispatch.length > 0 ? auditPlan.dispatch : undefined,
        audit_verdict: auditVerdictSummary,
    };

    if (auditVerdictSummary === "rejected" || auditVerdictSummary === "needs_rework") {
        // Short-circuit before running commands: the audit verdict
        // alone is sufficient to fail this phase. The reason field
        // carries the verdict summary so the workflow can branch on it.
        return {
            result: {
                name: phaseName,
                status: "fail",
                reason: `audit:${auditVerdictSummary}`,
                attempts: 0,
                duration_s: round2((Date.now() - started) / 1000),
                log_dir: runDir,
                ...baseAuditFields,
            },
            errorTail: `audit verdict: ${auditVerdictSummary}`,
        };
    }

    let lastFailure: PhaseResult["last_failure"] | undefined;
    let errorTail = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) {
            return {
                result: {
                    name: phaseName,
                    status: "skipped",
                    reason: "aborted",
                    attempts: attempt - 1,
                    duration_s: round2((Date.now() - started) / 1000),
                    ...baseAuditFields,
                },
                errorTail,
            };
        }
        const logPath = path.join(runDir, `${phaseName}-attempt${attempt}.log`);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const r = await runCommands(commands, timeout, logPath, signal);
        if (r.rc === 0) {
            const unresolved = resolveAuditRoles(auditRoles, profile.resolved_bindings);
            if (unresolved.length > 0) {
                // Audit roles were declared but did not resolve. Even
                // when commands succeeded, this is a configuration error
                // the gate runner must surface, not bury.
                return {
                    result: {
                        name: phaseName,
                        status: "fail",
                        attempts: attempt,
                        duration_s: round2((Date.now() - started) / 1000),
                        log: logPath,
                        audit_roles: auditRoles,
                        audit_unresolved: unresolved,
                        audit_required: auditRequired ? true : undefined,
                        audit_plan: auditPlan && auditPlan.dispatch.length > 0 ? auditPlan.dispatch : undefined,
                        audit_verdict: auditVerdictSummary,
                        last_failure: {
                            attempt,
                            returncode: r.rc,
                            stdout_tail: r.stdout.slice(-500),
                            stderr_tail: `unresolved audit_roles: ${unresolved.join(", ")}`,
                        },
                    },
                    errorTail: `unresolved audit_roles: ${unresolved.join(", ")}`,
                };
            }
            return {
                result: {
                    name: phaseName,
                    status: "pass",
                    attempts: attempt,
                    duration_s: round2((Date.now() - started) / 1000),
                    log: logPath,
                    ...baseAuditFields,
                },
                errorTail,
            };
        }
        lastFailure = {
            attempt,
            returncode: r.rc,
            stdout_tail: r.stdout.slice(-500),
            stderr_tail: r.stderr.slice(-500),
        };
        if (r.stderr) errorTail = r.stderr.slice(-500);
    }
    return {
        result: {
            name: phaseName,
            status: "fail",
            attempts: maxAttempts,
            duration_s: round2((Date.now() - started) / 1000),
            log_dir: runDir,
            last_failure: lastFailure,
            ...baseAuditFields,
        },
        errorTail,
    };
}

/**
 * v0.6.0 (D2) — audit-role resolution check.
 *
 * If the gate phase declared `audit_roles: string[]`, every role must
 * resolve against the profile's bindings (typo + stale-reference
 * safety). Returns the list of unresolved roles; an empty array means
 * all declared roles are recognized.
 *
 * Real LLM-driven audit invocation remains the profile author's
 * responsibility — declared under `commands:`. This helper catches
 * declarative typos; it does not invoke the roles itself.
 */
export function resolveAuditRoles(
    declared: string[],
    resolvedBindings: Record<string, unknown> | undefined,
): string[] {
    if (declared.length === 0) return [];
    if (resolvedBindings === undefined) {
        return [...declared];
    }
    const known = new Set(Object.keys(resolvedBindings));
    return declared.filter((r) => !known.has(r));
}

interface RunCommandsResult {
    rc: number;
    stdout: string;
    stderr: string;
}

function runCommands(
    commands: string[],
    timeout: number,
    logPath: string,
    signal?: AbortSignal,
): Promise<RunCommandsResult> {
    return new Promise((resolve) => {
        const stream = fs.createWriteStream(logPath, { flags: "w" });
        let combinedOut = "";
        let combinedErr = "";
        let aborted = false;
        let currentChild: ReturnType<typeof exec> | null = null;
        let resolved = false;

        const abortHandler = () => {
            aborted = true;
            // child_process.exec exposes the underlying child via .kill; we
            // call it through `currentChild?.kill` indirectly by sending
            // SIGTERM to the process group. Node's promisify loses the child
            // handle, so we use the raw API for the abort path. See below.
            if (currentChild) currentChild.kill("SIGTERM");
        };
        signal?.addEventListener("abort", abortHandler, { once: true });

        // All resolve paths funnel through here so the write stream is
        // fully closed before the promise resolves. Resolving while
        // `stream.end()` is still flushing lets the test runner tear down
        // the tempdir mid-flush, surfacing as "asynchronous activity after
        // the test ended" with ENOENT on the log file.
        const finishAndResolve = (result: RunCommandsResult): void => {
            if (resolved) return;
            resolved = true;
            signal?.removeEventListener("abort", abortHandler);
            if (stream.writableEnded) {
                resolve(result);
            } else {
                stream.end(() => resolve(result));
            }
        };

        // Non-destructive iteration: each retry of a failing phase must run
        // every command — not just the ones after the previously-shifted index.
        // (Phase `commands` are reused across attempts.)
        let index = 0;

        const runNext = async (): Promise<void> => {
            if (aborted) {
                finishAndResolve({ rc: 130, stdout: combinedOut, stderr: combinedErr + "\naborted" });
                return;
            }
            if (index >= commands.length) {
                finishAndResolve({ rc: 0, stdout: combinedOut, stderr: combinedErr });
                return;
            }
            const cmd = commands[index++]!;
            stream.write(`\n$ ${cmd}\n`);
            try {
                const cp = exec(cmd, {
                    timeout: timeout * 1000,
                        // Mirror Python: executable=os.environ.get("SHELL")
                    shell: process.env.SHELL ?? "/bin/sh",
                }) as ReturnType<typeof exec> & { kill: (sig?: string) => void };
                currentChild = cp;
                const stdoutChunks: Buffer[] = [];
                const stderrChunks: Buffer[] = [];
                cp.stdout?.on("data", (b: Buffer) => {
                    stdoutChunks.push(b);
                    stream.write(b);
                });
                cp.stderr?.on("data", (b: Buffer) => {
                    stderrChunks.push(b);
                    stream.write(b);
                });
                cp.on("close", (code: number | null) => {
                    currentChild = null;
                    if (aborted) {
                        finishAndResolve({ rc: 130, stdout: combinedOut, stderr: combinedErr + "\naborted" });
                        return;
                    }
                    combinedOut += Buffer.concat(stdoutChunks).toString("utf8");
                    combinedErr += Buffer.concat(stderrChunks).toString("utf8");
                    if (code !== 0) {
                        finishAndResolve({ rc: code ?? 1, stdout: combinedOut, stderr: combinedErr });
                        return;
                    }
                    void runNext();
                });
                cp.on("error", (err: Error) => {
                    currentChild = null;
                    combinedErr += `\nexec error: ${err.message}`;
                    finishAndResolve({ rc: 1, stdout: combinedOut, stderr: combinedErr });
                });
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                combinedErr += `\nexec threw: ${msg}`;
                finishAndResolve({ rc: 1, stdout: combinedOut, stderr: combinedErr });
            }
        };

        void runNext();
    });
}

// ─────────────────────────────────────────────────────────────────────
// CLI wrapper (preserved for parity with the old `gate_runner.py` entry)
// ─────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
    const args = argv.slice(2);
    const opts = parseCliFlags(args);
    if (!opts.profilePath) {
        process.stderr.write("--profile is required\n");
        return 2;
    }
    const r = await runGate({
        profilePath: opts.profilePath,
        frameworkRoot: opts.frameworkRoot,
        phase: opts.phase ?? "all",
        logDir: opts.logDir ?? ".pi/rolecast-logs",
    });
    if (r.exitCode === 2) {
        process.stderr.write(`${r.errorTail}\n`);
        return 2;
    }
    process.stdout.write(`${JSON.stringify(r.summary, null, 2)}\n`);
    return r.exitCode;
}

interface ParsedFlags {
    profilePath?: string;
    frameworkRoot?: string;
    phase?: string;
    logDir?: string;
}

function parseCliFlags(args: string[]): ParsedFlags {
    const out: ParsedFlags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        switch (a) {
            case "--profile":
                out.profilePath = args[++i];
                break;
            case "--framework-root":
                out.frameworkRoot = args[++i];
                break;
            case "--phase":
                out.phase = args[++i];
                break;
            case "--log-dir":
                out.logDir = args[++i];
                break;
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers (kept local — tests of pull values belong in profile_loader tests)
// ─────────────────────────────────────────────────────────────────────

function formatTimestamp(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function emptySummary(profileName: string): GateSummary {
    return {
        profile: profileName,
        framework_version: "",
        phases: [],
        ok: false,
        exitCode: 2,
    };
}

// Internal structural types — keep loose to avoid coupling to
// profile_loader.ts internal type names. The Python module reads
// profile.gates[phase]["commands"|"timeout"] and
// profile.escalation.max_attempts/on_permanent_failure.
interface GateDef {
    commands?: string[];
    timeout?: number;
    /**
     * v0.6.0 (D2) — audit roles expected to verify this phase. Each
     * entry must resolve against `profile.resolved_bindings`. Real
     * invocation is delegated to the profile's `commands:` block (the
     * framework cannot dispatch sub-agents from the gate runner
     * itself). This field provides declarative + typo-safety surface.
     */
    audit_roles?: string[];
}

interface EscalationDef {
    max_attempts: number;
    on_permanent_failure: "stop" | "continue";
}

export const __testing = {
    formatTimestamp,
    runCommands,
};