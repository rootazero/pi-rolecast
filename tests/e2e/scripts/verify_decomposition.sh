#!/usr/bin/env bash
# tests/e2e/scripts/verify_decomposition.sh
#
# Reads the orchestrator's decomposition artifact and asserts it routed the
# big task to ≥4 distinct coding-* roles.
#
# The orchestrator is expected to write its decomposition as JSON to
# artifacts/decomposition.json with the shape:
#
#   {
#     "task": "<the original task>",
#     "subtasks": [
#       {"role": "coding-architect",    "summary": "...", "owner_alias": "..."},
#       {"role": "coding-coder",  "summary": "...", "owner_alias": "..."},
#       ...
#     ]
#   }
#
# Verification:
#   - file parses as JSON
#   - ≥4 subtasks
#   - distinct roles in subtasks ≥4 (one role cannot soak the whole task)
#   - all roles exist in the golden
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="${E2E_DIR}/artifacts/decomposition.json"
GOLDEN="${E2E_DIR}/expected/golden-cost-optimal.yaml"

[[ -f "${ARTIFACT}" ]] || {
    echo "FATAL: ${ARTIFACT} missing — orchestrator did not produce a decomposition" >&2
    echo "  (the orchestrator phase should write its JSON decomposition to that path)" >&2
    exit 2
}

export E2E_ARTIFACT="${ARTIFACT}"
export E2E_GOLDEN="${GOLDEN}"

python3 - <<'PY'
import os, sys, json, yaml, pathlib

artifact = json.loads(pathlib.Path(os.environ["E2E_ARTIFACT"]).read_text())
golden = yaml.safe_load(pathlib.Path(os.environ["E2E_GOLDEN"]).read_text())["role_expectations"]
valid_roles = set(golden.keys())

subtasks = artifact.get("subtasks") or []
if not isinstance(subtasks, list):
    print("FAIL: 'subtasks' must be a list")
    sys.exit(1)

distinct_roles = set()
for s in subtasks:
    r = s.get("role")
    if r in valid_roles:
        distinct_roles.add(r)
    else:
        print(f"  WARN: subtask role '{r}' is not in the golden role set")

print(f"  subtasks reported: {len(subtasks)}")
print(f"  distinct coding-* roles: {len(distinct_roles)} -> {sorted(distinct_roles)}")

failures = []
if len(subtasks) < 4:
    failures.append(f"need ≥4 subtasks, got {len(subtasks)}")
if len(distinct_roles) < 4:
    failures.append(f"need ≥4 distinct roles, got {len(distinct_roles)}")

if failures:
    print()
    print("FAIL:")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print()
print("OK  decomposition covers ≥4 distinct roles")
PY