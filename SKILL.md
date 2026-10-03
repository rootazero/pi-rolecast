---
name: pi-agent-workflow
description: Language-agnostic multi-agent workflow framework. Profile-driven model binding, gate-based verification, scaffolder for project bootstrap. Use when you want a coordinated set of specialised agents (architect, implementer, reviewer, etc.) with explicit machine-checkable vs judgement routing.
---

# pi-agent-workflow

A language-agnostic multi-agent framework. Profiles describe which model + channel serves each role; gate-runner verifies the project's gates; scaffolder bootstraps a profile in any project.

## Install

```bash
bash $SKILL_ROOT/scripts/install.sh
```

Default prefix: `~/.pi/agent/`. The installer creates a symlink at `~/.pi/agent/pi-agent-workflow/` and one per-role symlink at `~/.pi/agent/agent-<role>/SKILL.md` so pi's discovery picks them up.

## Use in a project

```bash
cd <your-project>
python3 $SKILL_ROOT/scripts/scaffolder.py init
# auto-detects language, pre-fills from template, writes .pi/agent-workflow.yaml
```

Then run gates:

```bash
python3 $SKILL_ROOT/scripts/gate_runner.py --profile .pi/agent-workflow.yaml
```

## What this framework gives you

- **11 immutable core roles** with default trigger phrases (architect, planner, implementer, tester, reviewer, mapper, profiler, auditor, canary, docs, orchestrator).
- **Profile-driven model binding**: `bindings.<role>: { alias, channels }`. Aliases resolve via the built-in registry.
- **Registry overrides** at user-global (`~/.pi/agent-workflow/registry-overrides.yaml`) and project-local (`<project>/.pi/agent-workflow-registry.yaml`) — to add or retire models.
- **Custom roles** declared in profile; agent files live in `<project>/.pi/agent-workflow-agents/`.
- **Gate runner** with per-phase escalation (`max_attempts`, `on_permanent_failure: stop | continue`).
- **Scaffolder**: `init`, `diff`, `validate`.
- **Rust example profile** under `examples/rust/profile.yaml`.

## Concepts in one paragraph

A profile is project-local. It declares gates (compile / lint / test commands), bindings (which alias + channel serve each role), non-negotiables (forbidden patterns reviewed by the reviewer role), escalation policy, and optional custom roles. Aliases are framework-level names (`opus-thinking-medium`, `deepseek-verifiable`, `gpt-judgment-high`, etc.) that resolve to a specific model via `registry/aliases.yaml`, with a model having a `status` (`stable | deprecated | experimental | withdrawn`) and a list of channels it can be reached through. The framework does not own execution; it owns the configuration contract.

## Reference docs

- [Profile schema](references/profile-schema.md) — full YAML spec, every field, every validation rule.
- [Registry resolution](references/registry-resolution.md) — alias → model + channel algorithm, override layers, status semantics.
- [Gate runner usage](references/gate-runner-usage.md) — CLI, exit codes, escalation, logs.
- [Scaffolder usage](references/scaffolder-usage.md) — `init` / `diff` / `validate`, auto-detect, templates.
- [Migration from rust-agent-workflow](references/migration-from-rust-agent-workflow.md) — rename table, manual steps.

## Role catalogue

| Role | Output | Trigger |
|---|---|---|
| orchestrator | judgement | (always-on) |
| architect | judgement | "design", "architect" |
| planner | verifiable | "plan" |
| implementer | verifiable | "implement", "code" |
| tester | verifiable | "write tests" |
| reviewer | judgement | "review this diff" |
| mapper | verifiable | "map", "repo map" |
| profiler | verifiable | "profile this" |
| auditor | judgement | "audit security" |
| canary | meta | "is the relay real" |
| docs | generation | "write README" |

See `agents/<role>.md` for each role's instructions.

## Spec and plan

- Spec: `docs/superpowers/specs/2026-10-03-pi-agent-workflow-design.md`
- Plan: `docs/superpowers/plans/2026-10-03-pi-agent-workflow.md`
