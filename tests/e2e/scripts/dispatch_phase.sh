#!/usr/bin/env bash
# tests/e2e/scripts/dispatch_phase.sh — documented dispatch interface.
#
# This script is NOT the actual dispatch path. The actual dispatch happens
# in the Pi agent runtime (via the Agent tool with subagent_type=coding-*).
# This script is the documented contract so the run is reproducible.
#
# Usage in the runtime:
#   Agent({
#     subagent_type: "coding-<role>",
#     prompt: "<task spec>",
#     run_in_background: false,
#   })
#   python3 scripts/record_phase.py --role coding-<role> --alias <x> ...
#
# What this bash script does:
#   1. Resolves the role's bound (alias, model_id, provider, channel) from
#      .pi/agents/<role>.md + the override registry.
#   2. Prints the resolved binding as machine-friendly JSON so the runtime
#      can pass the right --expected-* values to record_phase.py.
#   3. Asserts the role's frontmatter matches the golden expectation.
#
# Exit 0 = binding resolved, JSONL printed on stdout.
# Exit non-zero = binding broken or missing artifact.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${E2E_DIR}/fixtures/todo-tui"
GOLDEN="${E2E_DIR}/expected/golden-cost-optimal.yaml"
REGISTRY="${FIXTURE}/.pi/rolecast-registry.yaml"
PROFILE="${FIXTURE}/.pi/rolecast.yaml"
AGENT_FILE="${FIXTURE}/.pi/agents"

usage() {
    echo "usage: $0 <role-without-prefix>   e.g. $0 architect" >&2
    echo "       prints the resolved binding contract as JSON." >&2
    exit 64
}

[[ $# -eq 1 ]] || usage
role_short="$1"
role="coding-${role_short}"
agent_md="${AGENT_FILE}/${role}.md"
[[ -f "${agent_md}" ]] || { echo "missing ${agent_md} — run setup.sh first" >&2; exit 2; }

python3 - <<PY
import sys, yaml, re, json, pathlib

golden = yaml.safe_load(pathlib.Path("${GOLDEN}").read_text())["role_expectations"]
agent_md = pathlib.Path("${agent_md}")
text = agent_md.read_text()
# Parse frontmatter
m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
fm = yaml.safe_load(m.group(1)) if m else {}
expected = golden["${role}"]
result = {
    "role": "${role}",
    "expected": expected,
    "frontmatter": {
        "model": fm.get("model"),
        "thinking": fm.get("thinking"),
    },
    "binding_correct": (
        fm.get("model") == f"{expected['provider']}/{expected['model_id']}"
    ),
}
print(json.dumps(result, indent=2))
sys.exit(0 if result["binding_correct"] else 1)
PY