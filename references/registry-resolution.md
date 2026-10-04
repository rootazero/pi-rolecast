# Registry resolution reference (pi-rolecast v0.2.0)

Algorithm: spec §6.4 (7 steps).

Three override layers, deep-merged in order (later wins):
1. Built-in: `<framework>/registry/{built_in,aliases}.yaml`
2. User-global: `~/.pi/rolecast/{registry,aliases}-overrides.yaml` (renamed from `~/.pi/agent-workflow/` in v0.2.0)
3. Project-local: `<project>/.pi/rolecast-registry.yaml` (renamed from `agent-workflow-registry.yaml` in v0.2.0)

Status semantics:
- `stable` — resolves normally.
- `deprecated` — resolves with a warning.
- `experimental` — resolves; scaffolder init skips it from defaults.
- `withdrawn` — does NOT resolve. Profile fails to load.
