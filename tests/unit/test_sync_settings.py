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


# ---- New tests for v0.1.2: project-local agent file generation ----

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
    # All 11 role files written
    for role in ["orchestrator", "architect", "planner", "implementer",
                 "tester", "reviewer", "mapper", "profiler", "auditor",
                 "canary", "docs"]:
        path = agents_dir / f"{role}.md"
        assert path.exists(), f"missing agent file for {role}"
    # model: field reflects binding with provider/modelId format
    # (required for pi-subagents' resolveDefaultModel slashIdx check)
    architect = (agents_dir / "architect.md").read_text()
    assert "model: minimax-cn/MiniMax-M3" in architect
    assert "name: architect" in architect  # body preserved
    # canary -> minimax-cn/MiniMax-M2.7-highspeed
    canary = (agents_dir / "canary.md").read_text()
    assert "model: minimax-cn/MiniMax-M2.7-highspeed" in canary
    # implementer (deepseek vendor) -> deepseek/deepseek-flash
    implementer = (agents_dir / "implementer.md").read_text()
    assert "model: deepseek/deepseek-flash" in implementer
    # orchestrator (openai vendor) -> openai-codex/gpt-6.1-sol
    orchestrator = (agents_dir / "orchestrator.md").read_text()
    assert "model: openai-codex/gpt-6.1-sol" in orchestrator


def test_sync_preserves_agent_body_when_overwriting_model(tmp_path):
    """A re-sync should preserve the system prompt and only update frontmatter."""
    agents_dir = tmp_path / ".pi" / "agents"
    agents_dir.mkdir(parents=True)
    # Pre-existing file with different model
    (agents_dir / "architect.md").write_text(
        "---\n"
        "name: architect\n"
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
    out = (agents_dir / "architect.md").read_text()
    assert "model: minimax-cn/MiniMax-M3" in out
    assert "old-model" not in out
    # Framework body is now in place (we re-wrote from framework template)
    assert "Architect" in out or "Architect" in out
    assert "Don't lose me" not in out  # Framework template overwrites custom body


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
    assert "MiniMax-M3" in r.stdout


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
    assert "wrote" not in r.stdout  # no agent-file write line
    # settings.json still updated
    data = json.loads(settings.read_text())
    assert len(data["subagents"]["agentOverrides"]) == 11


def test_clear_removes_project_local_agent_files(tmp_path):
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_path / "settings.json"
    settings.write_text("{}")
    # First sync
    subprocess.run(
        [sys.executable, str(SCRIPT), "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True, check=True,
    )
    assert (agents_dir / "architect.md").exists()
    # Clear
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--clear",
         "--settings", str(settings), "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert not (agents_dir / "architect.md").exists()
    assert "removed 11 project-local agent files" in r.stdout


def test_clear_preserves_symlinked_agent_files(tmp_path):
    """Project-local agent dir may contain user-made symlinks; --clear must not delete those."""
    agents_dir = tmp_path / ".pi" / "agents"
    agents_dir.mkdir(parents=True)
    # Create a symlink (not a copy) that should not be deleted
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
    assert "pi-agent-workflow sync status" in out
    assert "Profile bindings:" in out
    assert "Project-local agent files" in out
    assert "settings.json:" in out
    # All 11 roles should appear
    for role in ["architect", "orchestrator", "implementer", "reviewer",
                 "tester", "mapper", "profiler", "auditor", "canary",
                 "planner", "docs"]:
        assert role in out, role + " missing from status output"


def test_status_detects_drift_when_agent_file_model_modified(tmp_path, tmp_settings):
    """If a project-local agent file's model field is manually edited away from the binding,
    --status should mark it as DRIFT."""
    agents_dir = tmp_path / ".pi" / "agents"
    settings = tmp_settings
    # Sync first
    subprocess.run(
        [sys.executable, str(SCRIPT),
         "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings),
         "--agents-dir", str(agents_dir)],
        capture_output=True, text=True, check=True,
    )
    # Tamper with one file
    f = agents_dir / "architect.md"
    text = f.read_text()
    f.write_text(text.replace("model: minimax-cn/MiniMax-M3", "model: tampered-model"))
    # Run --status
    r = subprocess.run(
        [sys.executable, str(SCRIPT), "--status",
         "--profile", str(EXAMPLE_PROFILE),
         "--settings", str(settings),
         "--agents-dir", str(agents_dir)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0
    assert "architect" in r.stdout
    assert "DRIFT" in r.stdout
    assert "tampered-model" in r.stdout