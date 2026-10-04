#!/usr/bin/env python3
"""pi-rolecast/scripts/profile_loader.py

Load + validate a project-local rolecast profile.

Single source of truth for the profile schema. Consumed by:
- scripts/gate_runner.py (load_profile before phase execution)
- scripts/scaffolder.py validate (load_profile)
- scripts/scaffolder.py init (load_profile after writing new profile)
- scripts/sync_settings.py (load_profile + available_roles for dispatch)
- scripts/install.sh (indirectly via the Python helpers above)

v0.2.0 breaking changes:
  * Roles are now grouped (role-packs/<group>/<role>.md). Profile bindings
    use full names like `coding-architect` (hyphen-namespaced so pi-subagents'
    `@\\w-` mention regex accepts them).
  * Profile gains a top-level `workflow.role_groups: [list]` field that
    declares which groups are enabled. Only roles inside enabled groups
    can be bound.
  * Project-local profile filename changed from `.pi/agent-workflow.yaml`
    to `.pi/rolecast.yaml`. The legacy name is still recognised for one
    release as a deprecation aid.

Resolution rules (alias → model + channel) live in this module too.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import yaml

# Legacy constant retained only for migration messages. v0.2.0+ roles are
# discovered dynamically from role-packs/<group>/<role>.md.
LEGACY_CORE_ROLES = frozenset({
    "orchestrator", "architect", "planner", "implementer", "tester",
    "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
})

# Default role group shipped with the framework. Users can add more by
# dropping a directory under role-packs/.
DEFAULT_GROUP = "coding"

# Default triggers for the coding group. Keys are the full role name
# (`<group>-<role>`); values are the trigger phrases that route to that
# role via the orchestrator.
DEFAULT_TRIGGERS: dict[str, list[str]] = {
    "coding-architect":      ["design", "architect", "trait", "API design", "system design"],
    "coding-planner":        ["plan", "plan this change", "break this down"],
    "coding-implementer":    ["implement", "code", "do it", "make this change"],
    "coding-tester":         ["write tests", "test this", "add coverage"],
    "coding-reviewer":       ["review this diff", "review", "check this"],
    "coding-mapper":         ["map", "repo map", "what's in this repo"],
    "coding-profiler":       ["profile this", "this is slow", "why is X slow"],
    "coding-auditor":        ["audit", "audit security", "check for vulnerabilities",
                              "what could go wrong"],
    "coding-canary":         ["is the relay real", "which group answered", "canary check"],
    "coding-docs":           ["write README", "document this", "user-facing copy",
                              "frontend"],
    # coding-orchestrator is always-on, no phrase triggers
}


DEFAULT_FRAMEWORK_VERSION = "0.2.0"


class ProfileError(ValueError):
    """Raised when a profile fails validation."""


@dataclass
class ForbiddenPattern:
    pattern: str
    message: str
    compiled: re.Pattern

    @classmethod
    def from_dict(cls, d: dict) -> "ForbiddenPattern":
        if "pattern" not in d or "message" not in d:
            raise ProfileError("forbidden_pattern entry needs {pattern, message}")
        try:
            compiled = re.compile(d["pattern"])
        except re.error as e:
            raise ProfileError(f"forbidden_pattern regex invalid: {d['pattern']!r} ({e})") from e
        return cls(pattern=d["pattern"], message=d["message"], compiled=compiled)


@dataclass
class NonNegotiables:
    forbidden_patterns: list[ForbiddenPattern] = field(default_factory=list)
    scope_constraints: dict[str, Any] = field(default_factory=dict)
    required_gates: list[str] = field(default_factory=list)


@dataclass
class CustomRole:
    name: str
    description: str
    agent_file: str
    default_alias: str
    default_channels: list[str]
    triggers: list[str] = field(default_factory=list)


@dataclass
class Binding:
    alias: str
    channels: list[str]
    fallback_chain: list[str] = field(default_factory=list)
    role_group: str = ""
    role_name: str = ""


@dataclass
class WorkflowConfig:
    """Top-level `workflow:` block of a profile."""
    role_groups: list[str] = field(default_factory=list)


@dataclass
class Escalation:
    max_attempts: int = 2
    on_permanent_failure: str = "stop"   # stop | continue
    preserve_logs: bool = True


@dataclass
class RoleDef:
    """A role discovered from role-packs/<group>/<role>.md."""
    full_name: str           # e.g. "coding-architect"
    group: str               # e.g. "coding"
    role: str                # e.g. "architect" (the basename)
    description: str = ""
    triggers: list[str] = field(default_factory=list)
    requires: dict[str, Any] = field(default_factory=dict)
    preferences: dict[str, Any] = field(default_factory=dict)
    file_path: Path | None = None


@dataclass
class Profile:
    framework_version: str
    name: str
    description: str
    gates: dict[str, dict]
    bindings: dict[str, Binding]
    non_negotiables: NonNegotiables
    escalation: Escalation
    trigger_overrides: dict[str, dict]
    custom_roles: list[CustomRole]
    workflow: WorkflowConfig
    resolved_bindings: dict[str, ResolvedBinding] = field(default_factory=dict)

    @property
    def enabled_role_names(self) -> set[str]:
        """All role names available for binding under the enabled groups."""
        return {b for b in self.bindings}

    @property
    def custom_role_names(self) -> set[str]:
        return {r.name for r in self.custom_roles}


# ─────────────────────────────────────────────────────────────────────
# Role discovery from role-packs/<group>/<role>.md
# ─────────────────────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text: str) -> dict[str, Any]:
    """Parse YAML frontmatter into a dict.

    Supports nested blocks and inline lists so callers can express
    capability descriptors like:

        requires:
          reasoning_tier: high
          features: [thinking, tool_use]
        preferences:
          speed: medium
    """
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    block = m.group(1)
    loaded = yaml.safe_load(block) or {}
    if not isinstance(loaded, dict):
        return {}
    return loaded


def discover_role_packs(framework_root: str | Path) -> dict[str, list[RoleDef]]:
    """Walk role-packs/<group>/*.md and return {group_name: [RoleDef...]}."""
    root = Path(framework_root) / "role-packs"
    if not root.is_dir():
        return {}
    out: dict[str, list[RoleDef]] = {}
    for group_dir in sorted(root.iterdir()):
        if not group_dir.is_dir():
            continue
        group = group_dir.name
        roles: list[RoleDef] = []
        for md in sorted(group_dir.glob("*.md")):
            role = md.stem
            # Strip optional `<group>-` prefix from filename so users can
            # name files either `architect.md` or `coding-architect.md`.
            if role.startswith(f"{group}-"):
                role = role[len(group) + 1:]
            fm = _parse_frontmatter(md.read_text())
            full_name = (str(fm.get("name", "")).strip()
                         or f"{group}-{role}")
            desc = str(fm.get("description", "")).strip()
            requires_raw = fm.get("requires") or {}
            preferences_raw = fm.get("preferences") or {}
            requires = requires_raw if isinstance(requires_raw, dict) else {}
            preferences = preferences_raw if isinstance(preferences_raw, dict) else {}
            roles.append(RoleDef(
                full_name=full_name,
                group=group,
                role=role,
                description=desc,
                requires=dict(requires),
                preferences=dict(preferences),
                file_path=md,
            ))
        if roles:
            out[group] = roles
    return out


def available_roles(framework_root: str | Path,
                    groups: Iterable[str] | None = None) -> dict[str, RoleDef]:
    """Return {full_role_name: RoleDef} for the requested groups (or all
    groups if groups is None). The full role name format is
    `<group>-<role>` (hyphen-namespaced)."""
    packs = discover_role_packs(framework_root)
    out: dict[str, RoleDef] = {}
    target_groups = list(groups) if groups is not None else list(packs.keys())
    for g in target_groups:
        for rd in packs.get(g, []):
            out[rd.full_name] = rd
    return out


# ─────────────────────────────────────────────────────────────────────
# Loader entrypoint
# ─────────────────────────────────────────────────────────────────────

# v0.2.0 accepts both .pi/rolecast.yaml (new) and .pi/agent-workflow.yaml
# (legacy). The legacy form prints a deprecation hint but still loads.
LEGACY_PROFILE_FILENAMES = ("agent-workflow.yaml",)


def find_profile(cwd: str | Path = ".") -> Path | None:
    """Return the first existing profile in cwd, preferring the new name."""
    p = Path(cwd)
    new = p / ".pi" / "rolecast.yaml"
    if new.is_file():
        return new
    for legacy in LEGACY_PROFILE_FILENAMES:
        cand = p / ".pi" / legacy
        if cand.is_file():
            return cand
    return None


def load_profile(path: str | Path, *, framework_root: str | Path | None = None) -> Profile:
    p = Path(path)
    if not p.is_file():
        raise ProfileError(f"profile not found: {p}")
    raw = yaml.safe_load(p.read_text())
    if not isinstance(raw, dict):
        raise ProfileError(f"profile {p} is not a YAML mapping")
    root = Path(framework_root) if framework_root else Path(__file__).resolve().parent.parent
    profile = parse_profile(raw, framework_root=root)
    registry = load_registry(root)
    profile.resolved_bindings = resolve_bindings(profile, registry)
    return profile


def parse_profile(raw: dict, *, framework_root: str | Path | None = None) -> Profile:
    # Required fields
    fv = raw.get("framework_version")
    if not fv:
        raise ProfileError("profile.framework_version is required")
    name = raw.get("name")
    if not name:
        raise ProfileError("profile.name is required")
    description = raw.get("description")
    if not description:
        raise ProfileError("profile.description is required")

    gates = raw.get("gates") or {}
    if not isinstance(gates, dict):
        raise ProfileError("profile.gates must be a mapping")

    workflow = _parse_workflow(raw.get("workflow") or {})
    custom_roles = _parse_custom_roles(raw.get("custom_roles") or [])

    root = Path(framework_root) if framework_root else Path(__file__).resolve().parent.parent
    packs = available_roles(root, groups=workflow.role_groups)
    allowed_roles = set(packs.keys()) | {r.name for r in custom_roles}

    bindings = _parse_bindings(raw.get("bindings") or {}, allowed_roles, packs=packs)
    trigger_overrides = raw.get("trigger_overrides") or {}
    if not isinstance(trigger_overrides, dict):
        raise ProfileError("profile.trigger_overrides must be a mapping")
    non_negotiables = _parse_non_negotiables(raw.get("non_negotiables") or {})
    escalation = _parse_escalation(raw.get("escalation") or {})

    profile = Profile(
        framework_version=str(fv),
        name=str(name),
        description=str(description),
        gates=gates,
        bindings=bindings,
        non_negotiables=non_negotiables,
        escalation=escalation,
        trigger_overrides=trigger_overrides,
        custom_roles=custom_roles,
        workflow=workflow,
    )

    _check_trigger_collisions(profile, packs)
    return profile


# ─────────────────────────────────────────────────────────────────────
# Sub-parsers
# ─────────────────────────────────────────────────────────────────────

def _parse_workflow(raw: Any) -> WorkflowConfig:
    if not isinstance(raw, dict):
        raise ProfileError("profile.workflow must be a mapping")
    rg = raw.get("role_groups", [])
    if not isinstance(rg, list):
        raise ProfileError("workflow.role_groups must be a list of strings")
    bad = [g for g in rg if not isinstance(g, str) or not g]
    if bad:
        raise ProfileError(f"workflow.role_groups has non-string entries: {bad}")
    return WorkflowConfig(role_groups=list(rg))


def _parse_custom_roles(items: Iterable[Any]) -> list[CustomRole]:
    out: list[CustomRole] = []
    seen: set[str] = set()
    required = ("name", "description", "agent_file", "default_alias", "default_channels")
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise ProfileError(f"custom_roles[{i}] must be a mapping")
        missing = [k for k in required if k not in item]
        if missing:
            raise ProfileError(f"custom_roles[{i}] missing fields: {missing}")
        if item["name"] in seen:
            raise ProfileError(f"custom_roles[{i}].name duplicates {item['name']}")
        seen.add(item["name"])
        if not isinstance(item["default_channels"], list) or not item["default_channels"]:
            raise ProfileError(f"custom_roles[{i}].default_channels must be non-empty list")
        if not isinstance(item["triggers"], list):
            raise ProfileError(f"custom_roles[{i}].triggers must be a list")
        out.append(CustomRole(
            name=item["name"],
            description=item["description"],
            agent_file=item["agent_file"],
            default_alias=item["default_alias"],
            default_channels=list(item["default_channels"]),
            triggers=list(item["triggers"]),
        ))
    return out


def _parse_bindings(raw: dict, allowed_roles: set[str],
                    packs: dict[str, RoleDef] | None = None) -> dict[str, Binding]:
    if not isinstance(raw, dict):
        raise ProfileError("profile.bindings must be a mapping")
    out: dict[str, Binding] = {}
    for role, b in raw.items():
        if role not in allowed_roles:
            hint = ""
            if role in LEGACY_CORE_ROLES:
                hint = (f" (hint: '{role}' is a legacy coding role name; "
                        f"use 'coding-{role}' in v0.2.0+, and add "
                        f"`workflow.role_groups: [coding]` to your profile)")
            raise ProfileError(
                f"bindings key '{role}' is not in any enabled role group "
                f"and is not declared in custom_roles{hint}"
            )
        if not isinstance(b, dict):
            raise ProfileError(f"bindings.{role} must be a mapping")
        if "alias" not in b:
            raise ProfileError(f"bindings.{role}.alias is required")
        if "channels" not in b or not isinstance(b["channels"], list) or not b["channels"]:
            raise ProfileError(f"bindings.{role}.channels must be a non-empty list")
        fallback_chain = b.get("fallback_chain", [])
        if fallback_chain is None:
            fallback_chain = []
        if not isinstance(fallback_chain, list) or any(
                not isinstance(x, str) for x in fallback_chain):
            raise ProfileError(
                f"bindings.{role}.fallback_chain must be a list of model id strings"
            )
        rdef = packs.get(role) if packs else None
        out[role] = Binding(
            alias=b["alias"],
            channels=list(b["channels"]),
            fallback_chain=list(fallback_chain),
            role_group=rdef.group if rdef else "",
            role_name=rdef.role if rdef else "",
        )
    return out


def _parse_non_negotiables(raw: dict) -> NonNegotiables:
    if not isinstance(raw, dict):
        raise ProfileError("profile.non_negotiables must be a mapping")
    patterns = [ForbiddenPattern.from_dict(p) for p in raw.get("forbidden_patterns", [])]
    return NonNegotiables(
        forbidden_patterns=patterns,
        scope_constraints=dict(raw.get("scope_constraints", {}) or {}),
        required_gates=list(raw.get("required_gates", []) or []),
    )


def _parse_escalation(raw: dict) -> Escalation:
    if not isinstance(raw, dict):
        raise ProfileError("profile.escalation must be a mapping")
    opf = raw.get("on_permanent_failure", "stop")
    if opf not in {"stop", "continue"}:
        raise ProfileError("escalation.on_permanent_failure must be 'stop' or 'continue'")
    return Escalation(
        max_attempts=int(raw.get("max_attempts", 2)),
        on_permanent_failure=opf,
        preserve_logs=bool(raw.get("preserve_logs", True)),
    )


# ─────────────────────────────────────────────────────────────────────
# Trigger collision check
# ─────────────────────────────────────────────────────────────────────

def _check_trigger_collisions(profile: Profile,
                              packs: dict[str, RoleDef]) -> None:
    phrase_to_roles: dict[str, set[str]] = {}
    # Default triggers: ones we hardcode for the coding group + any custom
    # role triggers. We use the full prefixed name so collisions stay scoped.
    for full_name, phrases in DEFAULT_TRIGGERS.items():
        for p in phrases:
            phrase_to_roles.setdefault(p.lower(), set()).add(full_name)
    # Per-role triggers declared in role-packs/<group>/<role>.md frontmatter
    # (rare today but reserved for future-proofing).
    for rd in packs.values():
        for p in rd.triggers:
            phrase_to_roles.setdefault(p.lower(), set()).add(rd.full_name)
    for phrase, override in profile.trigger_overrides.items():
        target = override.get("role") if isinstance(override, dict) else None
        if not target:
            raise ProfileError(
                f"trigger_overrides['{phrase}'] must map to {{role: <role>}}"
            )
        if (target not in profile.bindings
                and target not in profile.custom_role_names):
            raise ProfileError(
                f"trigger_overrides['{phrase}'] targets unknown role '{target}'"
            )
        phrase_to_roles.setdefault(phrase.lower(), set()).add(target)
    for role in profile.custom_roles:
        for p in role.triggers:
            phrase_to_roles.setdefault(p.lower(), set()).add(role.name)

    collisions = {
        phrase: sorted(roles)
        for phrase, roles in phrase_to_roles.items()
        if len(roles) > 1
    }
    if collisions:
        msg = "\n".join(f"  '{p}' -> {r}" for p, r in collisions.items())
        raise ProfileError(f"trigger phrase collision:\n{msg}")


# ─────────────────────────────────────────────────────────────────────
# Registry + alias resolution
# ─────────────────────────────────────────────────────────────────────

@dataclass
class Model:
    id: str
    vendor: str
    capabilities: dict
    channels: list[dict]
    cost_tier: str
    status: str


@dataclass
class Alias:
    name: str
    preferred: str
    fallback_chain: list[str]
    notes: str = ""


@dataclass
class ResolvedModel:
    model_id: str
    channel_id: str
    trust: str
    via_fallback: bool = False
    warning: str | None = None


@dataclass
class ResolvedBinding:
    role: str
    alias: str
    model_id: str
    channel_id: str
    trust: str
    warning: str | None = None
    via_fallback: bool = False


class Registry:
    """Merged view of built-in + user-global + project-local registry layers."""

    def __init__(self, models: dict[str, Model], aliases: dict[str, Alias]):
        self._models = models
        self._aliases = aliases

    def has_model(self, model_id: str) -> bool:
        return model_id in self._models

    def get_model(self, model_id: str) -> Model:
        if model_id not in self._models:
            raise ProfileError(f"unknown model: {model_id}")
        return self._models[model_id]

    def resolve_alias(self, name: str) -> ResolvedModel:
        if name not in self._aliases:
            raise ProfileError(f"unknown alias: {name}")
        alias = self._aliases[name]
        m = self._models.get(alias.preferred)
        if m is None:
            raise ProfileError(
                f"alias '{name}' preferred model '{alias.preferred}' "
                f"not in merged registry"
            )
        if m.status == "withdrawn":
            raise ProfileError(
                f"alias '{name}' resolves to withdrawn model '{m.id}'"
            )
        ch = m.channels[0]
        warning = (
            f"alias '{name}' resolves to deprecated model '{m.id}' — "
            f"update profile to a stable alias"
            if m.status == "deprecated" else None
        )
        return ResolvedModel(
            model_id=m.id,
            channel_id=ch["id"],
            trust=ch["trust"],
            warning=warning,
        )


def load_registry(framework_root: str | Path) -> Registry:
    """Build a Registry by deep-merging three layers in priority order:
    built-in → user-global → project-local (later wins)."""
    root = Path(framework_root)
    builtin_models, builtin_aliases = _read_registry_pair(root / "registry")

    user_models, _ = _read_registry_pair(_user_global_dir() / "registry-overrides.yaml")
    _, user_aliases = _read_registry_pair(_user_global_dir() / "aliases-overrides.yaml")

    cwd = Path.cwd()
    proj_models, proj_aliases = _read_registry_pair(
        cwd / ".pi" / "rolecast-registry.yaml",
        default={"models": [], "aliases": {}},
    )

    merged_models = _merge_models(builtin_models, user_models, proj_models)
    merged_aliases = _merge_aliases(builtin_aliases, user_aliases, proj_aliases)
    return Registry(merged_models, merged_aliases)


def _user_global_dir() -> Path:
    return Path.home() / ".pi" / "rolecast"


def _read_registry_pair(path: Path, default: dict | None = None) -> tuple[list, dict]:
    if path.is_dir():
        builtin_p = path / "built_in.yaml"
        alias_p = path / "aliases.yaml"
        models = yaml.safe_load(builtin_p.read_text())["models"] if builtin_p.exists() else []
        aliases = yaml.safe_load(alias_p.read_text())["aliases"] if alias_p.exists() else {}
        return models, aliases
    if path.is_file():
        raw = yaml.safe_load(path.read_text()) or (default or {"models": [], "aliases": {}})
        return raw.get("models", []) or [], raw.get("aliases", {}) or {}
    return (default or {}).get("models", []) or [], (default or {}).get("aliases", {}) or {}


def _merge_models(*layers: list[dict]) -> dict[str, Model]:
    merged_raw: dict[str, dict] = {}
    for layer in layers:
        for m in layer:
            mid = m["id"]
            base = merged_raw.get(mid, {})
            merged_raw[mid] = {**base, **m}
    out: dict[str, Model] = {}
    for mid, m in merged_raw.items():
        out[mid] = Model(
            id=mid,
            vendor=m.get("vendor", ""),
            capabilities=m.get("capabilities", {}) or {},
            channels=list(m.get("channels", []) or []),
            cost_tier=m.get("cost_tier", ""),
            status=m.get("status", "stable"),
        )
    return out


def _merge_aliases(*layers: dict) -> dict[str, Alias]:
    merged_raw: dict[str, dict] = {}
    for layer in layers:
        for name, a in layer.items():
            base = merged_raw.get(name, {})
            merged_raw[name] = {**base, **a}
    out: dict[str, Alias] = {}
    for name, a in merged_raw.items():
        if "preferred" not in a:
            raise ProfileError(
                f"alias '{name}' missing required field 'preferred' after merge"
            )
        out[name] = Alias(
            name=name,
            preferred=a["preferred"],
            fallback_chain=list(a.get("fallback_chain", []) or []),
            notes=a.get("notes", "") or "",
        )
    return out


def resolve_bindings(profile: Profile, registry: Registry) -> dict[str, ResolvedBinding]:
    out: dict[str, ResolvedBinding] = {}
    for role, binding in profile.bindings.items():
        resolved = _resolve_binding(role, binding, registry)
        out[role] = resolved
    return out


def _resolve_binding(role: str, binding: Binding, registry: Registry) -> ResolvedBinding:
    try:
        primary = registry.resolve_alias(binding.alias)
    except ProfileError as e:
        raise ProfileError(f"bindings.{role}: {e}") from e
    primary_model = registry.get_model(primary.model_id)
    for ch in primary_model.channels:
        if ch["id"] in binding.channels:
            return ResolvedBinding(
                role=role, alias=binding.alias,
                model_id=primary_model.id, channel_id=ch["id"],
                trust=ch["trust"], warning=primary.warning,
            )
    available = [ch["id"] for ch in primary_model.channels]
    raise ProfileError(
        f"bindings.{role}: no channel in {binding.channels} is available "
        f"for preferred model '{primary_model.id}' (model exposes: {available})"
    )
