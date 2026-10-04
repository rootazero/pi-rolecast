---
name: pi-rolecast
description: Multi-agent role framework for Pi. Groups of specialist agents (coding, video, etc.) bound to per-role models, profile-driven, gate-verified. Use when you want a coordinated set of specialised agents with explicit model bindings per role and machine-checkable vs judgement routing.
---

# pi-rolecast

A language-agnostic multi-agent framework. **Profiles** bind roles to models; **gates** verify the project compiles and tests pass; a **scaffolder** bootstraps a profile in any project. v0.2.0 introduces **role groups** (currently `coding`; future: `video`, `research`, `design`, `music`) so the framework can host non-coding roles without name clashes.

## Install

```bash
bash $SKILL_ROOT/scripts/install.sh
```

Default prefix: `~/.pi/agent/`. The installer creates a symlink at `~/.pi/agent/pi-rolecast/` and one per-role symlink at `~/.pi/agent/agents/<group>-<role>.md` for every role under `role-packs/`, so pi-subagents' discovery picks them up.

## Use in a project

```bash
cd <your-project>
python3 $SKILL_ROOT/scripts/scaffolder.py init
# auto-detects language, pre-fills from template, writes .pi/rolecast.yaml
```

Then run gates:

```bash
python3 $SKILL_ROOT/scripts/gate_runner.py --profile .pi/rolecast.yaml
```

## What this framework gives you

- **Role groups** shipped under `role-packs/<group>/`. v0.2.0 ships the `coding` group with 11 specialist roles.
- **Profile-driven model binding**: `bindings.<group>-<role>: { alias, channels }`. Aliases resolve via the built-in registry.
- **Registry overrides** at user-global (`~/.pi/rolecast/registry-overrides.yaml`) and project-local (`<project>/.pi/rolecast-registry.yaml`).
- **Custom roles** declared in profile; agent files live in `<project>/.pi/rolecast-agents/`.
- **Gate runner** with per-phase escalation (`max_attempts`, `on_permanent_failure: stop | continue`).
- **Scaffolder**: `init`, `diff`, `validate`.
- **Rust example profile** under `examples/rust/profile.yaml`.

## Dispatching agents

`sync_settings.py` writes project-local agent files at `<cwd>/.pi/agents/<group>-<role>.md`
with `model: provider/modelId` frontmatter. pi-subagents picks them up via its
standard discovery. Two paths actually dispatch a subagent (both honour the
binding):

- **Mention syntax** in interactive `pi`: `@coding-architect design the API` — pi-subagents
  intercepts in the `input` event and dispatches synchronously.
- **Agent tool** from automation / workflows:
  `Agent({ subagent_type: "coding-architect" })` or `SubagentWorkflow({ agentType: "coding-architect" })`.

Plain text (e.g. `/architect ...`) does NOT dispatch — it is sent to the main LLM.
See [Dispatch model semantics](references/dispatch-model-semantics.md) for the
exact mechanism, why `provider/modelId` is required, and the upstream-bug
caveat.

## Concepts in one paragraph

A profile is project-local. It declares gates (compile / lint / test commands), `workflow.role_groups` (which groups are enabled), bindings (which alias + channel serve each `<group>-<role>` or custom role), non-negotiables (forbidden patterns reviewed by the reviewer role), escalation policy, and optional custom roles. Aliases are framework-level names (`opus-thinking-medium`, `deepseek-verifiable`, `gpt-judgment-high`, etc.) that resolve to a specific model via `registry/aliases.yaml`, with a model having a `status` (`stable | deprecated | experimental | withdrawn`) and a list of channels it can be reached through. The framework does not own execution; it owns the configuration contract.

## Reference docs

- [Profile schema](references/profile-schema.md) — full YAML spec, every field, every validation rule, v0.1.x → v0.2.0 migration table.
- [Registry resolution](references/registry-resolution.md) — alias → model + channel algorithm, override layers, status semantics.
- [Dispatch model semantics](references/dispatch-model-semantics.md) — how `provider/modelId` reaches pi-subagents; `@handle` mention vs `Agent` tool vs plain text.
- [Sync settings](references/sync-settings-usage.md) — how profile bindings reach pi-subagents dispatch (project-local agent files + settings.json bridge).
- [Gate runner usage](references/gate-runner-usage.md) — CLI, exit codes, escalation, logs.
- [Scaffolder usage](references/scaffolder-usage.md) — `init` / `diff` / `validate`, auto-detect, templates.
- [Migration from rust-agent-workflow](references/migration-from-rust-agent-workflow.md) — v0.1.x → v0.2.0 upgrade path (package rename, role prefix, schema change).

## Role catalogue (coding group)

| Role | Output | Trigger |
|---|---|---|
| coding-orchestrator | judgement | (always-on) |
| coding-architect | judgement | "design", "architect" |
| coding-planner | verifiable | "plan" |
| coding-implementer | verifiable | "implement", "code" |
| coding-tester | verifiable | "write tests" |
| coding-reviewer | judgement | "review this diff" |
| coding-mapper | verifiable | "map", "repo map" |
| coding-profiler | verifiable | "profile this" |
| coding-auditor | judgement | "audit security" |
| coding-canary | meta | "is the relay real" |
| coding-docs | generation | "write README" |

See `role-packs/coding/<role>.md` for each role's instructions.
