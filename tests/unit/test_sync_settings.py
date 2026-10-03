"""Tests for scripts/sync_settings.py — bridge profile bindings to pi dispatch."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
SCRIPT = SCRIPTS / "sync_settings.py"
EXAMPLE_PROFILE = Path(__file__).resolve().parents[2] / "examples" / "rust" / "profile.yaml"


def _run(args, tmp_settings):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(tmp_settings), *args],
        capture_output=True, text=True,
    )


@pytest.fixture
def tmp_settings(tmp_path):
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"subagents": {"agentOverrides": {}}}))
    return p


def test_help_exits_0():
    r = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
    assert r.returncode == 0
    assert "profile" in r.stdout.lower()


def test_sync_writes_role_overrides(tmp_settings):
    r = _run([], tmp_settings)
    assert r.returncode == 0, r.stderr
    data = json.loads(tmp_settings.read_text())
    overrides = data["subagents"]["agentOverrides"]
    assert len(overrides) == 11
    assert overrides["architect"]["model"] == "MiniMax-M3"
    assert overrides["architect"]["channel"] == "official"
    assert overrides["tester"]["model"] == "deepseek-flash"
    assert overrides["orchestrator"]["model"] == "gpt-6.1-sol"


def test_sync_dry_run_does_not_write(tmp_settings):
    original = tmp_settings.read_text()
    r = _run(["--dry-run"], tmp_settings)
    assert r.returncode == 0
    assert tmp_settings.read_text() == original
    assert "MiniMax-M3" in r.stdout


def test_sync_preserves_non_framework_overrides(tmp_settings):
    tmp_settings.write_text(json.dumps({
        "subagents": {"agentOverrides": {
            "other-extension-role": {"model": "some-model", "channel": "x"},
        }}
    }))
    r = _run([], tmp_settings)
    assert r.returncode == 0
    data = json.loads(tmp_settings.read_text())
    overrides = data["subagents"]["agentOverrides"]
    assert "other-extension-role" in overrides
    assert "architect" in overrides


def test_clear_removes_framework_roles_keeps_others(tmp_settings):
    tmp_settings.write_text(json.dumps({
        "subagents": {"agentOverrides": {
            "architect": {"model": "x", "channel": "y"},
            "reviewer": {"model": "z", "channel": "y"},
            "custom-role": {"model": "w", "channel": "y"},
        }}
    }))
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--clear", "--settings", str(tmp_settings)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    data = json.loads(tmp_settings.read_text())
    overrides = data["subagents"]["agentOverrides"]
    assert "architect" not in overrides
    assert "reviewer" not in overrides
    assert "custom-role" in overrides


def test_missing_profile_returns_error(tmp_path):
    fake_profile = tmp_path / "no_such_profile.yaml"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(fake_profile),
         "--settings", str(settings)],
        capture_output=True, text=True,
    )
    assert r.returncode == 2
    assert "not found" in r.stderr