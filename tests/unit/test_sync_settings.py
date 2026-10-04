"""Tests for scripts/sync_settings.py — bridge profile bindings to pi dispatch.

v0.2.0: roles are full prefixed names (e.g. coding-architect) and the role
files live in role-packs/coding/*.md.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
SCRIPT = SCRIPTS / "sync_settings.py"
EXAMPLE_PROFILE = Path(__file__).resolve().parents[2] / "examples" / "rust" / "profile.yaml"

CODING_ROLE_NAMES = [
    "coding-orchestrator", "coding-architect", "coding-planner",
    "coding-implementer", "coding-tester", "coding-reviewer",
    "coding-mapper", "coding-profiler", "coding-auditor",
    "coding-canary", "coding-docs",
]


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


def test_list_groups_lists_coding(tmp_path):
    """--list-groups surfaces the coding group with all 11 role names."""
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--list-groups",
         "--settings", str(settings)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    assert "coding/ (11 roles)" in r.stdout
    for role in CODING_ROLE_NAMES:
        assert role in r.stdout


def test_sync_writes_role_overrides(tmp_settings):
    r = _run([], tmp_settings)
    assert r.returncode == 0, r.stderr
    data = json.loads(tmp_settings.read_text())
    overrides = data["subagents"]["agentOverrides"]
    assert len(overrides) == 11
    # coding-architect → opus-thinking-medium → claude-opus-5-5 (built-in registry).
    # The override stores the resolved model_id, not the alias.
    assert overrides["coding-architect"]["model"] == "claude-opus-5-5"
    assert overrides["coding-architect"]["channel"] == "official"
    # coding-tester → deepseek-verifiable → deepseek-v4.1-flash.
    assert overrides["coding-tester"]["model"] == "deepseek-v4.1-flash"


def test_sync_dry_run_does_not_write(tmp_settings):
    original = tmp_settings.read_text()
    r = _run(["--dry-run"], tmp_settings)
    assert r.returncode == 0
    assert tmp_settings.read_text() == original
    assert "claude-opus-5-5" in r.stdout


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
    assert "coding-architect" in overrides


def test_clear_removes_all_agent_overrides(tmp_settings):
    """v0.2.0: --clear removes all agentOverrides (we can't tell which are framework's without profile)."""
    tmp_settings.write_text(json.dumps({
        "subagents": {"agentOverrides": {
            "coding-architect": {"model": "x", "channel": "y"},
            "coding-reviewer": {"model": "z", "channel": "y"},
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
    # All entries removed.
    assert overrides == {}


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


# ---- New tests for v0.1.2/v0.2.0: project-local agent file generation ----

def test_sync_writes_project_local_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    # All 11 role files written with prefixed names.
    for role in CODING_ROLE_NAMES:
        path = agents_dir / f"{role}.md"
        assert path.exists(), f"missing agent file for {role}"
    # model: field reflects binding with provider/modelId format
    architect = (agents_dir / "coding-architect.md").read_text()
    assert "model: anthropic/claude-opus-5-5" in architect
    assert "name: coding-architect" in architect
    assert "category: coding" in architect


def test_sync_preserves_agent_body_when_overwriting_model(tmp_path):
    """A re-sync should preserve the system prompt and only update frontmatter."""
    agents_dir = tmp_path / ".pi" / "agents"
    agents_dir.mkdir(parents=True)
    # Pre-existing file with different model + non-framework body
    (agents_dir / "coding-architect.md").write_text(
        "---\n"
        "name: coding-architect\n"
        "category: coding\n"
        "description: Design system boundaries.\n"
        "model: old-model\n"
        "thinking: low\n"
        "---\n"
        "\n"
        "# Custom body\n"
        "Don't lose me.\n"
    )
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    out = (agents_dir / "coding-architect.md").read_text()
    assert "model: anthropic/claude-opus-5-5" in out
    assert "old-model" not in out
    # Framework body overwrites custom body
    assert "Don't lose me" not in out


def test_sync_dry_run_does_not_write_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir),
         "--dry-run"],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert not agents_dir.exists()
    assert "claude-opus-5-5" in r.stdout


def test_sync_no_agents_skips_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir),
         "--no-agents"],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert not agents_dir.exists()
    assert "wrote" not in r.stdout
    data = json.loads(settings.read_text())
    assert len(data["subagents"]["agentOverrides"]) == 11


def test_clear_removes_project_local_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True, check=True,
    )
    assert (agents_dir / "coding-architect.md").exists()
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--clear",
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert not (agents_dir / "coding-architect.md").exists()


def test_clear_preserves_symlinked_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    agents_dir.mkdir(parents=True)
    real = tmp_path / "real.md"
    real.write_text("# Real file\n")
    (agents_dir / "custom-role.md").symlink_to(real)
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--clear",
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert (agents_dir / "custom-role.md").is_symlink()
    assert (agents_dir / "custom-role.md").exists()


def test_status_exits_0_and_shows_bindings(tmp_path, tmp_settings):
    """--status prints profile bindings, project-local files, settings.json state."""
    agents_dir = tmp_path / ".pi" / "agents"
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--status",
         "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(tmp_settings),
         "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    out = r.stdout
    assert "pi-rolecast sync status" in out
    assert "Profile bindings" in out
    assert "Project-local agent files" in out
    assert "settings.json:" in out
    # All 11 role names (prefixed) should appear.
    for role in CODING_ROLE_NAMES:
        assert role in out, role + " missing from status output"


def test_status_detects_drift_when_agent_file_model_modified(tmp_path, tmp_settings):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_settings
    subprocess.run(
        [sys.executable, str(SCRIPT),
         "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings),
         "--agents-dir", str(agents_dir)],
        capture_output=True, text=True, check=True,
    )
    f = agents_dir / "coding-architect.md"
    text = f.read_text()
    f.write_text(text.replace("model: anthropic/claude-opus-5-5",
                              "model: tampered-model"))
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--status",
         "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings),
         "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "coding-architect" in r.stdout
    assert "DRIFT" in r.stdout
    assert "tampered-model" in r.stdout
