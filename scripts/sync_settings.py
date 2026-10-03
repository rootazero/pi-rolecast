# pi-agent-workflow/scripts/sync_settings.py
"""Sync profile model bindings to the pi agent settings.json file."""
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
    parser = argparse.ArgumentParser(description=__doc__.split(chr(10), 1)[1] if chr(10) in str(__doc__) else __doc__)
    parser.add_argument("--profile", type=Path, default=Path.cwd() / ".pi" / "agent-workflow.yaml")
    parser.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument("--framework-root", type=Path, default=None)
    parser.add_argument("--clear", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.framework_root is None:
        args.framework_root = Path(__file__).resolve().parent.parent
    if args.clear:
        return _clear(args.settings, args.dry_run)
    if not args.profile.exists():
        print("error: profile not found: " + str(args.profile), file=sys.stderr)
        return 2
    try:
        profile = load_profile(args.profile)
    except ProfileError as e:
        print("error: profile invalid: " + str(e), file=sys.stderr)
        return 2
    registry = load_registry(args.framework_root)
    resolved = resolve_bindings(profile, registry)
    new_overrides = {}
    for role, binding in resolved.items():
        if role not in CORE_ROLES:
            continue
        new_overrides[role] = {"model": binding.model_id, "channel": binding.channel_id}
    return _merge_and_write(args.settings, new_overrides, args.dry_run)


def _merge_and_write(settings_path: Path, new_overrides: dict, dry_run: bool) -> int:
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    existing_overrides = subagents.get("agentOverrides", {}) or {}
    merged = dict(existing_overrides)
    for role, override in new_overrides.items():
        merged[role] = override
    subagents["agentOverrides"] = merged
    settings["subagents"] = subagents
    return _write_settings(settings_path, settings, dry_run, "synced " + str(len(new_overrides)))


def _clear(settings_path: Path, dry_run: bool) -> int:
    settings = _read_settings(settings_path)
    subagents = settings.get("subagents", {})
    existing = subagents.get("agentOverrides", {}) or {}
    kept = {r: v for r, v in existing.items() if r not in CORE_ROLES}
    removed = [r for r in existing if r in CORE_ROLES]
    subagents["agentOverrides"] = kept
    settings["subagents"] = subagents
    return _write_settings(settings_path, settings, dry_run, "removed " + str(len(removed)) + " framework overrides")


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
    return json.loads(text)


if __name__ == "__main__":
    sys.exit(main())
