#!/usr/bin/env bash
# pi-rolecast uninstaller. v0.5.0+: pure Node — no python3 dependency.
# Removes all framework artifacts created by install.sh. Safe to run multiple
# times (idempotent).
#
# Removes:
#   - ~/.pi/agent/pi-rolecast framework symlink
#   - ~/.pi/agent/agents/*.md symlinks whose target is inside a pi-rolecast
#     framework
#   - .pi/agents/<framework-role>.md files matching framework role names
#     (in cwd)
#   - subagents.agentOverrides entries for framework roles in settings.json
#   - empty agent directories if nothing else remains
#
# Does NOT remove:
#   - ~/.pi/agent/npm/node_modules/pi-rolecast/  (run `pi uninstall npm:pi-rolecast` first)
#   - user-created agent files in .pi/agents/ (e.g. custom-role.md)
#   - user-created symlinks in ~/.pi/agent/agents/ (e.g. targeting other frameworks)
#   - settings.json entries for non-framework roles
set -euo pipefail

PREFIX="${HOME}/.pi/agent"
DRY_RUN=""
KEEP_PROJECT_AGENTS=""
SETTINGS_JSON=""
GLOBAL_AGENTS_DIR=""
PROJECT_AGENTS_DIR=""
FRAMEWORK_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)               PREFIX="$2"; shift 2 ;;
    --framework-root)       FRAMEWORK_ROOT="$2"; shift 2 ;;
    --dry-run)              DRY_RUN="1"; shift ;;
    --settings)             SETTINGS_JSON="$2"; shift 2 ;;
    --global-agents-dir)    GLOBAL_AGENTS_DIR="$2"; shift 2 ;;
    --project-agents-dir)   PROJECT_AGENTS_DIR="$2"; shift 2 ;;
    --keep-project-agents)  KEEP_PROJECT_AGENTS="1"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$SETTINGS_JSON" ]] && SETTINGS_JSON="$PREFIX/settings.json"
[[ -z "$GLOBAL_AGENTS_DIR" ]] && GLOBAL_AGENTS_DIR="$PREFIX/agents"
[[ -z "$PROJECT_AGENTS_DIR" ]] && PROJECT_AGENTS_DIR="$(pwd)/.pi/agents"

NODE_BIN="${NODE:-$(command -v node || echo node)}"

# Find framework root to enumerate framework role names. Without this we
# cannot tell framework-written project-local files from user customizations.
if [[ -z "$FRAMEWORK_ROOT" ]]; then
  if [[ -d "./role-packs" ]]; then
    FRAMEWORK_ROOT="$(cd . && pwd)"
  elif [[ -d "$PREFIX/npm/node_modules/pi-rolecast/role-packs" ]]; then
    FRAMEWORK_ROOT="$PREFIX/npm/node_modules/pi-rolecast"
  fi
fi

framework_roles=()
if [[ -n "$FRAMEWORK_ROOT" ]]; then
  while IFS= read -r role; do
    framework_roles+=("$role")
  done < <(find "$FRAMEWORK_ROOT/role-packs" -type f -name '*.md' \
              -exec basename {} .md \; 2>/dev/null | sort -u)
fi

removed=0
_action() {
  # $1 = action (rm), $2 = path, $3 = reason
  if [[ -n "$DRY_RUN" ]]; then
    echo "would $1 $2 ($3)"
  else
    if "$1" "$2" 2>/dev/null; then
      echo "$1 $2 ($3)"
      removed=$((removed + 1))
    fi
  fi
}

# 1. Framework symlink ~/.pi/agent/pi-rolecast
link="$PREFIX/pi-rolecast"
if [[ -L "$link" ]]; then
  target="$(readlink "$link")"
  case "$target" in
    *pi-rolecast*) _action rm "$link" "framework symlink" ;;
  esac
fi

# 2. Global agent symlinks ~/.pi/agent/agents/*.md
#    Only remove symlinks whose target is inside a pi-rolecast framework.
if [[ -d "$GLOBAL_AGENTS_DIR" ]]; then
  while IFS= read -r l; do
    target="$(readlink "$l")"
    case "$target" in
      *pi-rolecast*) _action rm "$l" "global agent symlink" ;;
    esac
  done < <(find "$GLOBAL_AGENTS_DIR" -maxdepth 1 -type l -name '*.md' 2>/dev/null)
fi

# 3. Project-local agent files .pi/agents/<role>.md
#    Only remove files matching framework role names. Skip symlinks (user-created).
if [[ -z "$KEEP_PROJECT_AGENTS" && -d "$PROJECT_AGENTS_DIR" && ${#framework_roles[@]} -gt 0 ]]; then
  for role in "${framework_roles[@]}"; do
    f="$PROJECT_AGENTS_DIR/$role.md"
    [[ -e "$f" || -L "$f" ]] || continue
    [[ -L "$f" ]] && continue
    _action rm "$f" "project-local agent file"
  done
elif [[ -z "$KEEP_PROJECT_AGENTS" && -d "$PROJECT_AGENTS_DIR" ]]; then
  echo "warning: framework root not found, skipping project-local agent cleanup" >&2
  echo "  hint: cd into a project with .pi/rolecast.yaml, or run from pi-rolecast repo" >&2
fi

# 4. Clean settings.json subagents.agentOverrides for framework roles
# v0.5.0+: pure Node via a small inline .mjs script (no python3 dependency).
if [[ -f "$SETTINGS_JSON" && ${#framework_roles[@]} -gt 0 && -n "$NODE_BIN" ]]; then
  roles_json=$(printf '%s\n' "${framework_roles[@]}" | $NODE_BIN -e '
    const chunks = [];
    process.stdin.on("data", d => chunks.push(d));
    process.stdin.on("end", () => process.stdout.write(JSON.stringify(chunks.join("").trim().split("\n").filter(Boolean))));
  ')
  $NODE_BIN - "$SETTINGS_JSON" "$roles_json" <<'NODEEOF'
const fs = require("node:fs");
const path = process.argv[2];
const roles = new Set(JSON.parse(process.argv[3]));
let s;
try { s = JSON.parse(fs.readFileSync(path, "utf8")); }
catch { process.exit(0); }
const sub = s.subagents || (s.subagents = {});
const ov = sub.agentOverrides || {};
let cleared = 0;
for (const k of Object.keys(ov)) {
  if (roles.has(k)) { delete ov[k]; cleared++; }
}
sub.agentOverrides = ov;
s.subagents = sub;
fs.writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
process.stdout.write(`removed ${cleared} framework overrides from ${path}\n`);
NODEEOF
fi

# 5. Remove empty agent directories (after all cleanup)
for d in "$GLOBAL_AGENTS_DIR" "$PROJECT_AGENTS_DIR"; do
  if [[ -d "$d" && -z "$(ls -A "$d" 2>/dev/null)" ]]; then
    if [[ -n "$DRY_RUN" ]]; then
      echo "would remove empty dir $d"
    else
      if rmdir "$d" 2>/dev/null; then
        echo "rmdir $d (empty dir)"
        removed=$((removed + 1))
      fi
    fi
  fi
done

echo "uninstall complete: removed $removed items"
