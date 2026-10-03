import re
from pathlib import Path
from textwrap import dedent
import pytest

from scripts.profile_loader import load_profile, ProfileError

CORE_ROLES = {
    "orchestrator", "architect", "planner", "implementer", "tester",
    "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
}

def write_profile(tmp_path: Path, content: str) -> Path:
    p = tmp_path / ".pi" / "agent-workflow.yaml"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(dedent(content).lstrip())
    return p


def test_minimal_profile_loads(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: test
        description: minimal
        gates: {}
        bindings:
          architect:
            alias: opus-thinking-medium
            channels: [official]
    """)
    loaded = load_profile(profile)
    assert loaded.name == "test"
    assert loaded.framework_version == "0.1.0"
    assert "architect" in loaded.bindings


def test_missing_framework_version_errors(tmp_path):
    profile = write_profile(tmp_path, """
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    with pytest.raises(ProfileError, match="framework_version"):
        load_profile(profile)


def test_binding_key_must_be_known_role(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          not-a-real-role:
            alias: opus-thinking-medium
            channels: [official]
    """)
    with pytest.raises(ProfileError, match="not-a-real-role"):
        load_profile(profile)


def test_binding_key_can_be_custom_role(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          my-custom-role: {alias: opus-thinking-medium, channels: [official]}
        custom_roles:
          - name: my-custom-role
            description: d
            agent_file: .pi/agent-workflow-agents/m.md
            default_alias: opus-thinking-medium
            default_channels: [official]
            triggers: []
    """)
    loaded = load_profile(profile)
    assert "my-custom-role" in loaded.bindings


def test_trigger_collision_errors(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
          planner:   {alias: deepseek-verifiable, channels: [official]}
        custom_roles:
          - name: duplicate-trigger
            description: d
            agent_file: .pi/agent-workflow-agents/d.md
            default_alias: opus-thinking-medium
            default_channels: [official]
            triggers: ["design"]
    """)
    # "design" is a default architect trigger; duplicate-trigger collides.
    with pytest.raises(ProfileError, match="collision"):
        load_profile(profile)


def test_invalid_regex_in_forbidden_pattern_errors(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
        non_negotiables:
          forbidden_patterns:
            - pattern: '[unclosed'
              message: bad regex
    """)
    with pytest.raises(ProfileError, match="regex"):
        load_profile(profile)


def test_valid_regex_in_forbidden_pattern_passes(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
        non_negotiables:
          forbidden_patterns:
            - pattern: 'TODO'
              message: t
    """)
    loaded = load_profile(profile)
    assert loaded.non_negotiables.forbidden_patterns[0].pattern == "TODO"


from scripts.profile_loader import load_registry, Registry

@pytest.fixture(autouse=True)
def _isolate_user_global(monkeypatch, tmp_path):
    """Redirect user-global registry layer to tmp_path so tests do not read the
    developer's real `~/.pi/agent-workflow/registry-overrides.yaml`."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))


def test_load_registry_default_no_overrides(tmp_path):
    framework_root = tmp_path / "fw"
    (framework_root / "registry").mkdir(parents=True)
    (framework_root / "registry" / "built_in.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "built_in.yaml").read_text())
    (framework_root / "registry" / "aliases.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "aliases.yaml").read_text())
    reg = load_registry(framework_root)
    assert reg.has_model("claude-opus-5-5")
    resolved = reg.resolve_alias("opus-thinking-medium")
    assert resolved.model_id == "claude-opus-5-5"


def test_load_registry_user_global_override(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    framework_root = tmp_path / "fw"
    (framework_root / "registry").mkdir(parents=True)
    (framework_root / "registry" / "built_in.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "built_in.yaml").read_text())
    (framework_root / "registry" / "aliases.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "aliases.yaml").read_text())
    # user adds a withdrawn entry
    user_dir = tmp_path / ".pi" / "agent-workflow"
    user_dir.mkdir(parents=True)
    (user_dir / "registry-overrides.yaml").write_text("models:\n  - id: claude-opus-5-5\n    status: withdrawn\n")
    reg = load_registry(framework_root)
    with pytest.raises(Exception):
        reg.resolve_alias("opus-thinking-medium")


def test_withdrawn_model_does_not_resolve(tmp_path):
    framework_root = tmp_path / "fw"
    (framework_root / "registry").mkdir(parents=True)
    (framework_root / "registry" / "built_in.yaml").write_text("models:\n  - id: foo\n    vendor: v\n    capabilities: {}\n    channels: [{id: official, trust: trusted}]\n    status: withdrawn\n")
    (framework_root / "registry" / "aliases.yaml").write_text("aliases:\n  foo-alias:\n    preferred: foo\n    fallback_chain: []\n")
    reg = load_registry(framework_root)
    with pytest.raises(Exception, match="withdrawn"):
        reg.resolve_alias("foo-alias")


def test_unknown_alias_errors(tmp_path):
    framework_root = tmp_path / "fw"
    (framework_root / "registry").mkdir(parents=True)
    (framework_root / "registry" / "built_in.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "built_in.yaml").read_text())
    (framework_root / "registry" / "aliases.yaml").write_text((Path(__file__).resolve().parents[2] / "registry" / "aliases.yaml").read_text())
    reg = load_registry(framework_root)
    with pytest.raises(Exception, match="unknown alias"):
        reg.resolve_alias("not-an-alias")


def test_load_profile_resolves_bindings(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    loaded = load_profile(profile)
    assert loaded.resolved_bindings["architect"].model_id == "claude-opus-5-5"
    assert loaded.resolved_bindings["architect"].channel_id == "official"


def test_load_profile_withdrawn_alias_errors(tmp_path, monkeypatch):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    # simulate withdrawn model by setting env-override that lives in user global
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    user_dir = tmp_path / ".pi" / "agent-workflow"
    user_dir.mkdir(parents=True)
    (user_dir / "registry-overrides.yaml").write_text("models:\n  - id: claude-opus-5-5\n    status: withdrawn\n")
    with pytest.raises(Exception):
        load_profile(profile, framework_root=Path(__file__).resolve().parents[2])


def test_channel_resolution_finds_first_match(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          reviewer: {alias: opus-thinking-medium, channels: [relay-default, official]}
    """)
    loaded = load_profile(profile)
    rb = loaded.resolved_bindings["reviewer"]
    # claude-opus-5-5 exposes [official, relay-default]; spec §6.4 step 4 picks the
    # first channel in preferred_model.channels present in binding.channels, so
    # official wins over the binding's own ordering.
    assert rb.model_id == "claude-opus-5-5"
    assert rb.channel_id == "official"


def test_channel_resolution_errors_when_no_channel_match(tmp_path):
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: deepseek-verifiable, channels: [relay-cc]}
    """)
    # deepseek-verifiable → deepseek-v4.1-flash which only has official.
    # Spec §6.4 step 5: error immediately on channel mismatch (no load-time
    # fallback walk).
    with pytest.raises(ProfileError, match="no channel"):
        load_profile(profile)


def test_load_profile_surfaces_deprecation_warning(tmp_path, monkeypatch):
    # Override opus-thinking-medium's preferred model to deprecated.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / ".pi" / "agent-workflow").mkdir(parents=True)
    (tmp_path / "home" / ".pi" / "agent-workflow" / "registry-overrides.yaml").write_text(
        "models:\n  - id: claude-opus-5-5\n    status: deprecated\n")
    profile = write_profile(tmp_path, """
        framework_version: 0.1.0
        name: x
        description: x
        gates: {}
        bindings:
          architect: {alias: opus-thinking-medium, channels: [official]}
    """)
    loaded = load_profile(profile, framework_root=Path(__file__).resolve().parents[2])
    rb = loaded.resolved_bindings["architect"]
    assert rb.warning is not None
    assert "deprecated" in rb.warning
