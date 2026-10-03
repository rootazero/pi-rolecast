#!/usr/bin/env python3
"""Phase runner — executes profile gates in declared order, halts on failure.

Consumes:
- profile_loader.load_profile (validated Profile)
- profile.escalation (defaults: max_attempts=2, on_permanent_failure=stop)

Does NOT enforce non_negotiables — that's the reviewer's job (spec §8.4).

Exit codes:
- 0 — all requested phases passed
- 1 — one or more phases failed after retries
- 2 — config error (profile invalid, --phase unknown, etc)
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# Allow `python3 scripts/gate_runner.py` from the framework root.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from profile_loader import load_profile, ProfileError


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run profile gates in declared order.")
    p.add_argument("--profile", required=True, help="Path to agent-workflow.yaml")
    p.add_argument("--phase", default="all", help="Phase name or 'all'")
    p.add_argument("--log-dir", default=".pi/agent-workflow-logs",
                   help="Where to write per-phase logs")
    p.add_argument("--framework-root", default=None,
                   help="Framework root for registry resolution")
    return p.parse_args()


def load(args: argparse.Namespace):
    try:
        return load_profile(
            args.profile,
            framework_root=args.framework_root or str(Path(__file__).resolve().parent.parent),
        )
    except ProfileError as e:
        die(2, f"profile error: {e}")


def die(code: int, message: str) -> None:
    print(message, file=sys.stderr)
    sys.exit(code)


def main() -> int:
    args = parse_args()
    profile = load(args)
    log_dir = Path(args.log_dir).resolve()
    run_dir = log_dir / time.strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    phases = list(profile.gates.keys())
    if args.phase != "all":
        if args.phase not in phases:
            die(2, f"unknown phase '{args.phase}'; declared phases: {phases}")
        phases = [args.phase]

    summary = run_phases(profile, phases, run_dir)
    print(json.dumps(summary, indent=2))

    failed = [p for p in summary["phases"] if p["status"] == "fail"]
    return 1 if failed else 0


def run_phases(profile, phases: list[str], run_dir: Path) -> dict[str, Any]:
    out: dict[str, Any] = {
        "profile": str(profile.name),
        "framework_version": profile.framework_version,
        "phases": [],
    }
    halt = False
    for phase_name in phases:
        if halt:
            out["phases"].append({"name": phase_name, "status": "skipped",
                                  "reason": "previous phase failed permanently"})
            continue
        result = run_phase(profile, phase_name, run_dir)
        out["phases"].append(result)
        if result["status"] == "fail":
            if profile.escalation.on_permanent_failure == "stop":
                halt = True
    return out


def run_phase(profile, phase_name: str, run_dir: Path) -> dict[str, Any]:
    phase = profile.gates[phase_name]
    commands = phase.get("commands", [])
    timeout = int(phase.get("timeout", 300))
    max_attempts = max(1, profile.escalation.max_attempts)
    started = time.time()

    last_failure: dict[str, Any] | None = None
    for attempt in range(1, max_attempts + 1):
        attempt_log = run_dir / f"{phase_name}-attempt{attempt}.log"
        attempt_log.parent.mkdir(parents=True, exist_ok=True)
        rc, stdout, stderr = run_commands(commands, timeout, attempt_log)
        if rc == 0:
            return {
                "name": phase_name, "status": "pass",
                "attempts": attempt, "duration_s": round(time.time() - started, 2),
                "log": str(attempt_log),
            }
        last_failure = {
            "attempt": attempt, "returncode": rc,
            "stdout_tail": stdout[-500:], "stderr_tail": stderr[-500:],
        }

    return {
        "name": phase_name, "status": "fail",
        "attempts": max_attempts, "duration_s": round(time.time() - started, 2),
        "log_dir": str(run_dir),
        "last_failure": last_failure,
    }


def run_commands(commands: list[str], timeout: int, log_path: Path) -> tuple[int, str, str]:
    """Run commands sequentially; aggregate stdout/stderr. Returns
    (rc, combined_stdout, combined_stderr). rc=0 iff all commands exit 0."""
    combined_out: list[str] = []
    combined_err: list[str] = []
    with log_path.open("w") as logf:
        for cmd in commands:
            logf.write(f"\n$ {cmd}\n")
            logf.flush()
            try:
                cp = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True,
                    timeout=timeout, executable=os.environ.get("SHELL", "/bin/sh"),
                )
            except subprocess.TimeoutExpired as e:
                combined_err.append(f"TIMEOUT after {timeout}s: {cmd}")
                logf.write(f"TIMEOUT after {timeout}s\n")
                return 124, "\n".join(combined_out), "\n".join(combined_err + [str(e)])
            logf.write(cp.stdout)
            logf.write(cp.stderr)
            combined_out.append(cp.stdout)
            combined_err.append(cp.stderr)
            if cp.returncode != 0:
                return cp.returncode, "\n".join(combined_out), "\n".join(combined_err)
    return 0, "\n".join(combined_out), "\n".join(combined_err)


if __name__ == "__main__":
    sys.exit(main())
