#!/usr/bin/env bash
# tests/e2e/scripts/verify_gates.sh
#
# Run the gate-runner on the fixture. Exercises compile / lint / test phases.
# Exits 0 only if all phases pass.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${E2E_DIR}/fixtures/todo-tui"

if [[ -n "${PI_ROLECAST_ROOT:-}" ]]; then
    ROOT="${PI_ROLECAST_ROOT}"
else
    if [[ -L "${HOME}/.pi/agent/pi-rolecast" ]]; then
        ROOT="$(readlink -f "${HOME}/.pi/agent/pi-rolecast")"
    else
        ROOT="$(cd "${E2E_DIR}/../.." && pwd)"
    fi
fi

echo "[gates] framework root: ${ROOT}"
echo "[gates] fixture:        ${FIXTURE}"

cd "${FIXTURE}"
python3 "${ROOT}/scripts/gate_runner.py" --profile .pi/rolecast.yaml