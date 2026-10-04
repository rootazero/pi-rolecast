"""Tests for scripts/uninstall.sh.

v0.2.3: uninstall removes all framework artifacts while preserving
user-created files and non-framework extensions.
"""
import json
import os
import subprocess
from pathlib import Path

UNINSTALL_SH = Path(__file__).resolve().parents[2] / "scripts" / "uninstall.sh"
FW_ROOT = Path(__file__).resolve().parents[2]


def _run(args, cwd=None, env=None):
    return subprocess.run(
        ["bash", str(UNINSTALL_SH), "--framework-root", str(FW_ROOT), *args],
        capture_output=True, text=True, cwd=cwd, env=env,
    )


def test_uninstall_removes_framework_symlink(tmp_path):
    """Removes ~/.pi/agent/pi-rolecast framework symlink when target is pi-rolecast dir."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    fw = prefix / "pi-rolecast"
    fw.symlink_to(FW_ROOT)
    assert fw.is_symlink()

    result = _run(["--prefix", str(prefix),
                   "--global-agents-dir", str(prefix / "agents"),
                   "--project-agents-dir", str(tmp_path / "agents")],
                  cwd=str(tmp_path))

    assert result.returncode == 0, result.stderr
    assert not fw.exists(), f"framework symlink not removed: {fw}"


def test_uninstall_preserves_non_framework_symlink(tmp_path):
    """A pi-rolecast-named symlink pointing at a non-pi-rolecast path is NOT removed."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    user_link = prefix / "pi-rolecast"
    user_link.symlink_to(elsewhere)
    assert user_link.is_symlink()

    result = _run(["--prefix", str(prefix),
                   "--global-agents-dir", str(prefix / "agents"),
                   "--project-agents-dir", str(tmp_path / "agents")],
                  cwd=str(tmp_path))

    assert result.returncode == 0, result.stderr
    assert user_link.is_symlink(), "user-created pi-rolecast symlink wrongly removed"
    assert user_link.resolve() == elsewhere.resolve()


def test_uninstall_removes_global_agent_symlinks_pointing_at_framework(tmp_path):
    prefix = tmp_path / "agent"
    prefix.mkdir()
    agents = prefix / "agents"
    agents.mkdir()
    # Framework symlink
    fr1 = agents / "coding-architect.md"
    fr1.symlink_to(FW_ROOT / "role-packs" / "coding" / "coding-architect.md")
    fr2 = agents / "coding-tester.md"
    fr2.symlink_to(FW_ROOT / "role-packs" / "coding" / "coding-tester.md")
    # User symlink pointing elsewhere
    user_file = tmp_path / "my-custom-agent.md"
    user_file.write_text("# custom\n")
    user_link = agents / "custom.md"
    user_link.symlink_to(user_file)

    result = _run(["--prefix", str(prefix),
                   "--global-agents-dir", str(agents),
                   "--project-agents-dir", str(tmp_path / "agents-p")],
                  cwd=str(tmp_path))

    assert result.returncode == 0, result.stderr
    assert not fr1.exists(), "framework symlink fr1 not removed"
    assert not fr2.exists(), "framework symlink fr2 not removed"
    assert user_link.is_symlink(), "user-created symlink wrongly removed"
    assert user_link.resolve() == user_file.resolve()


def test_uninstall_removes_project_local_agent_files(tmp_path):
    """Project-local files matching framework role names are removed."""
    project = tmp_path / "project"
    project.mkdir()
    proj_agents = project / ".pi" / "agents"
    proj_agents.mkdir(parents=True)
    # 2 framework files + 1 user file
    fw1 = proj_agents / "coding-architect.md"
    fw1.write_text("---\nname: coding-architect\ncategory: coding\n---\nframework body\n")
    fw2 = proj_agents / "coding-tester.md"
    fw2.write_text("---\nname: coding-tester\ncategory: coding\n---\nframework body\n")
    user = proj_agents / "custom-role.md"
    user.write_text("---\nname: custom-role\n---\nuser body\n")

    result = _run(["--prefix", str(tmp_path / "agent"),
                   "--global-agents-dir", str(tmp_path / "agent" / "agents"),
                   "--project-agents-dir", str(proj_agents)],
                  cwd=str(project))

    assert result.returncode == 0, result.stderr
    assert not fw1.exists(), "framework file fw1 not removed"
    assert not fw2.exists(), "framework file fw2 not removed"
    assert user.exists(), "user file wrongly removed"


