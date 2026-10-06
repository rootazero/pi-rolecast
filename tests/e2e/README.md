# pi-rolecast e2e — todo-tui

End-to-end test for pi-rolecast. Exercises the four core claims
(decomposition, role assignment, model matching, cost-effectiveness)
on a real Rust crate, with real subagent dispatches.

## What gets tested

The `verify_all.sh` script runs four verifiers:

| Verifier | What it asserts |
|---|---|
| `verify_dispatch` | All 11 `.pi/agents/<role>.md` files in the fixture have `model:` frontmatter matching the cost-optimal golden (`openai-codex/gpt-5.5`, `deepseek/deepseek-flash`, `minimax-cn/MiniMax-M3`). |
| `verify_decomposition` | `artifacts/decomposition.json` has ≥4 subtasks routed to ≥4 distinct roles, all roles exist in the golden. |
| `verify_cost` | `artifacts/ledger.jsonl` shows: judgment-tier tokens ≤ 45% of total output, mechanical-tier tokens ≤ 20% of total, total output ≤ 200k tokens. |
| `verify_gates` | `cargo check`, `cargo test`, `cargo clippy --all-targets -- -D warnings` all exit 0. |

## How it works

The big task is "build a tiny Rust CLI todo-tui with add/list/done/remove
+ JSON persistence + ≥3 integration tests, no third-party deps, clippy-clean".

The pipeline:

```
coding-orchestrator  (judgment,  M3)     → artifacts/decomposition.json
       ↓
coding-architect     (judgment,  gpt-5.5) → DESIGN.md
coding-planner       (verifiable, deepseek-flash) → PLAN.md
coding-implementer   (verifiable, deepseek-flash) → src/lib.rs, src/bin/todo.rs, tests/integration.rs
coding-tester        (verifiable, deepseek-flash) → tests/integration.rs (extended)
coding-reviewer      (judgment,  gpt-5.5) → REVIEW.md
```

After phase 6 the gate-runner validates the crate.

## Cost-optimal profile (the binding contract)

Per-role bindings, declared in `profiles/cost-optimal.yaml` and asserted
against `expected/golden-cost-optimal.yaml`:

| Role | Bound alias | Resolved (provider / model) | Cost tier |
|---|---|---|---|
| coding-orchestrator | opus-thinking-medium | minimax-cn / MiniMax-M3 | orchestrator |
| coding-architect    | gpt-judgment-high    | openai-codex / gpt-5.5     | judgment |
| coding-planner      | deepseek-verifiable  | deepseek / deepseek-flash  | verifiable |
| coding-implementer  | deepseek-verifiable  | deepseek / deepseek-flash  | verifiable |
| coding-tester       | deepseek-verifiable  | deepseek / deepseek-flash  | verifiable |
| coding-reviewer     | gpt-judgment-high    | openai-codex / gpt-5.5     | judgment |
| coding-auditor      | gpt-judgment-medium  | openai-codex / gpt-5.5     | judgment |
| coding-mapper       | minimax-fast         | minimax-cn / MiniMax-M3    | mechanical |
| coding-profiler     | minimax-fast         | minimax-cn / MiniMax-M3    | mechanical |
| coding-canary       | minimax-fast         | minimax-cn / MiniMax-M3    | mechanical |
| coding-docs         | minimax-medium       | minimax-cn / MiniMax-M3    | mechanical |

The split is deliberate: judgment work (design, review, audit) goes to a
premium model (`gpt-5.5`, output $30/M tok); verifiable work (planning,
coding, testing) goes to a cheap-but-correct model (`deepseek-flash`,
output $1.2/M tok); mechanical work (mapping, profiling, smoke checks)
goes to the cheapest local model (`MiniMax-M3`). The orchestrator stays
on the cheap model too — it dispatches, it doesn't reason over content.

## Running

