import os
import subprocess
from pathlib import Path

INSTALL_SH = Path(__file__).resolve().parents[2] / "scripts" / "install.sh"
EXAMPLE_PROFILE = Path(__file__).resolve().parents[2] / "examples" / "rust" / "profile.yaml"


def test_install_creates_framework_dir_and_symlinks(tmp_path):
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert (prefix / "pi-agent-workflow").exists()
    for role in ["orchestrator", "architect", "planner", "implementer",
                 "tester", "reviewer", "mapper", "profiler", "auditor",
                 "canary", "docs"]:
        # NEW LAYOUT: <prefix>/agents/<role>.md (location read by pi-subagents)
        link = prefix / "agents" / f"{role}.md"
        assert link.is_symlink(), f"missing symlink for {role}: {link}"
        target = link.resolve()
        assert target == (fw_root / "agents" / f"{role}.md").resolve(), \
            f"wrong target for {role}: {target}"


def test_install_dry_run_does_not_write(tmp_path):
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix), "--dry-run",
         "--framework-root", str(fw_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert not (prefix / "pi-agent-workflow").exists()


def test_install_syncs_profile_bindings_when_present(tmp_path):
    """When cwd has a profile, install.sh auto-runs sync_settings.py."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    profile_dir = project_dir / ".pi"
    profile_dir.mkdir()
    profile_dir.joinpath("agent-workflow.yaml").write_text(
        EXAMPLE_PROFILE.read_text()
    )

    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    home = tmp_path / "home"
    home.mkdir()
    agent_dir = home / ".pi" / "agent"
    agent_dir.mkdir(parents=True)

    env = os.environ.copy()
    env["HOME"] = str(home)

    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        cwd=str(project_dir), env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "found .pi/agent-workflow.yaml" in result.stdout
    assert "synced" in result.stdout
    # New behaviour: project-local agent files should also be written
    assert ".pi/agents" in result.stdout


def test_install_no_sync_when_no_profile(tmp_path):
    """When cwd has no profile, install.sh should not run sync_settings."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        cwd=str(project_dir), capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "found .pi/agent-workflow.yaml" not in result.stdout
    assert "scaffold a profile" in result.stdout


def test_install_cleans_up_old_agent_role_directories(tmp_path):
    """Old layout (agent-<role>/SKILL.md) from prior installs should be removed."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    # Simulate a prior install with old layout
    for role in ["orchestrator", "architect", "planner"]:
        (prefix / f"agent-{role}").mkdir()
        (prefix / f"agent-{role}" / "SKILL.md").write_text("dummy")
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    for role in ["orchestrator", "architect", "planner"]:
        assert not (prefix / f"agent-{role}").exists(), \
            f"old agent-{role}/ dir not removed"
    # And the new layout is in place
    assert (prefix / "agents" / "orchestrator.md").is_symlink()


def test_install_keep_old_layout_preserves_existing(tmp_path):
    """--keep-old-layout skips removal of agent-<role>/ directories."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    (prefix / "agent-orchestrator").mkdir()
    (prefix / "agent-orchestrator" / "SKILL.md").write_text("dummy")
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip", "--keep-old-layout"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert (prefix / "agent-orchestrator").exists()