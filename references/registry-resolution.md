# Registry resolution reference

Algorithm: spec §6.4 (7 steps).

Three override layers, deep-merged in order (later wins):
1. Built-in: `<framework>/registry/{built_in,aliases}.yaml`
2. User-global: `~/.pi/agent-workflow/{registry,aliases}-overrides.yaml`
3. Project-local: `<project>/.pi/agent-workflow-registry.yaml`

Status semantics:
- `stable` — resolves normally.
- `deprecated` — resolves with a warning.
- `experimental` — resolves; scaffolder init skips it from defaults.
- `withdrawn` — does NOT resolve. Profile fails to load.
