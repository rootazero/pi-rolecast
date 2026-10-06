#!/usr/bin/env python3
"""scripts/record_phase.py — append one dispatch outcome to the JSONL ledger.

The e2e orchestrator (a Pi agent session) runs each phase by invoking the
Agent tool with the bound role. After each Agent call returns, the
orchestrator invokes this script to record:

  - the role name (e.g. coding-architect)
  - the bound alias and resolved (model_id, provider, channel)
  - the prompt + output character counts (proxy for tokens: 1 token ≈ 4 chars)
  - success / failure

The ledger lives at tests/e2e/artifacts/ledger.jsonl. Cost-effectiveness
verifier reads it after all phases complete.

Usage:
  python3 record_phase.py \\
    --role coding-architect \\
    --alias gpt-judgment-high \\
    --expected-model gpt-5.5 \\
    --expected-provider openai-codex \\
    --expected-channel official \\
    --input-chars 1234 \\
    --output-chars 5678 \\
    --actual-model gpt-5.5 \\
    --success \\
    --artifact /path/to/role-output.txt
"""
from __future__ import annotations
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

LEDGER = Path(__file__).resolve().parents[1] / "artifacts" / "ledger.jsonl"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--role", required=True)
    p.add_argument("--alias", required=True)
    p.add_argument("--expected-model", required=True)
    p.add_argument("--expected-provider", required=True)
    p.add_argument("--expected-channel", required=True)
    p.add_argument("--input-chars", type=int, required=True)
    p.add_argument("--output-chars", type=int, required=True)
    p.add_argument("--actual-model", default=None,
                   help="model that actually ran (may differ if bound model "
                        "unreachable and dispatch fell back)")
    p.add_argument("--actual-provider", default=None)
    p.add_argument("--success", action="store_true")
    p.add_argument("--artifact", type=Path, default=None,
                   help="path to the role's output artifact (e.g. the .rs file written)")
    p.add_argument("--notes", default="")
    args = p.parse_args()

    # Rough token proxy: 1 token ≈ 4 chars (English text/code).
    in_tok = max(1, args.input_chars // 4)
    out_tok = max(1, args.output_chars // 4)

    record = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "role": args.role,
        "alias": args.alias,
        "expected": {
            "model": args.expected_model,
            "provider": args.expected_provider,
            "channel": args.expected_channel,
        },
        "actual": {
            "model": args.actual_model,
            "provider": args.actual_provider,
        },
        "tokens": {"input": in_tok, "output": out_tok, "total": in_tok + out_tok},
        "success": args.success,
        "artifact": str(args.artifact) if args.artifact else None,
        "notes": args.notes,
        "binding_match": (args.actual_model == args.expected_model) if args.actual_model else None,
    }
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    print(f"recorded: {args.role} ({in_tok}+{out_tok} tokens, "
          f"alias={args.alias}, success={args.success})")
    return 0


if __name__ == "__main__":
    sys.exit(main())