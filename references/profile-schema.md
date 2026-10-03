# Profile schema reference

Full schema lives at `docs/superpowers/specs/2026-10-03-pi-agent-workflow-design.md` §5.

Top-level fields: `framework_version`, `name`, `description`, `gates`, `bindings`, `non_negotiables`, `escalation`, `trigger_overrides`, `custom_roles`.

Validation is enforced by `scripts/profile_loader.py` (single source of truth for spec §5.3). `scaffolder validate` and `gate_runner` both delegate to it.

## Validation rules summary

1. `bindings` keys must be one of 11 core roles or declared in `custom_roles`.
2. Each `alias` must resolve to a non-`withdrawn` model in the merged registry.
3. Each `channels` entry must be one the resolved model supports.
4. `gates` phases run in declared order; `--phase <undeclared>` is a config error.
5. Trigger phrase collisions across framework defaults + profile overrides + custom role triggers → error.
6. `forbidden_patterns[*].pattern` must compile as a regex.
