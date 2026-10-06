#!/usr/bin/env bash
# tests/e2e/scripts/setup.sh
#
# One-shot bootstrap for the pi-rolecast e2e fixture.
# Writes the project-local registry override, copies the cost-optimal profile,
# then runs sync_settings.py + scaffolder validate. Idempotent.
#
# After this script the fixture is ready for dispatch_phase.sh calls.
#
# Resolves the framework root via $PI_ROLECAST_ROOT or the install symlink.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${E2E_DIR}/fixtures/todo-tui"
PROFILE_SRC="${E2E_DIR}/profiles/cost-optimal.yaml"
REGISTRY_SRC="${E2E_DIR}/registry-overrides/rolecast-registry.yaml"

# Resolve framework root: PI_ROLECAST_ROOT env wins, else default install path.
if [[ -n "${PI_ROLECAST_ROOT:-}" ]]; then
    ROOT="${PI_ROLECAST_ROOT}"
else
    # Default install symlink at ~/.pi/agent/pi-rolecast/
    if [[ -L "${HOME}/.pi/agent/pi-rolecast" ]]; then
        ROOT="$(readlink -f "${HOME}/.pi/agent/pi-rolecast")"
    else
        ROOT="$(cd "${E2E_DIR}/../.." && pwd)"
    fi
fi

echo "[setup] framework root: ${ROOT}"
echo "[setup] fixture:        ${FIXTURE}"

mkdir -p "${FIXTURE}/.pi"

# ── 1. Copy project-local registry override ──────────────────────────────
cp -f "${REGISTRY_SRC}" "${FIXTURE}/.pi/rolecast-registry.yaml"
echo "[setup] wrote ${FIXTURE}/.pi/rolecast-registry.yaml"

# ── 2. Copy profile ──────────────────────────────────────────────────────
cp -f "${PROFILE_SRC}" "${FIXTURE}/.pi/rolecast.yaml"
echo "[setup] wrote ${FIXTURE}/.pi/rolecast.yaml"

# ── 3. Validate the profile ──────────────────────────────────────────────
echo
echo "[setup] ── scaffolder validate ──"
( cd "${FIXTURE}" && python3 "${ROOT}/scripts/scaffolder.py" validate --profile .pi/rolecast.yaml )

# ── 4. Sync profile bindings → project-local agent files ─────────────────
# Project-local .pi/agents/<role>.md wins over any global default.
# We do NOT touch ~/.pi/agent/settings.json (skip --settings-write).
echo
echo "[setup] ── sync_settings.py ──"
( cd "${FIXTURE}" && python3 "${ROOT}/scripts/sync_settings.py" --profile .pi/rolecast.yaml )

# ── 5. Show what was synced ──────────────────────────────────────────────
echo
echo "[setup] ── generated project-local agent files ──"
ls -la "${FIXTURE}/.pi/agents/" || true

echo
echo "[setup] ── sample frontmatter (coding-architect) ──"
head -8 "${FIXTURE}/.pi/agents/coding-architect.md" || true

echo
echo "[setup] DONE. Fixture ready for dispatch_phase.sh."