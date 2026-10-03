# pi-agent-workflow/scripts/sync_settings.py
"""Sync profile model bindings to pi dispatch config.

Two outputs:

1. **settings.json** (`~/.pi/agent/settings.json` or --settings path):
   writes `subagents.agentOverrides.<role>` entries for each binding. This
   is a soft hint used by some third-party extensions.

2. **project-local agent files** (`.pi/agents/<role>.md` in cwd):
   copies each framework role agent and overwrites its `model:` and
   `thinking:` frontmatter fields with the bound values.  This is the
   authoritative dispatch path: the **pi-subagents** extension reads
   `.pi/agents/<name>.md` (project) before any global fallback and
   honours `model:` and `thinking:` frontmatter fields.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from profile_loader import (  # noqa: E402
    CORE_ROLES,
    ProfileError,
    load_profile,
    load_registry,
    resolve_bindings,
)


DEFAULT_SETTINGS = Path.home() / ".pi" / "agent" / "settings.json"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync profile bindings to pi dispatch config + project-local agent files."
    )
    parser.add_argument("--profile", type=Path,
                        default=Path.cwd() / ".pi" / "agent-workflow.yaml")
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
    args = parser.parse_args()
    if args.framework_root is None:
        args.framework_root = Path(__file__).resolve().parent.parent
    if args.clear:
        rc1 = _clear_settings(args.settings, args.dry_run)
        rc2 = _clear_agents(args.agents_dir, args.framework_root, args.dry_run)
        return rc1 or rc2
    if not args.profile.exists():
        print("error: profile not found: " + str(args.profile), file=sys.stderr)
        return 2
    try:
        profile = load_profile(args.profile)
    except ProfileError as e:
        print("error: profile invalid: " + str(e), file=sys.stderr)
        return 2
    registry = try_load_registry(args.framework_root)
    resolved = resolve_bindings(profile, registry)
    new_overrides = {}
    for role, binding in resolved.items():
        if role not in CORE_ROLES:
            continue
        new_overrides[role] = {"model": binding.model_id, "channel": binding.channel_id}
    rc1 = rc2 = 0
    if not args.no_settings:
        rc1 = _merge_and_write(args.settings, new_overrides, args.dry_run)
    if not args.no_agents:
        rc2 = _write_agents(args.agents_dir, args.framework_root, new_overrides, args.dry_run)
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
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    existing = subagents.get("agentOverrides", {}) or {}
    kept = {r: v for r, v in existing.items() if r not in CORE_ROLES}
    removed = [r for r in existing if r in CORE_ROLES]
    subagents["agentOverrides"] = kept
    settings["subagents"] = subagents
    return _write_settings(settings_path, settings, dry_run,
                           "removed " + str(len(removed)) + " framework overrides from settings.json")


def _write_agents(agents_dir: Path, framework_root: Path,
                  new_overrides: dict, dry_run: bool) -> int:
    if dry_run:
        for role in CORE_ROLES:
            if role not in new_overrides:
                continue
            print("would write " + str(agents_dir / (role + ".md")) +
                  " model=" + new_overrides[role]["model"])
        return 0
    agents_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for role in CORE_ROLES:
        if role not in new_overrides:
            continue
        src = framework_root / "agents" / (role + ".md")
        if not src.exists():
            print("warning: framework agent not found: " + str(src), file=sys.stderr)
            continue
        dst = agents_dir / (role + ".md")
        body = src.read_text()
        updated = _set_frontmatter_field(body, "model", new_overrides[role]["model"])
        dst.write_text(updated)
        written += 1
    print("wrote " + str(written) + " project-local agent files to " + str(agents_dir))
    return 0


def _clear_agents(agents_dir: Path, framework_root: Path, dry_run: bool) -> int:
    if not agents_dir.exists():
        print("no project-local agent dir at " + str(agents_dir))
        return 0
    removed = 0
    for role in CORE_ROLES:
        dst = agents_dir / (role + ".md")
        if not dst.exists():
            continue
        if dry_run:
            print("would remove " + str(dst))
            removed += 1
            continue
        # Only delete if the file is a project-local copy (not a symlink to framework).
        if dst.is_symlink():
            continue
        dst.unlink()
        removed += 1
    print("removed " + str(removed) + " project-local agent files")
    return 0


def _set_frontmatter_field(body: str, field: str, value: str) -> str:
    """Replace or insert `field: value` in the file's frontmatter block.

   Frontmatter must start with --- on line 1 and end with --- on a later line.
    """
    lines = body.splitlines()
    if not lines or lines[0].strip() != "---":
        # No frontmatter; prepend one.
        new_front = ["---", field + ": " + value, "---", ""]
        return chr(10).join(new_front) + body
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
    return chr(10).join(lines[:1] + new_lines + lines[end:])


def _write_settings(path: Path, settings: dict, dry_run: bool, summary: str) -> int:
    if dry_run:
        print(json.dumps(settings, indent=2, sort_keys=True))
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2, sort_keys=True) + chr(10))
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