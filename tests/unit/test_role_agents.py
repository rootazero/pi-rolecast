from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parents[2] / "agents"
CORE_ROLES = [
    "orchestrator", "architect", "planner", "implementer", "tester",
    "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
]

def test_all_core_role_files_exist():
    for role in CORE_ROLES:
        assert (AGENTS_DIR / f"{role}.md").is_file(), f"missing agent: {role}.md"


def test_each_agent_has_frontmatter():
    import re
    for role in CORE_ROLES:
        content = (AGENTS_DIR / f"{role}.md").read_text()
        m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
        assert m, f"{role}.md missing frontmatter"
        assert "name:" in m.group(1), f"{role}.md frontmatter missing name"
        assert "description:" in m.group(1), f"{role}.md frontmatter missing description"


def test_each_agent_name_matches_filename():
    import re
    for role in CORE_ROLES:
        content = (AGENTS_DIR / f"{role}.md").read_text()
        m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
        assert f"name: {role}" in m.group(1), f"{role}.md name mismatch"


def test_no_role_agent_mentions_rust_specifically():
    # Spec §4: framework ships zero language-specific defaults.
    for role in CORE_ROLES:
        content = (AGENTS_DIR / f"{role}.md").read_text().lower()
        # Allow references like "language-specific" but forbid cargo / #[allow(...)].
        assert "cargo " not in content, f"{role}.md references 'cargo' (Rust-specific)"
        assert "#[allow" not in content, f"{role}.md references #[allow(...)] (Rust-specific)"
