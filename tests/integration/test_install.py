import os
import subprocess
from pathlib import Path

INSTALL_SH = Path(__file__).resolve().parents[2] / "scripts" / "install.sh"
EXAMPLE_PROFILE = Path(__file__).resolve().parents[2] / "examples" / "rust" / "profile.yaml"


def test_install_creates_framework_dir_and_symlinks(tmp_path):
    """v0.2.0: install creates per-role symlinks at agents/<group>-<role>.md
    for every role in role-packs/. v0.2.3: no longer creates the global
    ~/.pi/agent/pi-rolecast framework symlink (npm install path is canonical)."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    # v0.2.3: no global pi-rolecast framework symlink created. Use npm path.
    assert not (prefix / "pi-rolecast").exists(), \
        f"unexpected pi-rolecast symlink: {prefix / 'pi-rolecast'}"
    # v0.2.0+ prefixed symlinks under agents/<group>-<role>.md
    for role in ["coding-orchestrator", "coding-architect", "coding-planner",
                 "coding-implementer", "coding-tester", "coding-reviewer",
                 "coding-mapper", "coding-profiler", "coding-auditor",
                 "coding-canary", "coding-docs"]:
        link = prefix / "agents" / f"{role}.md"
        assert link.is_symlink(), f"missing symlink for {role}: {link}"
        target = link.resolve()
        assert target == (fw_root / "role-packs" / "coding" / f"{role}.md").resolve(), \
            f"wrong target for {role}: {target}"
    # Only prefixed symlinks exist (no legacy compat shims; pi-rolecast is
    # the canonical naming convention going forward).


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
    assert not (prefix / "pi-rolecast").exists()


def test_install_syncs_profile_bindings_when_present(tmp_path):
    """When cwd has a profile, install.sh auto-runs sync_settings.py."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    profile_dir = project_dir / ".pi"
    profile_dir.mkdir()
    # v0.2.0 fixture uses new filename
    profile_dir.joinpath("rolecast.yaml").write_text(EXAMPLE_PROFILE.read_text())

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
    assert "found ./.pi/rolecast.yaml" in result.stdout
    assert "synced" in result.stdout
    assert ".pi/agents" in result.stdout


def test_install_accepts_legacy_profile_filename(tmp_path):
    """v0.2.0 still accepts legacy .pi/agent-workflow.yaml (with stderr warning)."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    profile_dir = project_dir / ".pi"
    profile_dir.mkdir()
    profile_dir.joinpath("agent-workflow.yaml").write_text(EXAMPLE_PROFILE.read_text())

    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    home = tmp_path / "home"
    home.mkdir()
    (home / ".pi" / "agent").mkdir(parents=True)

    env = os.environ.copy()
    env["HOME"] = str(home)

    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        cwd=str(project_dir), env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "found ./.pi/agent-workflow.yaml" in result.stdout
    assert "warning:" in result.stdout
    assert "rename to .pi/rolecast.yaml" in result.stdout


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
    assert "found ./.pi/rolecast.yaml" not in result.stdout
    assert "scaffold a profile" in result.stdout


def test_install_cleans_up_old_agent_role_directories(tmp_path):
    """Old layout (agent-<role>/SKILL.md) from prior installs should be removed."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
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
    assert (prefix / "agents" / "coding-orchestrator.md").is_symlink()


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


def test_install_removes_legacy_pi_agent_workflow_symlink(tmp_path):
    """v0.2.0 install removes the legacy ~/.pi/agent/pi-agent-workflow symlink."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw_root = Path(__file__).resolve().parents[2]
    # Simulate a prior v0.1.x install: legacy symlink points somewhere harmless.
    (prefix / "pi-agent-workflow").symlink_to(fw_root)
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "removing legacy" in result.stdout
    assert not (prefix / "pi-agent-workflow").exists()
    # v0.2.3: pi-rolecast framework symlink no longer created by install.
    assert not (prefix / "pi-rolecast").exists()


def test_install_warns_when_pi_subagents_missing(tmp_path):
    """If settings.json has no pi-subagents entry, install.sh warns role dispatch won't work."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    settings = prefix / "settings.json"
    # v0.2.0: package listed as pi-rolecast (or just non-subagents).
    settings.write_text('{"packages": ["npm:pi-rolecast"], "subagents": {}}')
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "pi-subagents not found" in result.stdout
    assert "pi install npm:@tintinweb/pi-subagents" in result.stdout


def test_install_no_warning_when_pi_subagents_present(tmp_path):
    """If settings.json already lists pi-subagents, no warning fires."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    settings = prefix / "settings.json"
    settings.write_text('{"packages": ["npm:pi-rolecast", "npm:@tintinweb/pi-subagents"], "subagents": {}}')
    fw_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["bash", str(INSTALL_SH), "--prefix", str(prefix),
         "--framework-root", str(fw_root), "--no-pip"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "pi-subagents not found" not in result.stdout
