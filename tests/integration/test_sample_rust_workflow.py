import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample-rust"
FRAMEWORK_ROOT = FIXTURE.parents[2]


@pytest.fixture(scope="module")
def rust_workspace(tmp_path_factory):
    """Copy the sample-rust fixture to a writable tmp dir so cargo can
    write target/. If cargo is not installed, skip the gate-runner test
    but keep the validate test."""
    work = tmp_path_factory.mktemp("rustws") / "sample-rust"
    shutil.copytree(FIXTURE, work)
    yield work
    shutil.rmtree(work, ignore_errors=True)


def test_validate_fixture_profile(rust_workspace):
    # v0.2.0: fixture uses .pi/rolecast.yaml.
    profile = rust_workspace / ".pi" / "rolecast.yaml"
    result = subprocess.run(
        [sys.executable, str(FRAMEWORK_ROOT / "scripts" / "scaffolder.py"),
         "validate", "--profile", str(profile),
         "--framework-root", str(FRAMEWORK_ROOT)],
        capture_output=True, text=True, cwd=str(rust_workspace),
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(shutil.which("cargo") is None, reason="cargo not installed")
def test_gate_runner_compile_passes(rust_workspace):
    profile = rust_workspace / ".pi" / "rolecast.yaml"
    result = subprocess.run(
        [sys.executable, str(FRAMEWORK_ROOT / "scripts" / "gate_runner.py"),
         "--profile", str(profile),
         "--phase", "compile",
         "--framework-root", str(FRAMEWORK_ROOT),
         "--log-dir", str(rust_workspace / "logs")],
        capture_output=True, text=True, cwd=str(rust_workspace),
    )
    assert result.returncode == 0, f"stdout: {result.stdout}\nstderr: {result.stderr}"
