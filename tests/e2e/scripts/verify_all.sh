#!/usr/bin/env bash
# tests/e2e/scripts/verify_all.sh
#
# Run all verifiers in sequence. Aggregates exit codes.
# Usage: bash verify_all.sh [--skip-gates]
set -uo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_GATES=0
[[ "${1:-}" == "--skip-gates" ]] && SKIP_GATES=1

failures=()
report_pass() { echo "  ✓ $1"; }
report_fail() { echo "  ✗ $1"; failures+=("$1"); }

echo "=== pi-rolecast e2e — full verification ==="
echo

echo "[1/4] verify_dispatch (project-local agent frontmatter)"
if bash "${E2E_DIR}/scripts/verify_dispatch.sh" > /tmp/_vd.txt 2>&1; then
    tail -1 /tmp/_vd.txt
    report_pass "verify_dispatch"
else
    cat /tmp/_vd.txt
    report_fail "verify_dispatch"
fi
echo

echo "[2/4] verify_decomposition (orchestrator output)"
if bash "${E2E_DIR}/scripts/verify_decomposition.sh" > /tmp/_vdec.txt 2>&1; then
    tail -1 /tmp/_vdec.txt
    report_pass "verify_decomposition"
else
    cat /tmp/_vdec.txt
    report_fail "verify_decomposition"
fi
echo

echo "[3/4] verify_cost (token distribution + cost-effectiveness bands)"
if python3 "${E2E_DIR}/scripts/verify_cost.py" > /tmp/_vc.txt 2>&1; then
    report_pass "verify_cost"
else
    cat /tmp/_vc.txt
    report_fail "verify_cost"
fi
echo

echo "[4/4] verify_gates (cargo check / test / clippy)"
if [[ ${SKIP_GATES} -eq 1 ]]; then
    echo "  skipped (--skip-gates)"
else
    if bash "${E2E_DIR}/scripts/verify_gates.sh" > /tmp/_vg.txt 2>&1; then
        report_pass "verify_gates"
    else
        cat /tmp/_vg.txt
        report_fail "verify_gates"
    fi
fi

echo
echo "=== summary ==="
if [[ ${#failures[@]} -eq 0 ]]; then
    echo "ALL PASS"
    exit 0
else
    echo "FAIL (${#failures[@]}): ${failures[*]}"
    exit 1
fi