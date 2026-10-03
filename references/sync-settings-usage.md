# Sync settings usage

The framework's profile bindings (alias -> model + channel) need to reach the actual Pi subagent dispatcher. `sync_settings.py` is that bridge.

## What it writes

When you run sync_settings against a project with a profile, two things happen:

1. **settings.json** — `~/.pi/agent/settings.json` -> `subagents.agentOverrides.<role>.{model,channel}` for each core role. (Pi core does not currently read this key for dispatch; it is kept for parity with prior skills and debugging.)
2. **Project-local agent files** — `<project>/.pi/agents/<role>.md` is written with `model:` and `thinking:` frontmatter set from your binding. These project-local copies **win** over the global symlinks per pi-subagents' load order (project > workspace > global).

## Commands

```bash
python3 $SKILL_ROOT/scripts/sync_settings.py \
    --profile .pi/agent-workflow.yaml \       # source of truth
    --framework-root $SKILL_ROOT              # where framework agent files live
```

Useful flags:
- `--status` — show current sync state vs profile bindings; flags `DRIFT` if a project-local agent file's model field was manually edited away from the binding. Exits 0 regardless (informational only).
- `--dry-run` — print what would be written without touching disk.
- `--clear` — remove all framework-managed role overrides from settings.json + delete the 11 project-local agent files. User-made files and symlinks in the agents dir are preserved.
- `--no-settings` / `--no-agents` — skip settings.json / project-local agent files respectively.
- `--agents-dir <path>` — override the default `.pi/agents/` location.
- `--settings <path>` — override `~/.pi/agent/settings.json`.

## When sync runs

- Automatically by `scripts/install.sh` whenever a profile is found in the cwd.
- Manually by you whenever you edit `.pi/agent-workflow.yaml` and want the change to take effect.

## pi-subagents dependency

`@tintinweb/pi-subagents` must be installed for role dispatch to actually work. `install.sh` warns when it's missing:

```
WARNING: pi-subagents not found in ~/.pi/agent/settings.json packages[]
  Role symlinks are installed but dispatch won't work without pi-subagents.
  Install with:  pi install npm:@tintinweb/pi-subagents
```

## `model:` resolution chain

When sync_settings resolves `model:` for a binding:

1. Profile binding specifies an alias (e.g. `opus-thinking-medium`).
2. Alias resolution uses the 3-layer registry merge (built-in -> user-global -> project-local). The alias points to a model ID (e.g. `MiniMax-M3`).
3. That model ID is written verbatim into the project-local agent file's `model:` frontmatter.

## `thinking:` resolution

The project-local agent file's `thinking:` field is preserved from the framework agent's default. Each role's default is set by its output category:
- Judgement roles (orchestrator, architect, auditor, reviewer): `high`
- Meta roles (mapper, planner, profiler, docs): `medium`
- Verifiable roles (implementer, tester, canary): `low`

If you want to override `thinking:` per project, edit the project-local file after sync.

## Slash command vs subagent dispatch

The `model:` field in the project-local agent file is **only honoured when the
role is spawned as a subagent** (via the Agent tool with `subagent_type:`,
or via `SubagentWorkflow({ agentType: ... })`). When you invoke a role via
the slash command (`/architect`, `/orchestrator`, …), pi-subagents injects
the agent's system prompt into the current session but the session's model
stays as the default set at startup — the agent file's `model:` field is
ignored on this path.

See [`dispatch-model-semantics.md`](./dispatch-model-semantics.md) for the
full explanation and the `provider/modelId` format rationale.

## provider/modelId format

`sync_settings.py` rewrites each binding to `provider/modelId` (e.g.
`minimax-cn/MiniMax-M3`, `openai-codex/gpt-6.1-sol`) before writing it
into the agent file. `pi-subagents` `resolveDefaultModel` only parses
strings that contain a `/`; plain `MiniMax-M3` would silently fall back to
the parent session's model.