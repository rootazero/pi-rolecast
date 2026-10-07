from pathlib import Path

# v0.2.0: roles live in role-packs/<group>/<role>.md and use full prefixed
# names (`<group>-<role>`).
#
# v0.7.0 (B-slot): the coding group split into a coding triad (architect /
# planner / coder) + tester, plus a five-role audit team (judge / countersign /
# notary / secretariat + mapper for context). Fixer is the finalization phase
# of a coder dispatch (ADR-0034). v0.7.0 also renamed the dispatcher (removed)
# and the diarist (replaces coding-docs).
#
# v0.8.0 (F-slot): the four legacy role-pack files
# (coding-{implementer,reviewer,docs,orchestrator}.md) were hard-deleted.
# The roster below is the only canonical source of truth for what should be
# on disk.
ROLE_PACKS_DIR = Path(__file__).resolve().parents[2] / "role-packs"
CODING_ROLES = [
    # core triad + tester
    "coding-architect", "coding-planner", "coding-coder", "coding-tester",
    # audit team
    "coding-judge", "coding-countersign", "coding-notary", "coding-secretariat",
    # context + finalization
    "coding-mapper", "coding-fixer", "coding-diarist",
    # reliability + observability
    "coding-profiler", "coding-auditor", "coding-canary",
]


def test_coding_role_pack_directory_exists():
    assert (ROLE_PACKS_DIR / "coding").is_dir(), \
        f"missing role-packs/coding/ at {ROLE_PACKS_DIR / 'coding'}"


def test_all_coding_role_files_exist():
    for role in CODING_ROLES:
        path = ROLE_PACKS_DIR / "coding" / f"{role}.md"
        assert path.is_file(), f"missing role file: {path}"


def test_each_agent_has_frontmatter():
    import re
    for role in CODING_ROLES:
        path = ROLE_PACKS_DIR / "coding" / f"{role}.md"
        content = path.read_text()
        m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
        assert m, f"{role}.md missing frontmatter"
        assert "name:" in m.group(1), f"{role}.md frontmatter missing name"
        assert "description:" in m.group(1), f"{role}.md frontmatter missing description"
        assert "category: coding" in m.group(1), \
            f"{role}.md frontmatter missing category: coding"


def test_each_agent_name_matches_filename():
    import re
    for role in CODING_ROLES:
        path = ROLE_PACKS_DIR / "coding" / f"{role}.md"
        content = path.read_text()
        m = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
        assert f"name: {role}" in m.group(1), \
            f"{role}.md name mismatch (expected 'name: {role}')"


def test_no_role_agent_mentions_rust_specifically():
    # Spec §4: framework ships zero language-specific defaults.
    for role in CODING_ROLES:
        path = ROLE_PACKS_DIR / "coding" / f"{role}.md"
        content = path.read_text().lower()
        # Allow references like "language-specific" but forbid cargo / #[allow(...)].
        assert "cargo " not in content, f"{role}.md references 'cargo' (Rust-specific)"
        assert "#[allow" not in content, f"{role}.md references #[allow(...)] (Rust-specific)"


def test_legacy_agents_dir_does_not_exist():
    """v0.2.0 removes the legacy agents/ directory; role-packs/ is the source of truth."""
    legacy = Path(__file__).resolve().parents[2] / "agents"
    assert not legacy.exists(), \
        f"legacy {legacy} should have been removed in v0.2.0 (role-packs/ is canonical)"
