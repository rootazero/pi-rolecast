#!/usr/bin/env bash
# tests/e2e/scripts/verify_dispatch.sh
#
# Asserts every project-local .pi/agents/<role>.md frontmatter matches the
# cost-optimal golden. Exits 0 if all 11 roles pass.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${E2E_DIR}/fixtures/todo-tui"
GOLDEN="${E2E_DIR}/expected/golden-cost-optimal.yaml"
AGENTS_DIR="${FIXTURE}/.pi/agents"

[[ -d "${AGENTS_DIR}" ]] || {
    echo "FATAL: ${AGENTS_DIR} missing — run setup.sh first" >&2
    exit 2
}

export E2E_GOLDEN="${GOLDEN}"
export E2E_AGENTS="${AGENTS_DIR}"

python3 - <<'PY'
import os, sys, yaml, re, pathlib

golden = yaml.safe_load(pathlib.Path(os.environ["E2E_GOLDEN"]).read_text())["role_expectations"]
agents_dir = pathlib.Path(os.environ["E2E_AGENTS"])

failures = []
for role, exp in golden.items():
    md = agents_dir / f"{role}.md"
    if not md.exists():
        failures.append(f"{role}: missing agent file")
        continue
    text = md.read_text()
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    if not m:
        failures.append(f"{role}: no frontmatter")
        continue
    fm = yaml.safe_load(m.group(1))
    expected_full = f"{exp['provider']}/{exp['model_id']}"
    actual = fm.get("model")
    if actual != expected_full:
        failures.append(f"{role}: model frontmatter '{actual}' != expected '{expected_full}'")
        continue
    print(f"  ok    {role:30s} -> {actual:30s}  thinking={fm.get('thinking','?'):6s}  tier={exp['cost_tier']}")

if failures:
    print()
    print(f"FAIL ({len(failures)} bindings wrong):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)

print()
print(f"OK  all 11 role bindings match the cost-optimal golden")
PY