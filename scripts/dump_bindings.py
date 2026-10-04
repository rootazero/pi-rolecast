#!/usr/bin/env python3
"""pi-rolecast/scripts/dump_bindings.py

Emit a JSON snapshot of the loaded profile (bindings + role frontmatter
`requires:` / `preferences:`) for the pi-rolecast TypeScript extension
to consume at runtime.

Keeps the schema-parsing responsibility in `profile_loader` so this script
stays a thin emitter. The TS extension caches the output at session_start
and feeds it to `src/model_resolver.ts` when hooks fire.

v0.3.0: added for dynamic model binding — see
references/dynamic-model-binding-design.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from profile_loader import (  # noqa: E402
    available_roles,
    find_profile,
    load_profile,
)


def _binding_payload(role: str, binding, role_pack) -> dict:
    payload: dict = {
        "alias": binding.alias,
        "channels": list(binding.channels),
        "fallback_chain": list(binding.fallback_chain or []),
    }
    if role_pack is not None:
        payload["requires"] = dict(role_pack.requires or {})
        payload["preferences"] = dict(role_pack.preferences or {})
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Dump profile bindings + role frontmatter as JSON.")
    parser.add_argument("--profile", type=Path, default=None)
    parser.add_argument("--framework-root", type=Path, default=None)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    args = parser.parse_args()

    profile_path = args.profile or find_profile(args.cwd)
    if profile_path is None:
        # No profile — emit an empty payload. Extension treats this as "no bindings".
        print(json.dumps({"role_groups": [], "bindings": {}}))
        return 0

    try:
        profile = load_profile(profile_path, framework_root=args.framework_root)
    except Exception as e:  # noqa: BLE001 — surface failure to caller as JSON
        print(json.dumps({"error": f"load_profile failed: {e}"}))
        return 2

    root = args.framework_root or profile_path.parent.parent.parent
    packs = available_roles(root, groups=profile.workflow.role_groups)

    bindings = {
        role: _binding_payload(role, binding, packs.get(role))
        for role, binding in profile.bindings.items()
    }

    payload = {
        "role_groups": list(profile.workflow.role_groups),
        "bindings": bindings,
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())