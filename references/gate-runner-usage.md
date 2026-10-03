# Gate runner usage

```bash
python3 $SKILL_ROOT/scripts/gate_runner.py \
    --profile .pi/agent-workflow.yaml \
    [--phase NAME | --phase all] \
    [--log-dir DIR] \
    [--framework-root DIR]
```

Exit codes: `0` (all phases pass), `1` (phase failed after retries), `2` (config error).

Phases run in declared order. Default escalation: `max_attempts=2`, `on_permanent_failure=stop`, `preserve_logs=true`.

Logs written to `<log-dir>/<timestamp>/<phase>-attempt<N>.log` plus `summary.json` on stdout.

Non-negotiables are NOT enforced by gate-runner; the reviewer agent checks them at diff-review time. See spec §8.4.
