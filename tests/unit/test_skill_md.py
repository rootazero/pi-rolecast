from pathlib import Path

SKILL_MD = Path(__file__).resolve().parents[2] / "SKILL.md"


def test_skill_md_exists():
    assert SKILL_MD.is_file()


def test_skill_md_has_frontmatter():
    content = SKILL_MD.read_text()
    assert content.startswith("---\n")
    assert "name:" in content.split("\n---\n", 1)[0]


def test_skill_md_under_200_lines():
    # Spec §14 acceptance criterion 8.
    line_count = len(SKILL_MD.read_text().splitlines())
    assert line_count <= 200, f"SKILL.md is {line_count} lines (>200)"


def test_skill_md_references_directory():
    content = SKILL_MD.read_text()
    for ref in [
        "profile-schema", "registry-resolution", "gate-runner-usage",
        "scaffolder-usage", "migration-from-rust-agent-workflow",
    ]:
        assert ref in content, f"SKILL.md does not reference {ref}"
