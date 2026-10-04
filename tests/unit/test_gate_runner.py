import json
import os
import subprocess
import sys
from pathlib import Path

GATE_RUNNER = Path(__file__).resolve().parents[2] / "scripts" / "gate_runner.py"


def run_gate_runner(profile_yaml: str, *args: str) -> subprocess.CompletedProcess:
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "p.yaml"
        p.write_text(profile_yaml)
        return subprocess.run(
            [sys.executable, str(GATE_RUNNER), "--profile", str(p), *args],
            capture_output=True, text=True,
        )


def test_gate_runner_runs_all_phases_in_order():
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    gates:
      a: {commands: ["true"]}
      b: {commands: ["true"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "all")
    assert result.returncode == 0
    summary = json.loads(result.stdout)
    assert [p["name"] for p in summary["phases"]] == ["a", "b"]
    assert all(p["status"] == "pass" for p in summary["phases"])


def test_gate_runner_failing_command_returns_1():
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    gates:
      a: {commands: ["true"]}
      b: {commands: ["false"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "all")
    assert result.returncode == 1
    summary = json.loads(result.stdout)
    statuses = {p["name"]: p["status"] for p in summary["phases"]}
    assert statuses["a"] == "pass"
    assert statuses["b"] == "fail"


def test_gate_runner_unknown_phase_returns_2():
    # Spec §5.3 rule 4: missing phase = no-op (skip), but explicit
    # --phase <undeclared> must be an error (Review Focus #4).
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    gates:
      a: {commands: ["true"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "z")
    assert result.returncode == 2
    assert "z" in result.stderr


def test_gate_runner_missing_profile_returns_2():
    result = subprocess.run(
        [sys.executable, str(GATE_RUNNER), "--profile", "/nonexistent.yaml"],
        capture_output=True, text=True,
    )
    assert result.returncode == 2


def test_gate_runner_runs_single_phase():
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    gates:
      a: {commands: ["true"]}
      b: {commands: ["false"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "a")
    assert result.returncode == 0
    summary = json.loads(result.stdout)
    assert len(summary["phases"]) == 1
    assert summary["phases"][0]["name"] == "a"


def test_escalation_retries_until_max_attempts():
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    escalation:
      max_attempts: 3
      on_permanent_failure: stop
    gates:
      a: {commands: ["false"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "a")
    assert result.returncode == 1
    summary = json.loads(result.stdout)
    assert summary["phases"][0]["attempts"] == 3


def test_escalation_continue_keeps_going_after_failure():
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    escalation:
      max_attempts: 1
      on_permanent_failure: continue
    gates:
      a: {commands: ["false"]}
      b: {commands: ["true"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "all")
    assert result.returncode == 1
    summary = json.loads(result.stdout)
    assert summary["phases"][0]["status"] == "fail"
    assert summary["phases"][1]["status"] == "pass"


def test_escalation_default_is_stop():
    # Without explicit escalation, on_permanent_failure defaults to "stop".
    profile = """
    framework_version: 0.2.0
    name: ok
    description: ok
    workflow:
      role_groups: [coding]
    gates:
      a: {commands: ["false"]}
      b: {commands: ["true"]}
    bindings:
      coding-architect: {alias: opus-thinking-medium, channels: [official]}
    """
    result = run_gate_runner(profile, "--phase", "all")
    assert result.returncode == 1
    summary = json.loads(result.stdout)
    assert summary["phases"][0]["status"] == "fail"
    assert summary["phases"][1]["status"] == "skipped"