def test_uninstall_clears_settings_framework_overrides(tmp_path):
    """Removes framework role entries from settings.json subagents.agentOverrides,
    preserves non-framework entries."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    settings = prefix / "settings.json"
    settings.write_text(json.dumps({
        "subagents": {"agentOverrides": {
            "coding-architect": {"model": "x", "channel": "y"},
            "coding-tester":    {"model": "x", "channel": "y"},
            "custom-role":      {"model": "z", "channel": "w"},
        }},
    }))
    # Need project-local agent dir to exist for the find to enumerate framework roles
    proj_agents = tmp_path / ".pi" / "agents"
    proj_agents.mkdir(parents=True)

    result = _run(["--prefix", str(prefix),
                   "--global-agents-dir", str(prefix / "agents"),
                   "--project-agents-dir", str(proj_agents)],
                  cwd=str(tmp_path))

    assert result.returncode == 0, result.stderr
    data = json.loads(settings.read_text())
    overrides = data["subagents"]["agentOverrides"]
    assert "coding-architect" not in overrides
    assert "coding-tester" not in overrides
    assert "custom-role" in overrides, "non-framework entry wrongly removed"


def test_uninstall_dry_run_does_not_remove(tmp_path):
    prefix = tmp_path / "agent"
    prefix.mkdir()
    (prefix / "pi-rolecast").symlink_to(FW_ROOT)
    agents = prefix / "agents"
    agents.mkdir()
    fr = agents / "coding-architect.md"
    fr.symlink_to(FW_ROOT / "role-packs" / "coding" / "coding-architect.md")

    result = _run(["--prefix", str(prefix),
                   "--global-agents-dir", str(agents),
                   "--project-agents-dir", str(tmp_path / "agents-p"),
                   "--dry-run"],
                  cwd=str(tmp_path))

    assert result.returncode == 0, result.stderr
    assert (prefix / "pi-rolecast").exists(), "dry-run removed framework symlink"
    assert fr.exists(), "dry-run removed agent symlink"
    assert "would" in result.stdout


def test_uninstall_idempotent(tmp_path):
    """Second run is a no-op (does not error, reports 0 removals)."""
    prefix = tmp_path / "agent"
    prefix.mkdir()
    (prefix / "pi-rolecast").symlink_to(FW_ROOT)

    r1 = _run(["--prefix", str(prefix),
               "--global-agents-dir", str(prefix / "agents"),
               "--project-agents-dir", str(tmp_path / "agents-p")],
              cwd=str(tmp_path))
    assert r1.returncode == 0, r1.stderr

    r2 = _run(["--prefix", str(prefix),
               "--global-agents-dir", str(prefix / "agents"),
               "--project-agents-dir", str(tmp_path / "agents-p")],
              cwd=str(tmp_path))
    assert r2.returncode == 0, r2.stderr
    # First run removed 1 item, second run removed 0.
    assert "removed 1" in r1.stdout
    assert "removed 0" in r2.stdout


def test_uninstall_keep_project_agents_skips_project_cleanup(tmp_path):
    """--keep-project-agents preserves project-local files even if they match framework names."""
    project = tmp_path / "project"
    project.mkdir()
    proj_agents = project / ".pi" / "agents"
    proj_agents.mkdir(parents=True)
    fw = proj_agents / "coding-architect.md"
    fw.write_text("---\nname: coding-architect\n---\n")

    result = _run(["--prefix", str(tmp_path / "agent"),
                   "--global-agents-dir", str(tmp_path / "agent" / "agents"),
                   "--project-agents-dir", str(proj_agents),
                   "--keep-project-agents"],
                  cwd=str(project))

    assert result.returncode == 0, result.stderr
    assert fw.exists(), "project file removed despite --keep-project-agents"


def test_uninstall_warns_when_framework_root_missing(tmp_path, capsys):
    """When framework root is not findable, project cleanup is skipped with a warning."""
    project = tmp_path / "project"
    project.mkdir()
    proj_agents = project / ".pi" / "agents"
    proj_agents.mkdir(parents=True)
    fw = proj_agents / "coding-architect.md"
    fw.write_text("---\nname: coding-architect\n---\n")
    # HOME points to a path with no pi-rolecast npm install
    home = tmp_path / "empty-home"
    home.mkdir()
    env = os.environ.copy()
    env["HOME"] = str(home)

    # Bypass _run: this test must NOT pass --framework-root, so the
    # auto-discovery path triggers and finds nothing.
    result = subprocess.run(
        ["bash", str(UNINSTALL_SH),
         "--prefix", str(home / ".pi" / "agent"),
         "--global-agents-dir", str(home / ".pi" / "agent" / "agents"),
         "--project-agents-dir", str(proj_agents)],
        capture_output=True, text=True, cwd=str(project), env=env,
    )

    assert result.returncode == 0, result.stderr
    assert "framework root not found" in result.stderr
    assert fw.exists(), "project file removed despite missing framework root"
