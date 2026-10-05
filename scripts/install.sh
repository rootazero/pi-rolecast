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

# Remove legacy pi-agent-workflow framework symlink if it exists.
# v0.2.3: no longer creates ~/.pi/agent/pi-rolecast symlink — npm install
# path (~/.pi/agent/npm/node_modules/pi-rolecast) is canonical.
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
# Clean up ANY pre-existing symlinks pointing at the legacy framework root.
# Old symlinks would dangle after `pi-agent-workflow` is removed; clean first.
if [[ -d "$agents_dir" ]]; then
  while IFS= read -r stale; do
    target="$(readlink "$stale" 2>/dev/null || true)"
    if [[ -n "$target" && "$target" == *pi-agent-workflow* ]]; then
      rm -f "$stale"
    fi
  done < <(find "$agents_dir" -maxdepth 1 -type l -name '*.md')
fi
linked=0
while IFS= read -r md; do
  role=$(basename "$md" .md)        # e.g. "coding-architect" (full prefixed name)
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

# User-global registry/aliases override dir (v0.2.0+).
# Lazy-create + drop a stub README so users can discover this extension point
# without reading the docs. Idempotent: never overwrites existing files.
rolecast_dir="$HOME/.pi/rolecast"
if [[ ! -d "$rolecast_dir" ]]; then
  mkdir -p "$rolecast_dir"
  echo "created $rolecast_dir (user-global registry/aliases override dir)"
fi
if [[ ! -f "$rolecast_dir/README.md" ]]; then
  cat > "$rolecast_dir/README.md" <<'ROLECAST_README_EOF'
# ~/.pi/rolecast/

User-global overrides for the pi-rolecast registry and alias layers.

Drop any of these files here to override the built-in defaults ACROSS every
project on this machine (project-local `<project>/.pi/rolecast-registry.yaml`
still wins for the project that defines it):

- `registry-overrides.yaml`  — add/override model entries (vendor, capabilities, channels, cost_tier, status).
- `aliases-overrides.yaml`   — add/override alias → model-id mappings.

Merge order (later wins):

  built-in (role-packs/registry/{built_in,aliases}.yaml)
    → user-global (this dir)
    → project-local (<project>/.pi/rolecast-registry.yaml)

Missing files or missing dir are silent no-ops; dispatch still works.
Full schema: see `references/registry-resolution.md` in the pi-rolecast source.

This README is a stub written on first run. Delete it anytime — it has no
runtime effect.
ROLECAST_README_EOF
  echo "wrote $rolecast_dir/README.md (stub; overwrite or delete freely)"
fi

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
  echo "found $profile_path in cwd; syncing to .pi/agents/ (project-local, authoritative)"
  python3 "$FRAMEWORK_ROOT/scripts/sync_settings.py" \
    --profile "$profile_path" \
    --framework-root "$FRAMEWORK_ROOT" || \
    echo "warning: sync_settings.py failed (run it manually)"
else
  echo "next: scaffold a profile in your project with:"
  echo "  python3 \$SKILL_ROOT/scripts/scaffolder.py init --template rust"
fi

# Closing hint — surfaces the two most common extension points (project-local
# agent files + user-global overrides). Shown unconditionally.
echo "Tip: pi-rolecast installed. Project-local agent files: $PREFIX/agents/ (authoritative for dispatch). User-global overrides: ~/.pi/rolecast/ — drop {registry,aliases}-overrides.yaml here. Docs: references/sync-settings-usage.md, references/registry-resolution.md"
