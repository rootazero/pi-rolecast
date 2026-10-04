#!/usr/bin/env python3
"""scaffolder.py — init / diff / validate CLI for project profiles.

Subcommands:
- init [--template LANG] [--blank] [--dry-run] [--force]
- diff (spec §9.4)
- validate (spec §9.5)

Init flow: auto-detect language → load template → walk user through
sections → write profile + custom-role README.
"""
from __future__ import annotations
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from profile_loader import ProfileError, load_profile


# ─────────────────────────────────────────────────────────────────────
# Language auto-detect (spec §9.2)
# ─────────────────────────────────────────────────────────────────────

LANGUAGE_MARKERS: list[tuple[str, list[str]]] = [
    # (language, list of files; all required)
    ("rust",       ["Cargo.toml"]),
    ("python",     ["pyproject.toml"]),
    ("python",     ["setup.py"]),
    ("typescript", ["package.json", "tsconfig.json"]),
    ("go",         ["go.mod"]),
]


def auto_detect_languages(project_root: str | Path) -> list[str]:
    """Return ALL detected languages for a project (multi-lang aware).

    Spec §9.2: package.json alone is ambiguous — caller must prompt user.
    Both "typescript" and "javascript" are surfaced so the prompt can offer
    both choices. detect_language() returns None in that case.
    """
    root = Path(project_root)
    detected: list[str] = []
    # package.json alone is ambiguous — handled separately.
    if (root / "package.json").exists() and not (root / "tsconfig.json").exists():
        detected.extend(["typescript", "javascript"])
    for lang, files in LANGUAGE_MARKERS:
        if all((root / f).exists() for f in files) and lang not in detected:
            detected.append(lang)
    return detected


def detect_language(project_root: str | Path) -> str | None:
    """Return the single best-guess language (spec §9.2 priority order),
    or None if ambiguous / unknown.

    Ambiguity is narrow: detected == ["typescript", "javascript"]
    (package.json-only). Other languages override the ambiguity — e.g.
    Cargo.toml + package.json still yields "rust" via priority order.
    """
    detected = auto_detect_languages(project_root)
    if detected == ["typescript", "javascript"]:
        # Spec §9.2 row 4 — caller must prompt.
        return None
    confident = [l for l in detected if l != "javascript"]
    if len(confident) == 1:
        return confident[0]
    if len(confident) == 0:
        return None
    # Multiple confident matches — return first by priority order
    priority = ["rust", "python", "typescript", "go"]
    for p in priority:
        if p in confident:
            return p
    return confident[0]


# ─────────────────────────────────────────────────────────────────────
# init subcommand (partial — template + profile generation in T9)
# ─────────────────────────────────────────────────────────────────────

def cmd_init(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root).resolve()
    framework_root = Path(args.framework_root).resolve()
    templates_dir = framework_root / "templates"
    # v0.2.0: prefer new filename; fall back to legacy if --legacy-name is passed.
    profile_dir = project_root / ".pi"
    if getattr(args, "legacy_name", False):
        profile_path = profile_dir / "agent-workflow.yaml"
    else:
        profile_path = profile_dir / "rolecast.yaml"

    if args.template:
        lang = args.template
    elif args.blank:
        lang = None
    else:
        lang = _prompt_language(project_root)

    if args.dry_run:
        print(f"DRY RUN — would create: {profile_path}")
        print(f"template: {lang or '(blank)'}")
        return 0

    template_data = _load_template(templates_dir, lang) if lang else _blank_template()

    if profile_path.exists() and not args.force:
        print(f"profile already exists at {profile_path}; pass --force to overwrite",
              file=sys.stderr)
        return 1

    profile_path.parent.mkdir(parents=True, exist_ok=True)
    _write_profile(profile_path, template_data)
    print(f"wrote {profile_path}")
    print("next steps:")
    print(f"  python3 {framework_root}/scripts/scaffolder.py validate --profile {profile_path}")
    print(f"  python3 {framework_root}/scripts/gate_runner.py --profile {profile_path} --phase all")
    return 0


def _prompt_language(project_root: Path) -> str | None:
    detected = auto_detect_languages(project_root)
    if detected == ["typescript", "javascript"]:
        # Spec §9.2 row 4 — caller must specify typescript or javascript.
        print(
            "Detected package.json without tsconfig.json.",
            file=sys.stderr,
        )
        print(
            "Specify --template typescript or --template javascript.",
            file=sys.stderr,
        )
        return None
    confident = [l for l in detected if l != "javascript"]
    if not confident:
        print("could not auto-detect language.", file=sys.stderr)
        return None
    if len(confident) > 1:
        print(f"multiple languages detected: {confident}", file=sys.stderr)
        print("use --template to pick one", file=sys.stderr)
        return None
    return confident[0]


