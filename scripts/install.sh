#!/usr/bin/env bash
# pi-rolecast installer. v0.2.0+: walks role-packs/<group>/<role>.md instead
# of the legacy agents/ directory.
set -euo pipefail
PREFIX="${HOME}/.pi/agent"
FRAMEWORK_ROOT=""
DRY_RUN=""
NO_PIP=""
KEEP_OLD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)         PREFIX="$2"; shift 2 ;;
    --framework-root) FRAMEWORK_ROOT="$2"; shift 2 ;;
    --dry-run)        DRY_RUN="1"; shift ;;
    --no-pip)         NO_PIP="1"; shift ;;
    --keep-old-layout) KEEP_OLD="1"; shift ;;
    *)                echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$FRAMEWORK_ROOT" ]]; then
  FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

if [[ -n "$DRY_RUN" ]]; then
  echo DRY RUN
  while IFS= read -r md; do
    role=$(basename "$md" .md)
    echo "would create $PREFIX/agents/$role.md"
  done < <(find "$FRAMEWORK_ROOT/role-packs" -type f -name '*.md' 2>/dev/null | sort)
  exit 0
fi
mkdir -p "$PREFIX"

# Framework symlink (new pi-rolecast name; keep removing the legacy name).
if [[ ! -e "$PREFIX/pi-rolecast" ]]; then
  ln -s "$FRAMEWORK_ROOT" "$PREFIX/pi-rolecast"
  echo "linked $PREFIX/pi-rolecast to $FRAMEWORK_ROOT"
fi
if [[ -e "$PREFIX/pi-agent-workflow" ]]; then
  echo "removing legacy $PREFIX/pi-agent-workflow symlink"
  rm -f "$PREFIX/pi-agent-workflow"
fi

# Remove legacy v0.1.x layout: ~/.pi/agent/agent-<role>/SKILL.md.
if [[ -z "$KEEP_OLD" ]]; then
  removed=0
  for d in "$PREFIX"/agent-*; do
    if [[ -d "$d" ]]; then
      rm -rf "$d"
      removed=$((removed + 1))
    fi
  done
  if [[ $removed -gt 0 ]]; then
    echo "removed $removed old agent-role directories"
  fi
fi

# Global role symlinks for every role-packs/<group>/<role>.md.
agents_dir="$PREFIX/agents"
mkdir -p "$agents_dir"
linked=0
while IFS= read -r md; do
  role=$(basename "$md" .md)
  link_path="$agents_dir/$role.md"
  if [[ -L "$link_path" ]]; then
    rm -f "$link_path"
  fi
  ln -s "$md" "$link_path"
  linked=$((linked + 1))
done < <(find "$FRAMEWORK_ROOT/role-packs" -type f -name '*.md' 2>/dev/null | sort)
echo "linked $linked role agents from role-packs/"

# Warn if pi-subagents is missing — required for actual role dispatch.
SETTINGS_JSON="$PREFIX/settings.json"
if [[ -f "$SETTINGS_JSON" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$SETTINGS_JSON'))
    pkgs = d.get('packages', [])
    if not any('pi-subagents' in str(p) or 'subagents' in str(p) for p in pkgs):
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(0)
" 2>/dev/null; then
  echo ""
  echo "WARNING: pi-subagents not found in $PREFIX/settings.json packages[]"
  echo "  Role symlinks are installed but dispatch won't work without pi-subagents."
  echo " Install with:  pi install npm:@tintinweb/pi-subagents"
fi

if [[ -n "$NO_PIP" ]]; then
  echo "skipping pip install (--no-pip)"
elif python3 -c "import yaml" 2>/dev/null; then
  echo "PyYAML already importable; skipping pip install"
else
  python3 -m pip install --user -r "$FRAMEWORK_ROOT/requirements.txt"
fi

echo "install complete"

# Sync profile bindings to pi dispatch config + project-local agent files
# if a profile is found in cwd (new filename preferred, legacy accepted).
profile_path=""
if [[ -f "./.pi/rolecast.yaml" ]]; then
  profile_path="./.pi/rolecast.yaml"
elif [[ -f "./.pi/agent-workflow.yaml" ]]; then
  profile_path="./.pi/agent-workflow.yaml"
  echo "warning: .pi/agent-workflow.yaml is the legacy v0.1.x filename; rename to .pi/rolecast.yaml"
fi
if [[ -n "$profile_path" ]]; then
  echo "found $profile_path in cwd; syncing to settings.json + .pi/agents/"
  python3 "$FRAMEWORK_ROOT/scripts/sync_settings.py" \
    --profile "$profile_path" \
    --framework-root "$FRAMEWORK_ROOT" || \
    echo "warning: sync_settings.py failed (run it manually)"
else
  echo "next: scaffold a profile in your project with:"
  echo "  python3 \$SKILL_ROOT/scripts/scaffolder.py init --template rust"
fi
