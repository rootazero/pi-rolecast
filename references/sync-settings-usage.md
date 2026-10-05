# Sync settings usage (pi-rolecast v0.2.0)

The framework's profile bindings (alias -> model + channel) need to reach the actual Pi subagent dispatcher. `sync_settings.py` is that bridge.

## What it writes

When you run sync_settings against a project with a profile, the **default** behaviour is:

1. **Project-local agent files** — `<project>/.pi/agents/<group>-<role>.md` is written with `model:` and `thinking:` frontmatter set from your binding. The full role name matches the binding key so pi-subagents can find it via `@<full-role-name>` mention syntax or `subagent_type: "<full-role-name>"`. This is the **authoritative dispatch path**.

**Opt-in** (off by default since v0.4.0):

2. **settings.json** — `~/.pi/agent/settings.json` -> `subagents.agentOverrides.<full-role-name>.{model,channel}` for each bound role. Pi core does not read this key for dispatch; it is kept for parity with prior skills and for any third-party extension that still consults it. Pass `--settings-write` to emit it.

## Commands

```bash
python3 $SKILL_ROOT/scripts/sync_settings.py \
    --profile .pi/rolecast.yaml \       # source of truth (legacy .pi/agent-workflow.yaml also accepted)
    --framework-root $SKILL_ROOT        # where role-packs/ lives
```

Useful flags:
- `--status` — show current sync state vs profile bindings; flags `DRIFT` if a project-local agent file's model field was manually edited away from the binding. Exits 0 regardless (informational only).
- `--dry-run` — print what would be written without touching disk.
- `--clear` — scrub framework entries from settings.json (when present) and delete every project-local agent file. User-made files and symlinks in the agents dir are preserved.
- `--settings-write` — also write `subagents.agentOverrides` into `settings.json` (default: skip; project-local agent files are authoritative).
- `--no-agents` — skip writing project-local agent files (e.g. for settings-write only).
- `--agents-dir <path>` — override the default `.pi/agents/` location.
- `--settings <path>` — override `~/.pi/agent/settings.json`.
- `--list-groups` — list available role groups from `role-packs/` and exit.

## When sync runs

- Automatically by `scripts/install.sh` whenever a profile is found in the cwd.
- Manually by you whenever you edit `.pi/rolecast.yaml` and want the change to take effect.

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
2. Alias resolution uses the 3-layer registry merge (built-in -> user-global `~/.pi/rolecast/registry-overrides.yaml` -> project-local `.pi/rolecast-registry.yaml`). The alias points to a model ID (e.g. `MiniMax-M3`).
3. That model ID is rewritten to `provider/modelId` (see below) and written into the project-local agent file's `model:` frontmatter.

## `thinking:` resolution

The project-local agent file's `thinking:` field is preserved from the role-packs/<group>/<role>.md default. Each role's default is set by its output category:
- Judgement roles (orchestrator, architect, auditor, reviewer): `high`
- Meta roles (mapper, planner, profiler, docs): `medium`
- Verifiable roles (implementer, tester, canary): `low`

If you want to override `thinking:` per project, edit the project-local file after sync.

## provider/modelId format

`sync_settings.py` rewrites each binding to `provider/modelId` (e.g.
`minimax-cn/MiniMax-M3`, `openai-codex/gpt-6.1-sol`) before writing it
into the agent file. `pi-subagents` `resolveDefaultModel` only parses
strings that contain a `/`; plain `MiniMax-M3` would silently fall back to
the parent session's model. See [`dispatch-model-semantics.md`](./dispatch-model-semantics.md) for the full explanation.
