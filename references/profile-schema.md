# Profile schema reference (pi-rolecast v0.2.0)

Full schema lives at `docs/superpowers/specs/2026-10-03-pi-agent-workflow-design.md` (historical) and the live validator at `scripts/profile_loader.py`.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `framework_version` | string | yes | Must match the installed framework version (e.g. `0.2.0`). |
| `name` | string | yes | Human-readable profile name. |
| `description` | string | yes | One-paragraph summary. |
| `workflow` | mapping | yes (v0.2.0+) | Holds `role_groups`. |
| `workflow.role_groups` | list[string] | yes | Which role groups are enabled. Empty list = no roles enabled. |
| `gates` | mapping | yes | Phase name → `{commands, timeout}`. May be empty. |
| `bindings` | mapping | yes | Full role name (`<group>-<role>` or custom name) → `{alias, channels}`. May be empty. |
| `non_negotiables` | mapping | no | `forbidden_patterns`, `scope_constraints`, `required_gates`. |
| `escalation` | mapping | no | `max_attempts`, `on_permanent_failure`, `preserve_logs`. |
| `trigger_overrides` | mapping | no | Phrase → `{role}`. |
| `custom_roles` | list | no | User-defined roles. |

## Roles and groups

Roles live in `role-packs/<group>/<role>.md` in the framework installation. The v0.2.0 release ships the `coding` group with 11 roles. Each role md file has YAML frontmatter:

```yaml
---
name: coding-architect
category: coding
description: Design system boundaries, public APIs, error strategies.
model: deepseek-flash
thinking: high
---
```

The `name:` field is the full role name used in profile bindings and dispatch mentions. It must match `<group>-<role>` so the `<group>-<role>` mention syntax (`@coding-architect`) works through pi-subagents.

Profile bindings reference these full names:

```yaml
bindings:
  coding-architect:    {alias: opus-thinking-medium, channels: [official]}
  coding-implementer:  {alias: deepseek-verifiable, channels: [official]}
  # ...
```

## Validation rules

1. `bindings` keys must be one of the role names from enabled `workflow.role_groups`, OR a `custom_roles` entry.
2. Each `alias` must resolve to a non-`withdrawn` model in the merged registry.
3. Each `channels` entry must be one the resolved model supports.
4. `gates` phases run in declared order; `--phase <undeclared>` is a config error.
5. Trigger phrase collisions across framework defaults + profile overrides + custom role triggers → error.
6. `forbidden_patterns[*].pattern` must compile as a regex.
7. `workflow.role_groups` must be a list of strings; group names not present in `role-packs/` cause the loader to skip them silently (an empty group is treated as "no roles available").

## Migration from v0.1.x

The legacy profile filename `.pi/agent-workflow.yaml` is still recognised for one release. Profile schema changes required:

| v0.1.x field | v0.2.0 replacement |
|---|---|
| `bindings: { architect: ... }` | `bindings: { coding-architect: ... }` + `workflow.role_groups: [coding]` |
| Profile file `.pi/agent-workflow.yaml` | `.pi/rolecast.yaml` |
| (no equivalent) | `workflow.role_groups: [...]` |

The profile loader prints a one-line hint when a legacy role name is detected in a binding.
