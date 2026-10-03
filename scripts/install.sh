#!/usr/bin/env bash
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

CORE_ROLES=(orchestrator architect planner implementer tester reviewer mapper profiler auditor canary docs)
if [[ -n "$DRY_RUN" ]]; then
  echo DRY RUN
  for role in "${CORE_ROLES[@]}"; do
    echo "would create $PREFIX/agents/$role.md"
  done
  exit 0
fi
mkdir -p "$PREFIX"

# Framework symlink
if [[ ! -e "$PREFIX/pi-agent-workflow" ]]; then
  ln -s "$FRAMEWORK_ROOT" "$PREFIX/pi-agent-workflow"
  echo "linked $PREFIX/pi-agent-workflow to $FRAMEWORK_ROOT"
fi
if [[ -z "$KEEP_OLD" ]]; then
  removed=0
  for role in "${CORE_ROLES[@]}"; do
    old_dir="$PREFIX/agent-$role"
    if [[ -d "$old_dir" ]]; then
      rm -rf "$old_dir"
      removed=$((removed + 1))
    fi
  done
  if [[ $removed -gt 0 ]]; then
    echo "removed $removed old agent-role directories"
  fi
fi
agents_dir="$PREFIX/agents"
mkdir -p "$agents_dir"
linked=0
for role in "${CORE_ROLES[@]}"; do
  link_path="$agents_dir/$role.md"
  target="$FRAMEWORK_ROOT/agents/$role.md"
  if [[ -L "$link_path" ]]; then
    rm -f "$link_path"
  fi
  ln -s "$target" "$link_path"
  linked=$((linked + 1))
done
echo "linked $linked role agents"
if [[ -n "$NO_PIP" ]]; then
  echo "skipping pip install (--no-pip)"
elif python3 -c "import yaml" 2>/dev/null; then
  echo "PyYAML already importable; skipping pip install"
else
  python3 -m pip install --user -r "$FRAMEWORK_ROOT/requirements.txt"
fi

echo "install complete"
# Sync profile bindings to pi dispatch config + project-local agent files
if [[ -f "./.pi/agent-workflow.yaml" ]]; then
  echo "found .pi/agent-workflow.yaml in cwd; syncing to settings.json + .pi/agents/"
  python3 "$FRAMEWORK_ROOT/scripts/sync_settings.py" \
    --profile "./.pi/agent-workflow.yaml" \
    --framework-root "$FRAMEWORK_ROOT" || \
    echo "warning: sync_settings.py failed (run it manually)"
else
  echo "next: scaffold a profile in your project with:"
  echo "  python3 \$SKILL_ROOT/scripts/scaffolder.py init --template rust"
fi
