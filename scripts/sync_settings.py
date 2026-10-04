#!/usr/bin/env python3
"""pi-rolecast/scripts/sync_settings.py

Sync profile model bindings to pi dispatch config.

Two outputs:

1. **settings.json** (`~/.pi/agent/settings.json` or --settings path):
   writes `subagents.agentOverrides.<full-role-name>` entries for each
   binding. This is a soft hint used by some third-party extensions.

2. **project-local agent files** (`.pi/agents/<full-role-name>.md` in cwd):
   copies each role-packs/<group>/<role>.md template and overwrites its
   `model:` and `thinking:` frontmatter fields with the bound values.
   This is the authoritative dispatch path: the **pi-subagents**
   extension reads `.pi/agents/<name>.md` (project) before any global
   fallback and honours `model:` and `thinking:` frontmatter fields.

v0.2.0 changes:
  * Walks role-packs/<group>/<role>.md instead of hardcoded CORE_ROLES.
  * Only emits roles for groups listed in `profile.workflow.role_groups`.
  * Role names written to .pi/agents/ are the full prefixed names
    (e.g. `coding-architect.md`) so they match the `<group>-<role>`
    binding keys.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from profile_loader import (  # noqa: E402
    ProfileError,
    available_roles,
    discover_role_packs,
    load_profile,
    load_registry,
    resolve_bindings,
)


DEFAULT_SETTINGS = Path.home() / ".pi" / "agent" / "settings.json"


# pi uses different provider keys than our registry's `vendor` field.
VENDOR_TO_PROVIDER = {
    "minimax": "minimax-cn",
    "deepseek": "deepseek",
    "openai": "openai-codex",
    "anthropic": "anthropic",
    "moonshotai": "kimi-coding",
    "kimi-coding": "kimi-coding",
    "typesafe": "typesafe",
}


def _provider_for_model(model_id: str, registry) -> str:
    """Look up pi provider for a model id. Returns "" if unknown.

    Resolution order:
    1. explicit `provider` attribute on the model (registry-overrides.yaml)
    2. vendor -> VENDOR_TO_PROVIDER mapping
    3. vendor itself
    4. "" (caller should fall back to plain modelId)
    """
    if registry is None:
        return ""
    if hasattr(registry, "_models"):
        model = registry._models.get(model_id)
        if model is not None:
            if hasattr(model, "provider") and model.provider:
                return model.provider
            vendor = getattr(model, "vendor", "") or ""
            if vendor in VENDOR_TO_PROVIDER:
                return VENDOR_TO_PROVIDER[vendor]
            if vendor:
                return vendor
        return ""
    for m in registry.get("models", []) or []:
        if m.get("id") == model_id:
            if m.get("provider"):
                return m["provider"]
            vendor = m.get("vendor", "")
            if vendor in VENDOR_TO_PROVIDER:
                return VENDOR_TO_PROVIDER[vendor]
            if vendor:
                return vendor
            break
    return ""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync profile bindings to pi dispatch config + project-local agent files."
    )
    parser.add_argument("--profile", type=Path, default=None,
                        help="profile path (default: .pi/rolecast.yaml in cwd; "
                             "falls back to legacy .pi/agent-workflow.yaml)")
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument("--framework-root", type=Path, default=None)
    parser.add_argument("--agents-dir", type=Path,
                        default=Path.cwd() / ".pi" / "agents",
                        help="project-local agent directory (default: .pi/agents)")
    parser.add_argument("--clear", action="store_true",
                        help="remove framework role entries from settings.json and delete "
                             "project-local agent files written by sync")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-agents", action="store_true",
                        help="skip writing project-local agent files (settings.json only)")
    parser.add_argument("--no-settings", action="store_true",
                        help="skip writing settings.json (agent files only)")
    parser.add_argument("--status", action="store_true",
                        help="show current sync state vs profile bindings (no changes)")
    parser.add_argument("--list-groups", action="store_true",
                        help="list available role groups from role-packs/ and exit")
    args = parser.parse_args()

    if args.framework_root is None:
        args.framework_root = Path(__file__).resolve().parent.parent

    if args.list_groups:
        packs = discover_role_packs(args.framework_root)
        if not packs:
            print("(no role-packs/* directories found under framework root)")
            return 0
        for g, roles in packs.items():
            print(f"{g}/ ({len(roles)} roles): " + ", ".join(r.full_name for r in roles))
        return 0

    if args.clear:
        # --clear is a standalone cleanup operation — does NOT need a profile.
        rc1 = _clear_settings(args.settings, args.dry_run)
        rc2 = _clear_agents(args.agents_dir, args.framework_root, args.dry_run)
        return rc1 or rc2

    if args.profile is None:
        from profile_loader import find_profile
        discovered = find_profile(Path.cwd())
        if discovered is None:
            print("error: no profile found (looked for .pi/rolecast.yaml "
                  "and legacy .pi/agent-workflow.yaml in cwd)", file=sys.stderr)
            return 2
        args.profile = discovered

    if not args.profile.exists():
        print("error: profile not found: " + str(args.profile), file=sys.stderr)
        return 2
    try:
        profile = load_profile(args.profile, framework_root=args.framework_root)
    except ProfileError as e:
        print("error: profile invalid: " + str(e), file=sys.stderr)
        return 2

    registry = try_load_registry(args.framework_root)
    resolved = resolve_bindings(profile, registry)

    # Build new_overrides using FULL role names (e.g. coding-architect).
    new_overrides = {}
    for role, binding in resolved.items():
        new_overrides[role] = {"model": binding.model_id, "channel": binding.channel_id}

    if args.status:
        return _show_status(args.profile, args.settings, args.agents_dir,
                            args.framework_root, new_overrides)

    rc1 = rc2 = 0
    if not args.no_settings:
        rc1 = _merge_and_write(args.settings, new_overrides, args.dry_run)
    if not args.no_agents:
        rc2 = _write_agents(args.agents_dir, args.framework_root, profile.workflow.role_groups,
                            new_overrides, args.dry_run, registry)
    return rc1 or rc2


def _merge_and_write(settings_path: Path, new_overrides: dict, dry_run: bool) -> int:
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    existing_overrides = subagents.get("agentOverrides", {}) or {}
    merged = dict(existing_overrides)
    for role, override in new_overrides.items():
        merged[role] = override
    subagents["agentOverrides"] = merged
    settings["subagents"] = subagents
    return _write_settings(settings_path, settings, dry_run,
                           "synced " + str(len(new_overrides)) + " roles in settings.json")


def _clear_settings(settings_path: Path, dry_run: bool) -> int:
    """Remove ALL agentOverrides entries — we can't tell which are framework
    ones without the profile, so --clear drops everything. Users with custom
    overrides should re-merge manually."""
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    existing = subagents.get("agentOverrides", {}) or {}
    removed = list(existing.keys())
    subagents["agentOverrides"] = {}
    settings["subagents"] = subagents
    return _write_settings(settings_path, settings, dry_run,
                           "removed " + str(len(removed)) + " agent overrides from settings.json")


def _show_status(profile_path: Path, settings_path: Path, agents_dir: Path,
                 framework_root: Path, expected_overrides: dict) -> int:
    """Show diff between profile bindings and currently-synced state."""
    import re
    fm_re = re.compile(r"^model:\s*(.+?)\s*$", re.MULTILINE)
    print("=" * 70)
    print(" pi-rolecast sync status")
    print("=" * 70)

    # Profile bindings
    print("\nProfile bindings (" + str(profile_path) + "):")
    if not expected_overrides:
        print("  (no bindings)")
    for role in sorted(expected_overrides):
        ov = expected_overrides[role]
        print("  " + role.ljust(22) + " model=" + ov["model"].ljust(26) +
              " channel=" + ov["channel"])

    # Project-local agent files
    print("\nProject-local agent files (" + str(agents_dir) + "):")
    if not expected_overrides:
        print("  (nothing to check — no profile bindings)")
    for role in sorted(expected_overrides):
        path = agents_dir / (role + ".md")
        if not path.exists():
            print("  " + role.ljust(22) + " (missing)")
            continue
        text = path.read_text()
        m = fm_re.search(text)
        actual = m.group(1) if m else "(no model)"
        expected = expected_overrides[role]["model"]
        match = "OK" if actual == expected else "DRIFT"
        print("  " + role.ljust(22) + " model=" + actual.ljust(26) + " " + match)

    # Settings.json
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    overrides = subagents.get("agentOverrides", {}) or {}
    expected_set = set(expected_overrides.keys())
    framework_overrides = {r: v for r, v in overrides.items() if r in expected_set}
    print("\nsettings.json: " + str(settings_path))
    print("  framework overrides: " + str(len(framework_overrides)) + "/" + str(len(expected_set)))
    return 0


def _write_agents(agents_dir: Path, framework_root: Path,
                  enabled_groups: list[str], new_overrides: dict,
                  dry_run: bool, registry) -> int:
    """Write project-local copies of role-packs/<group>/<role>.md for every
    bound role. Uses full role name (`<group>-<role>`) as the filename so
    pi-subagents can find it via @<full-name> mention syntax."""
    roles = available_roles(framework_root, groups=enabled_groups or None)
    if dry_run:
        for role_full_name, rd in sorted(roles.items()):
            if role_full_name not in new_overrides:
                continue
            model_id = new_overrides[role_full_name]["model"]
            provider = _provider_for_model(model_id, registry)
            full = (provider + "/" + model_id) if provider else model_id
            print("would write " + str(agents_dir / (role_full_name + ".md")) +
                  " model=" + full)
        return 0
    agents_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for role_full_name, rd in sorted(roles.items()):
        if role_full_name not in new_overrides:
            continue
        src = rd.file_path
        if src is None or not src.exists():
            print("warning: role-packs file not found: " + str(rd.file_path),
                  file=sys.stderr)
            continue
        dst = agents_dir / (role_full_name + ".md")
        body = src.read_text()
        model_id = new_overrides[role_full_name]["model"]
        provider = _provider_for_model(model_id, registry)
        full = (provider + "/" + model_id) if provider else model_id
        updated = _set_frontmatter_field(body, "model", full)
        dst.write_text(updated)
        written += 1
    print("wrote " + str(written) + " project-local agent files to " + str(agents_dir))
    return 0


def _clear_agents(agents_dir: Path, framework_root: Path, dry_run: bool) -> int:
    """Remove all project-local agent files (any *.md). Custom files outside
    the role pack should be backed up first — we don't try to detect
    framework vs user here because v0.2.0 always uses prefixed names."""
    if not agents_dir.exists():
        print("no project-local agent dir at " + str(agents_dir))
        return 0
    removed = 0
    for path in sorted(agents_dir.glob("*.md")):
        if path.is_symlink():
            continue
        if dry_run:
            print("would remove " + str(path))
            removed += 1
            continue
        path.unlink()
        removed += 1
    print("removed " + str(removed) + " project-local agent files")
    return 0


def _set_frontmatter_field(body: str, field: str, value: str) -> str:
    """Replace or insert `field: value` in the file's frontmatter block."""
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        new_front = ["---", field + ": " + value, "---", ""]
        return "\n".join(new_front) + body
    try:
        end = lines.index("---", 1)
    except ValueError:
        return body
    prefix = field + ":"
    new_lines = []
    replaced = False
    for ln in lines[1:end]:
        if ln.startswith(prefix) and not replaced:
            new_lines.append(field + ": " + value)
            replaced = True
        else:
            new_lines.append(ln)
    if not replaced:
        new_lines.append(field + ": " + value)
    return "\n".join(lines[:1] + new_lines + lines[end:])


def _write_settings(path: Path, settings: dict, dry_run: bool, summary: str) -> int:
    if dry_run:
        print(json.dumps(settings, indent=2, sort_keys=True))
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n")
    print(summary + ": " + str(path))
    return 0


def _read_settings(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text()
    if not text.strip():
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {}


def try_load_registry(framework_root: Path):
    """Wrapper for tests to monkey-patch."""
    return load_registry(framework_root)


if __name__ == "__main__":
    sys.exit(main())
