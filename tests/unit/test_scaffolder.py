import os
from pathlib import Path
import subprocess
import sys

from scripts.scaffolder import detect_language, auto_detect_languages

SCAFFOLDER = Path(__file__).resolve().parents[2] / "scripts" / "scaffolder.py"


def touch(p: Path):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()


def test_detect_rust():
    p = Path(__file__).resolve().parents[2] / "_tmprust"
    touch(p / "Cargo.toml")
    try:
        assert detect_language(p) == "rust"
    finally:
        (p / "Cargo.toml").unlink()
        p.rmdir()


def test_detect_python_pyproject():
    p = Path(__file__).resolve().parents[2] / "_tmppy"
    touch(p / "pyproject.toml")
    try:
        assert detect_language(p) == "python"
    finally:
        (p / "pyproject.toml").unlink()
        p.rmdir()


def test_detect_typescript_requires_tsconfig():
    p = Path(__file__).resolve().parents[2] / "_tmpts"
    touch(p / "package.json")
    touch(p / "tsconfig.json")
    try:
        assert detect_language(p) == "typescript"
    finally:
        for f in ("package.json", "tsconfig.json"):
            (p / f).unlink()
        p.rmdir()


def test_detect_go():
    p = Path(__file__).resolve().parents[2] / "_tmpgo"
    touch(p / "go.mod")
    try:
        assert detect_language(p) == "go"
    finally:
        (p / "go.mod").unlink()
        p.rmdir()


def test_detect_none_returns_none():
    p = Path(__file__).resolve().parents[2] / "_tmpnone"
    p.mkdir()
    try:
        assert detect_language(p) is None
        assert auto_detect_languages(p) == []
    finally:
        p.rmdir()


def test_auto_detect_multiple_languages():
    # Multi-language project must surface all candidates; detect_language picks first by priority.
    p = Path(__file__).resolve().parents[1] / "_tmpmulti"
    touch(p / "Cargo.toml")
    touch(p / "pyproject.toml")
    try:
        langs = auto_detect_languages(p)
        assert "rust" in langs
        assert "python" in langs
        assert detect_language(p) == "rust"
    finally:
        for f in ("Cargo.toml", "pyproject.toml"):
            (p / f).unlink()
        p.rmdir()


def test_detect_typescript_no_tsconfig_returns_none():
    # package.json alone is ambiguous (TS or JS) — spec §9.2 says prompt.
    # detect_language returns None; auto_detect_languages surfaces both candidates.
    p = Path(__file__).resolve().parents[2] / "_tmppkgonly"
    touch(p / "package.json")
    try:
        assert detect_language(p) is None
        langs = auto_detect_languages(p)
        assert "typescript" in langs
        assert "javascript" in langs
    finally:
        (p / "package.json").unlink()
        p.rmdir()


def test_scaffolder_init_dry_run_does_not_write(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    touch(tmp_path / "Cargo.toml")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--dry-run"],
        capture_output=True, text=True, cwd=str(tmp_path),
        env={**os.environ, "PYTHONPATH": str(framework_root)},
    )
    assert result.returncode == 0
    assert "would create" in result.stdout.lower()
    assert not (tmp_path / ".pi" / "agent-workflow.yaml").exists()


def test_scaffolder_init_uses_template_rust(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    touch(tmp_path / "Cargo.toml")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--template", "rust",
         "--project-root", str(tmp_path), "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    written = (tmp_path / ".pi" / "agent-workflow.yaml").read_text()
    assert "cargo check" in written
    assert "bindings" in written


def test_scaffolder_init_uses_template_typescript(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    touch(tmp_path / "package.json")
    touch(tmp_path / "tsconfig.json")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--template", "typescript",
         "--project-root", str(tmp_path), "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    written = (tmp_path / ".pi" / "agent-workflow.yaml").read_text()
    assert "tsc" in written


def test_scaffolder_init_blank_template(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--blank",
         "--project-root", str(tmp_path), "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    written = (tmp_path / ".pi" / "agent-workflow.yaml").read_text()
    assert "bindings: {}" in written or "bindings: {}" in written.replace("\n", "")


def test_scaffolder_init_refuses_existing_without_force(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    touch(tmp_path / "Cargo.toml")
    (tmp_path / ".pi").mkdir()
    (tmp_path / ".pi" / "agent-workflow.yaml").write_text("framework_version: 0.1.0\n")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--template", "rust",
         "--project-root", str(tmp_path), "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "force" in result.stderr.lower()


def test_scaffolder_init_force_overwrites(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    touch(tmp_path / "Cargo.toml")
    (tmp_path / ".pi").mkdir()
    (tmp_path / ".pi" / "agent-workflow.yaml").write_text("old: true\n")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "init", "--template", "rust", "--force",
         "--project-root", str(tmp_path), "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "old: true" not in (tmp_path / ".pi" / "agent-workflow.yaml").read_text()


def test_scaffolder_validate_accepts_valid_profile(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    profile_yaml = """
    framework_version: 0.1.0
    name: x
    description: x
    gates: {}
    bindings:
      architect: {alias: opus-thinking-medium, channels: [official]}
    """
    p = tmp_path / "agent-workflow.yaml"
    p.write_text(profile_yaml)
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "validate", "--profile", str(p),
         "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "valid" in result.stdout.lower()


def test_scaffolder_validate_rejects_unknown_binding_key(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    profile_yaml = """
    framework_version: 0.1.0
    name: x
    description: x
    gates: {}
    bindings:
      not-a-role: {alias: opus-thinking-medium, channels: [official]}
    """
    p = tmp_path / "agent-workflow.yaml"
    p.write_text(profile_yaml)
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "validate", "--profile", str(p),
         "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "not-a-role" in result.stderr


def test_scaffolder_diff_reports_missing_fields(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    # Profile with framework_version=0.1.0 but missing fields added in 0.2.0.
    p = tmp_path / "agent-workflow.yaml"
    p.write_text("""
    framework_version: 0.1.0
    name: x
    description: x
    gates: {}
    bindings:
      architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    # Override framework_version to 0.2.0 in a fake schema registry for the test.
    # Simpler: write a stub framework with version 0.2.0 metadata.
    fake_root = tmp_path / "fakefw"
    (fake_root / "registry").mkdir(parents=True)
    (fake_root / "registry" / "built_in.yaml").write_text(
        (framework_root / "registry" / "built_in.yaml").read_text())
    (fake_root / "registry" / "aliases.yaml").write_text(
        (framework_root / "registry" / "aliases.yaml").read_text())
    # Mark the new-framework schema via a marker file.
    (fake_root / "framework-version").write_text("0.2.0")
    (fake_root / "added-fields.yaml").write_text("added: [escalation.preserve_logs, trigger_overrides]\n")
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "diff", "--profile", str(p),
         "--framework-root", str(fake_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0
    assert "missing" in result.stdout.lower()


def test_scaffolder_diff_requires_framework_version(tmp_path):
    framework_root = Path(__file__).resolve().parents[2]
    p = tmp_path / "agent-workflow.yaml"
    p.write_text("""
    name: x
    description: x
    gates: {}
    bindings:
      architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    # Review Focus #5: profile without framework_version must error in diff.
    result = subprocess.run(
        [sys.executable, str(SCAFFOLDER), "diff", "--profile", str(p),
         "--framework-root", str(framework_root)],
        capture_output=True, text=True,
    )
    assert result.returncode == 1
    assert "framework_version" in result.stderr.lower()
