import os
import subprocess
import sys
from pathlib import Path

INSTALL_SH = Path(__file__).resolve().parents[2] / "scripts" / "install.sh"


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
        link = prefix / f"agent-{role}" / "SKILL.md"
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
