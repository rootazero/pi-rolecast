#!/usr/bin/env bash
# install.sh — install the pi-agent-workflow framework.
#
# Usage:
#   bash install.sh [--prefix DIR] [--framework-root DIR] [--dry-run] [--no-pip]
#
# Default prefix: $HOME/.pi/agent/
# Default framework-root: directory containing this script's parent (i.e. this skill's root)
#
# Effects:
#   - Creates <prefix>/pi-agent-workflow/ as a symlink to <framework-root>
#   - Creates <prefix>/agent-<role>/SKILL.md → <framework-root>/agents/<role>.md
#     for each of the 11 core roles
#   - Installs PyYAML if not already importable

set -euo pipefail

PREFIX="${HOME}/.pi/agent"
FRAMEWORK_ROOT=""
DRY_RUN=""
NO_PIP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)         PREFIX="$2"; shift 2 ;;
    --framework-root) FRAMEWORK_ROOT="$2"; shift 2 ;;
    --dry-run)        DRY_RUN="1"; shift ;;
    --no-pip)         NO_PIP="1"; shift ;;
    *)                echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$FRAMEWORK_ROOT" ]]; then
  FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

CORE_ROLES=(orchestrator architect planner implementer tester reviewer mapper profiler auditor canary docs)

if [[ -n "$DRY_RUN" ]]; then
  echo "DRY RUN — would create:"
  echo "  $PREFIX/pi-agent-workflow → $FRAMEWORK_ROOT"
  for role in "${CORE_ROLES[@]}"; do
    echo "  $PREFIX/agent-$role/SKILL.md → $FRAMEWORK_ROOT/agents/$role.md"
  done
  echo "  pip install --user -r $FRAMEWORK_ROOT/requirements.txt"
  exit 0
fi

mkdir -p "$PREFIX"

# Framework symlink
if [[ ! -e "$PREFIX/pi-agent-workflow" ]]; then
  ln -s "$FRAMEWORK_ROOT" "$PREFIX/pi-agent-workflow"
  echo "linked $PREFIX/pi-agent-workflow → $FRAMEWORK_ROOT"
fi

# Role-agent symlinks
for role in "${CORE_ROLES[@]}"; do
  link_dir="$PREFIX/agent-$role"
  link_path="$link_dir/SKILL.md"
  target="$FRAMEWORK_ROOT/agents/$role.md"
  mkdir -p "$link_dir"
  if [[ -e "$link_path" || -L "$link_path" ]]; then
    rm -f "$link_path"
  fi
  ln -s "$target" "$link_path"
done
echo "linked ${#CORE_ROLES[@]} role agents under $PREFIX/agent-<role>/SKILL.md"

# Python deps (skipped under --no-pip and --dry-run so tests do not pollute the user's pip)
if [[ -n "$DRY_RUN" ]]; then
  echo "skipping pip install (dry-run)"
elif [[ -n "$NO_PIP" ]]; then
  echo "skipping pip install (--no-pip)"
elif python3 -c "import yaml" 2>/dev/null; then
  echo "PyYAML already importable; skipping pip install"
else
  python3 -m pip install --user -r "$FRAMEWORK_ROOT/requirements.txt"
fi

echo "install complete"

# Sync profile bindings to pi dispatch config (only if cwd has one).
if [[ -f "./.pi/agent-workflow.yaml" ]]; then
  echo "found .pi/agent-workflow.yaml in cwd; syncing to settings.json"
  python3 "$FRAMEWORK_ROOT/scripts/sync_settings.py" \
    --profile "./.pi/agent-workflow.yaml" \
    --framework-root "$FRAMEWORK_ROOT" || \
    echo "warning: sync_settings.py failed (run it manually)"
else
  echo "next: scaffold a profile in your project with:"
  echo "  python3 \$SKILL_ROOT/scripts/scaffolder.py init --template rust"
fi
