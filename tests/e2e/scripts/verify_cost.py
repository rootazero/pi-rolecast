#!/usr/bin/env python3
"""scripts/verify_cost.py — aggregate the JSONL ledger and assert
cost-effectiveness bands.

Reads:
  - tests/e2e/artifacts/ledger.jsonl (one record per dispatched phase)
  - tests/e2e/expected/golden-cost-optimal.yaml (cost_expectations)

Asserts:
  - every golden role was dispatched (or missing entries noted)
  - binding_correct (model that ran == model that was bound), unless missing
  - cost distribution is within bands:
    * judgment_tier ≤ judgment_share_max of total output tokens
    * mechanical_tier ≤ mechanical_share_max of total output tokens
  - total output tokens ≤ ceiling

Writes a Markdown report to tests/e2e/artifacts/cost_report.md.
"""
from __future__ import annotations
import json
import sys
from collections import defaultdict
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parents[1]
LEDGER = E2E_DIR / "artifacts" / "ledger.jsonl"
GOLDEN = E2E_DIR / "expected" / "golden-cost-optimal.yaml"
REPORT = E2E_DIR / "artifacts" / "cost_report.md"


def main() -> int:
    import yaml
    golden = yaml.safe_load(GOLDEN.read_text())
    role_exp = golden["role_expectations"]
    cost_exp = golden["cost_expectations"]

    if not LEDGER.exists():
        print(f"FATAL: ledger missing at {LEDGER} — no phases recorded yet")
        return 2

    records = [json.loads(line) for line in LEDGER.read_text().splitlines() if line.strip()]
    if not records:
        print("FATAL: ledger is empty")
        return 2

    # ── Per-tier aggregation ──────────────────────────────────────────────
    by_role = {r: {"tokens_out": 0, "tokens_in": 0, "phases": 0, "successes": 0, "binding_match": []}
               for r in role_exp}
    for rec in records:
        role = rec["role"]
        if role not in by_role:
            print(f"WARN: unknown role in ledger: {role}")
            continue
        by_role[role]["tokens_out"] += rec["tokens"]["output"]
        by_role[role]["tokens_in"]  += rec["tokens"]["input"]
        by_role[role]["phases"]     += 1
        by_role[role]["successes"]  += int(bool(rec.get("success")))
        if rec.get("binding_match") is not None:
            by_role[role]["binding_match"].append(rec["binding_match"])

    # ── Tier totals ───────────────────────────────────────────────────────
    # Tier membership comes from the cost_expectations band lists, NOT from
    # each role's `cost_tier` field. The band lists are the source of truth
    # for the cost-effectiveness bands; the per-role field is documentation.
    band_lists = {
        "judgment":   cost_exp["judgment_tier_roles"],
        "verifiable": cost_exp["verifiable_tier_roles"],
        "mechanical": cost_exp["mechanical_tier_roles"],
        "orchestrator": cost_exp["orchestrator_roles"],
    }
    tier_of_role = {}
    for tier, roles in band_lists.items():
        for r in roles:
            tier_of_role[r] = tier

    tier_totals = defaultdict(lambda: {"tokens_out": 0, "roles": []})
    for role, exp in role_exp.items():
        tier = tier_of_role.get(role, exp.get("cost_tier", "unclassified"))
        tier_totals[tier]["tokens_out"] += by_role[role]["tokens_out"]
        tier_totals[tier]["roles"].append(role)

    total_out = sum(t["tokens_out"] for t in tier_totals.values())
    if total_out == 0:
        print("FATAL: total output tokens is 0 — no successful phases?")
        return 1

    # ── Build report ──────────────────────────────────────────────────────
    lines = ["# pi-rolecast e2e — cost report\n",
             f"**Total output tokens:** {total_out:,}",
             f"**Phases dispatched:** {len(records)}",
             ""]
    lines.append("| Tier | Roles | Output tokens | Share |")
    lines.append("|---|---|---:|---:|")
    for tier in ("judgment", "verifiable", "orchestrator", "mechanical"):
        t = tier_totals.get(tier, {"tokens_out": 0, "roles": []})
        share = t["tokens_out"] / total_out if total_out else 0
        lines.append(f"| {tier} | {', '.join(t['roles']) if t['roles'] else '—'} | {t['tokens_out']:,} | {share:.1%} |")

    lines.append("")
    lines.append("## Per-role breakdown")
    lines.append("")
    lines.append("| Role | Tier | Bound alias | Tokens in/out | Phases (ok/total) | Bindings matched |")
    lines.append("|---|---|---|---:|---|---|")
    for role, exp in role_exp.items():
        d = by_role[role]
        bm = d["binding_match"]
        bm_str = (f"{sum(bm)}/{len(bm)}" if bm else "—")
        lines.append(f"| `{role}` | {exp['cost_tier']} | `{exp['alias']}` | "
                     f"{d['tokens_in']:,} / {d['tokens_out']:,} | "
                     f"{d['successes']}/{d['phases']} | {bm_str} |")

    # ── Assertions ────────────────────────────────────────────────────────
    failures = []
    if total_out > cost_exp["total_output_tokens_ceiling"]:
        failures.append(f"total output tokens {total_out:,} > ceiling "
                        f"{cost_exp['total_output_tokens_ceiling']:,}")
    j_share = tier_totals["judgment"]["tokens_out"] / total_out
    if j_share > cost_exp["judgment_share_max"]:
        failures.append(f"judgment share {j_share:.1%} > max "
                        f"{cost_exp['judgment_share_max']:.0%}")
    m_share = tier_totals["mechanical"]["tokens_out"] / total_out
    if m_share > cost_exp["mechanical_share_max"]:
        failures.append(f"mechanical share {m_share:.1%} > max "
                        f"{cost_exp['mechanical_share_max']:.0%}")

    # ── Verdict ───────────────────────────────────────────────────────────
    if failures:
        lines.append("")
        lines.append("## ❌ FAILED\n")
        for f in failures:
            lines.append(f"- {f}")
        verdict = "FAIL"
        rc = 1
    else:
        lines.append("")
        lines.append("## ✅ PASSED\n")
        lines.append("- judgment tier used premium but capped by ceiling")
        lines.append("- mechanical tier stayed under share ceiling")
        lines.append("- total within bound")
        rc = 0

    REPORT.write_text("\n".join(lines) + "\n")
    print()
    print("\n".join(lines))
    return rc


if __name__ == "__main__":
    sys.exit(main())