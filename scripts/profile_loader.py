# pi-agent-workflow/scripts/profile_loader.py
"""Load + validate a project-local agent-workflow profile.

Single source of truth for spec §5.3 validation rules. Consumed by:
- scripts/gate_runner.py (load_profile before phase execution)
- scripts/scaffolder.py validate (load_profile)
- scripts/scaffolder.py init (load_profile after writing new profile)

Resolution rules (alias → model + channel) live in this module too —
see load_resolved_bindings in task 4 / 5.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import yaml

CORE_ROLES = frozenset({
    "orchestrator", "architect", "planner", "implementer", "tester",
    "reviewer", "mapper", "profiler", "auditor", "canary", "docs",
})

DEFAULT_FRAMEWORK_VERSION = "0.1.0"


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


@dataclass
class Escalation:
    max_attempts: int = 2
    on_permanent_failure: str = "stop"   # stop | continue
    preserve_logs: bool = True


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
    resolved_bindings: dict[str, ResolvedBinding] = field(default_factory=dict)  # NEW

    @property
    def core_role_set(self) -> set[str]:
        return set(CORE_ROLES)

    @property
    def custom_role_names(self) -> set[str]:
        return {r.name for r in self.custom_roles}


# ─────────────────────────────────────────────────────────────────────
# Loader entrypoint
# ─────────────────────────────────────────────────────────────────────

def load_profile(path: str | Path, *, framework_root: str | Path | None = None) -> Profile:
    p = Path(path)
    if not p.is_file():
        raise ProfileError(f"profile not found: {p}")
    raw = yaml.safe_load(p.read_text())
    if not isinstance(raw, dict):
        raise ProfileError(f"profile {p} is not a YAML mapping")
    profile = parse_profile(raw)
    root = Path(framework_root) if framework_root else Path(__file__).resolve().parent.parent
    registry = load_registry(root)
    profile.resolved_bindings = resolve_bindings(profile, registry)
    return profile


def parse_profile(raw: dict) -> Profile:
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

    custom_roles = _parse_custom_roles(raw.get("custom_roles") or [])
    allowed_roles = CORE_ROLES | {r.name for r in custom_roles}

    bindings = _parse_bindings(raw.get("bindings") or {}, allowed_roles)

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
    )

    _check_trigger_collisions(profile)
    return profile


# ─────────────────────────────────────────────────────────────────────
# Sub-parsers
# ─────────────────────────────────────────────────────────────────────

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
        if item["name"] in CORE_ROLES:
            raise ProfileError(f"custom_role name '{item['name']}' collides with core role")
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


def _parse_bindings(raw: dict, allowed_roles: set[str]) -> dict[str, Binding]:
    if not isinstance(raw, dict):
        raise ProfileError("profile.bindings must be a mapping")
    out: dict[str, Binding] = {}
    for role, b in raw.items():
        if role not in allowed_roles:
            raise ProfileError(
                f"bindings key '{role}' is not a core role (spec §5.3 rule 1) "
                f"and is not declared in custom_roles"
            )
        if not isinstance(b, dict):
            raise ProfileError(f"bindings.{role} must be a mapping")
        if "alias" not in b:
            raise ProfileError(f"bindings.{role}.alias is required")
        if "channels" not in b or not isinstance(b["channels"], list) or not b["channels"]:
            raise ProfileError(f"bindings.{role}.channels must be a non-empty list")
        out[role] = Binding(alias=b["alias"], channels=list(b["channels"]))
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
# Trigger collision check (rule 5)
# ─────────────────────────────────────────────────────────────────────

# Spec §7.1 default triggers shipped with framework agents.
DEFAULT_TRIGGERS: dict[str, list[str]] = {
    "architect":      ["design", "architect", "trait"],
    "planner":        ["plan", "plan this change"],
    "implementer":    ["implement", "code", "do it"],
    "tester":         ["write tests", "test this"],
    "reviewer":       ["review this diff", "review"],
    "mapper":         ["map", "repo map"],
    "profiler":       ["profile this", "this is slow"],
    "auditor":        ["audit", "audit security"],
    "canary":         ["is the relay real", "which group answered"],
    "docs":           ["write README", "document this"],
    # orchestrator is always-on, no phrase triggers
}


def _check_trigger_collisions(profile: Profile) -> None:
    phrase_to_roles: dict[str, set[str]] = {}
    for role, phrases in DEFAULT_TRIGGERS.items():
        for p in phrases:
            phrase_to_roles.setdefault(p.lower(), set()).add(role)
    for phrase, override in profile.trigger_overrides.items():
        target = override.get("role") if isinstance(override, dict) else None
        if not target:
            raise ProfileError(
                f"trigger_overrides['{phrase}'] must map to {{role: <role>}}"
            )
        if target not in profile.core_role_set and target not in profile.custom_role_names:
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
        raise ProfileError(f"trigger phrase collision (spec §5.3 rule 5):\n{msg}")


# ─────────────────────────────────────────────────────────────────────
# Registry + alias resolution (spec §6, rule 2)
# ─────────────────────────────────────────────────────────────────────

@dataclass
class Model:
    id: str
    vendor: str
    capabilities: dict
    channels: list[dict]
    cost_tier: str
    status: str   # stable | deprecated | experimental | withdrawn


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
    via_fallback: bool = False  # reserved for dispatch-time fallback (spec §6.4 step 7)


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
        # Channel selection is profile-binding's job (see task 5).
        # For pure registry resolution, surface preferred channel + trust.
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
    built-in → user-global → project-local (later wins).

    Project-local layer is read from cwd unless explicitly disabled —
    pass ``include_project=False`` to skip it."""
    root = Path(framework_root)
    builtin_models, builtin_aliases = _read_registry_pair(root / "registry")

    # User global: two single files per spec §6.3 — registry-overrides.yaml and
    # aliases-overrides.yaml, both at ~/.pi/agent-workflow/. Either may be
    # missing; _read_registry_pair returns an empty default in that case.
    user_models, _ = _read_registry_pair(_user_global_dir() / "registry-overrides.yaml")
    _, user_aliases = _read_registry_pair(_user_global_dir() / "aliases-overrides.yaml")

    cwd = Path.cwd()
    proj_models, proj_aliases = _read_registry_pair(
        cwd / ".pi" / "agent-workflow-registry.yaml",
        default={"models": [], "aliases": {}},
    )

    merged_models = _merge_models(builtin_models, user_models, proj_models)
    merged_aliases = _merge_aliases(builtin_aliases, user_aliases, proj_aliases)
    return Registry(merged_models, merged_aliases)


def _user_global_dir() -> Path:
    return Path.home() / ".pi" / "agent-workflow"


def _read_registry_pair(path: Path, default: dict | None = None) -> tuple[list, dict]:
    """Read a directory containing built_in.yaml + aliases.yaml, or a single
    YAML file with both `models` and `aliases` keys."""
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
    """Spec §6.3 — per-id deep merge: an override's fields are layered atop the
    base's fields; fields the override omits retain the base's value (e.g.
    channels, capabilities). Models are constructed only after the merge."""
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
    """Spec §6.3 — per-alias-name deep merge: an override's fields are layered
    atop the base's fields. After merge, `preferred` must be present (required)."""
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
    """Spec §6.4 steps 1-6 — no load-time fallback walk (per spec §6.4 step 5:
    error immediately on channel mismatch). Dispatch-time fallback walking is
    the gate-runner's responsibility, not the loader's."""
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
    # Spec §6.4 step 5 — error immediately, do NOT walk fallback chain here.
    available = [ch["id"] for ch in primary_model.channels]
    raise ProfileError(
        f"bindings.{role}: no channel in {binding.channels} is available "
        f"for preferred model '{primary_model.id}' (model exposes: {available})"
    )