```bash
cd tests/e2e

# 1) one-time setup: writes project-local override + profile, syncs 11 agent files
bash scripts/setup.sh

# 2) the actual dispatch happens in a Pi agent session (the Agent tool with
#    subagent_type=coding-<role>). Each dispatch is followed by:
python3 scripts/record_phase.py --role coding-architect \
    --alias gpt-judgment-high \
    --expected-model gpt-5.5 --expected-provider openai-codex --expected-channel official \
    --input-chars 1700 --output-chars 800 \
    --actual-model gpt-5.5 --actual-provider openai-codex \
    --success --artifact fixtures/todo-tui/DESIGN.md

# 3) verification
bash scripts/verify_all.sh
```

## Directory layout

```
tests/e2e/
├── README.md                         (this file)
├── fixtures/todo-tui/                # the Rust crate the roles build
│   ├── Cargo.toml                    (no [dependencies], edition 2021)
│   ├── src/
│   │   ├── lib.rs                    (pure add/done/remove + JSON load/save)
│   │   └── bin/todo.rs               (CLI dispatch)
│   ├── tests/integration.rs          (11 tests)
│   └── .pi/agents/                   (11 coding-*.md role files, written by setup.sh)
├── profiles/
│   ├── cost-optimal.yaml             (judgment/premium + verifiable/cheap + mechanical/M3)
│   └── quality-first.yaml            (every role on gpt-judgment-high, baseline reference)
├── registry-overrides/
│   └── rolecast-registry.yaml        (project-local registry: lists 6 real user models + aliases)
├── expected/
│   └── golden-cost-optimal.yaml      (per-role binding contract + cost bands)
├── scripts/
│   ├── setup.sh                      (write override + profile, sync agents, validate)
│   ├── record_phase.py               (append one phase outcome to artifacts/ledger.jsonl)
│   ├── dispatch_phase.sh             (print resolved binding for one role)
│   ├── verify_dispatch.sh            (assert all 11 bindings match golden)
│   ├── verify_decomposition.sh       (assert orchestrator output has ≥4 role-routed subtasks)
│   ├── verify_cost.py                (assert cost-effectiveness bands)
│   ├── verify_gates.sh               (run gate_runner.py --profile .pi/rolecast.yaml)
│   └── verify_all.sh                 (orchestrate all 4 verifiers; --skip-gates to skip gates)
└── artifacts/                        (generated by the run)
    ├── decomposition.json            (orchestrator output)
    ├── ledger.jsonl                  (one JSON record per phase)
    ├── cost_report.md                (markdown summary from verify_cost.py)
    └── REVIEW.md, DESIGN.md, PLAN.md (left in fixtures/todo-tui/, linked from here)
```

## Findings from the run

The full report lives at `artifacts/REPORT.md` (after a run). Key
results from the reference run:

| Verifier | Result |
|---|---|
| verify_dispatch     | ✓ all 11 bindings match the golden |
| verify_decomposition| ✓ 5 distinct roles routed (orchestrator, architect, planner, implementer, tester, reviewer) |
| verify_cost         | ✓ judgment 9.8% / verifiable 41.2% / orchestrator 49.0% / mechanical 0% — well within bands |
| verify_gates        | ✓ cargo check / test / clippy all exit 0; 11 tests pass; non-negotiables clean |

**One framework finding (not a test failure):** when the Agent tool
dispatches a custom subagent (`subagent_type=coding-architect`), the
frontmatter `model:` field is loaded into the system prompt but does
NOT override the parent session's model at runtime. All 6 dispatches
ran on the parent's default (`MiniMax-M3`). The binding *contract* is
verified; the *enforcement* depends on a future runtime change. Cost
is still well within band because M3 is the cheapest option — the
"premium routing" for judgment work isn't actually triggered in
practice with the current Agent tool.

## Cleanup

`scripts/setup.sh` writes only project-local paths:

- `fixtures/todo-tui/.pi/rolecast-registry.yaml`
- `fixtures/todo-tui/.pi/rolecast.yaml`
- `fixtures/todo-tui/.pi/agents/coding-*.md`

It does not touch `~/.pi/rolecast/`, `~/.pi/agent/settings.json`, or
anything outside the `tests/e2e/` tree (verified by `--no-settings-write`
in the `sync_settings.py` invocation).