def _load_template(templates_dir: Path, lang: str) -> dict:
    p = templates_dir / f"{lang}.yaml"
    if not p.exists():
        raise FileNotFoundError(f"no template for language '{lang}': {p}")
    import yaml
    return yaml.safe_load(p.read_text())


def _blank_template() -> dict:
    return {
        "framework_version": "0.2.0",
        "name": "",
        "description": "",
        "workflow": {"role_groups": []},
        "gates": {},
        "bindings": {},
    }


def _write_profile(path: Path, data: dict) -> None:
    import yaml
    path.write_text(yaml.safe_dump(data, sort_keys=False))


# ─────────────────────────────────────────────────────────────────────
# CLI dispatcher
# ─────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="scaffolder")
    sub = p.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="generate a profile for the current project")
    init.add_argument("--template", help="language template to use (rust, typescript, python, go, blank)")
    init.add_argument("--blank", action="store_true", help="emit a profile with no fields pre-filled")
    init.add_argument("--dry-run", action="store_true", help="print what would be created, do not write")
    init.add_argument("--force", action="store_true", help="overwrite existing profile")
    init.add_argument("--project-root", default=".", help="project root (default: cwd)")
    init.add_argument("--framework-root", default=str(Path(__file__).resolve().parent.parent))
    init.add_argument("--interactive", action="store_true",
                      help="walk through each profile section interactively (v2; v1 is a no-op)")
    init.add_argument("--legacy-name", action="store_true",
                      help="write to .pi/agent-workflow.yaml instead of .pi/rolecast.yaml")
    init.set_defaults(func=cmd_init)

    diff = sub.add_parser("diff", help="report schema differences vs current framework")
    diff.add_argument("--profile", required=True, help="path to rolecast.yaml (or legacy agent-workflow.yaml)")
    diff.add_argument("--framework-root", default=str(Path(__file__).resolve().parent.parent))
    diff.set_defaults(func=cmd_diff)

    validate = sub.add_parser("validate", help="validate a profile against current schema")
    validate.add_argument("--profile", required=True, help="path to rolecast.yaml (or legacy agent-workflow.yaml)")
    validate.add_argument("--framework-root", default=str(Path(__file__).resolve().parent.parent))
    validate.set_defaults(func=cmd_validate)

    return p


# Stub implementations for diff + validate — filled in T10/T11.
def cmd_diff(args) -> int:
    """Report schema drift between profile.framework_version and the
    current framework. Reads `added-fields.yaml` and `removed-fields.yaml`
    from framework root for schema evolution metadata."""
    import yaml
    profile_path = Path(args.profile).resolve()
    fw_root = Path(args.framework_root).resolve()
    if not profile_path.exists():
        print(f"profile not found: {profile_path}", file=sys.stderr)
        return 1
    raw = yaml.safe_load(profile_path.read_text())
    if not isinstance(raw, dict):
        print("profile is not a YAML mapping", file=sys.stderr)
        return 1
    profile_version = raw.get("framework_version")
    if not profile_version:
        print("profile.framework_version is required for diff", file=sys.stderr)
        return 1

    added_file = fw_root / "added-fields.yaml"
    removed_file = fw_root / "removed-fields.yaml"
    profile_fields = set(_flatten_keys(raw))

    missing = []
    if added_file.exists():
        added_data = yaml.safe_load(added_file.read_text()) or {}
        for f in added_data.get("added", []):
            if f not in profile_fields:
                missing.append(f)

    print(f"profile framework_version: {profile_version}")
    if missing:
        print("fields missing from profile (added in newer framework):")
        for f in missing:
            print(f"  - {f}")
    else:
        print("no missing fields")

    deprecated = []
    if removed_file.exists():
        removed_data = yaml.safe_load(removed_file.read_text()) or {}
        for f in removed_data.get("removed", []):
            if f in profile_fields:
                deprecated.append(f)
    if deprecated:
        print("fields deprecated in newer framework:")
        for f in deprecated:
            print(f"  - {f}")

    print("no auto-merge. apply changes manually.")
    return 0


def _flatten_keys(d: dict, prefix: str = "") -> list[str]:
    out: list[str] = []
    for k, v in d.items():
        path = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.extend(_flatten_keys(v, path))
        else:
            out.append(path)
    return out


def cmd_validate(args) -> int:
    try:
        profile = load_profile(args.profile, framework_root=args.framework_root)
    except ProfileError as e:
        print(f"INVALID: {e}", file=sys.stderr)
        return 1
    print(f"profile '{profile.name}' is valid (framework {profile.framework_version})")
    print(f"  bindings resolved: {len(profile.resolved_bindings)}")
    for role, rb in profile.resolved_bindings.items():
        warn = f" [WARN: {rb.warning}]" if rb.warning else ""
        print(f"    {role}: {rb.alias} -> {rb.model_id} on {rb.channel_id}{warn}")
    return 0


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
