# Gate runner usage (pi-rolecast v0.2.0)

```bash
python3 $SKILL_ROOT/scripts/gate_runner.py \
    --profile .pi/rolecast.yaml \
    [--phase NAME | --phase all] \
    [--log-dir DIR] \
    [--framework-root DIR]
```

The `--profile` flag also accepts the legacy `.pi/agent-workflow.yaml` filename for one release.

Exit codes: `0` (all phases pass), `1` (phase failed after retries), `2` (config error).

Phases run in declared order. Default escalation: `max_attempts=2`, `on_permanent_failure=stop`, `preserve_logs=true`.

Logs written to `<log-dir>/<timestamp>/<phase>-attempt<N>.log` plus `summary.json` on stdout. Default log directory is `.pi/rolecast-logs/` (was `.pi/agent-workflow-logs/` in v0.1.x).

Non-negotiables are NOT enforced by gate-runner; the reviewer agent checks them at diff-review time.
