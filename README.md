# pi-rolecast

Multi-agent role framework for [Pi](https://github.com/earendil-works/pi-coding-agent).
**Groups of specialist agents** (coding, video, ...) bound to per-role models
and dispatched via `@<group>-<role>` mention syntax or the `Agent` tool.
Profile-driven, gate-verified, language-agnostic.

A profile is one YAML file under your project (`<project>/.pi/rolecast.yaml`)
that decides which alias + channel serves each role and which commands the
gate-runner must execute. The framework owns the **configuration contract**,
not execution.

## v0.2.0 breaking changes

If you're coming from `pi-agent-workflow` v0.1.x, see [references/migration-from-rust-agent-workflow.md](references/migration-from-rust-agent-workflow.md). Summary:

- Package renamed: `@rootazero/pi-agent-workflow` → `pi-rolecast` (unscoped).
- Role names prefixed: `architect` → `coding-architect`, etc.
- Profile filename: `.pi/agent-workflow.yaml` → `.pi/rolecast.yaml`.
- Profile gains `workflow.role_groups: [coding]` field.
- Role source moved: `agents/` → `role-packs/<group>/`.

## Prerequisites

- macOS or Linux
- Python 3.10+ (3.12 is fine)
- Node.js 20+ (only needed to build the Pi extension from source; pre-built `dist/` ships in the npm tarball)
- For the install gate, a marker file for your language: `Cargo.toml`, `pyproject.toml`, `package.json + tsconfig.json`, or `go.mod`
- A pi-compatible chat client (or `pi` CLI) to dispatch roles

## Install

### Via `pi install` (recommended)

```bash
# From a local checkout:
pi install /Volumes/TBU/Workspace/pi-rolecast

# From npm:
pi install npm:pi-rolecast
```

This registers the framework as a Pi extension. After installing, run `/reload` in Pi. The extension exposes:

- **Slash commands**: `/rolecast-init`, `/rolecast-validate`, `/rolecast-diff`, `/rolecast-run`
- **Model-callable tools**: `scaffolder_init`, `scaffolder_validate`, `scaffolder_diff`, `gate_run`
- **A `session_start` hook** that notifies when no `.pi/rolecast.yaml` is present

The extension is a thin TypeScript bridge (`src/extension.ts` → `dist/extension.js`) that shells out to the Python CLI in `scripts/`. Python is the source of truth; the extension adds Pi integration on top.

### Manual install (non-Pi consumers, or fall-back)

From the framework root:

```bash
bash scripts/install.sh
```

Default prefix is `$HOME/.pi/agent/`. The installer:

1. Creates `~/.pi/agent/pi-rolecast/` → symlink to this repo.
2. Creates `~/.pi/agent/agents/<group>-<role>.md` → symlinks to `pi-rolecast/role-packs/<group>/<role>.md` for every role in every group. This is the location read by the **pi-subagents** extension.
3. Removes the legacy `~/.pi/agent/pi-agent-workflow` symlink if found (v0.1.x).
4. Removes any deprecated `~/.pi/agent/agent-<role>/SKILL.md` directories left over from earlier installs.
5. If a profile is found in the current working directory (`.pi/rolecast.yaml` or legacy `.pi/agent-workflow.yaml`), runs `sync_settings.py` which both updates `~/.pi/agent/settings.json` and writes project-local `.pi/agents/<group>-<role>.md` files with `model:` + `thinking:` frontmatter populated from your bindings — these project-local copies override the global symlinks for that project (per pi-subagents precedence).
6. Runs `python3 -m pip install --user -r requirements.txt` (PyYAML + pytest) unless PyYAML is already importable.

Flags:

- `--prefix DIR` — install under `DIR` instead of `~/.pi/agent/`
- `--framework-root DIR` — treat `DIR` as the framework root (default: parent of `scripts/`)
- `--no-pip` — skip the `pip install` step
- `--dry-run` — print what would be created without writing anything
- `--keep-old-layout` — skip removal of legacy `agent-<role>/SKILL.md` directories

## Configure (bootstrap a project)

```bash
cd <your-project>
python3 ~/.pi/agent/pi-rolecast/scripts/scaffolder.py init
```

The scaffolder inspects your tree, picks the matching template, and writes `<project>/.pi/rolecast.yaml` with sensible defaults (workflow.role_groups, gates, bindings, escalation). For multi-language projects it lists candidates and asks you to pick one with `--template`.

Templates ship in `templates/{rust,typescript,python,go,blank}.yaml`. Each declares 11 role bindings (the `coding` group) and 2–3 gate phases (compile / lint / test).

Validate and inspect:

```bash
python3 ~/.pi/agent/pi-rolecast/scripts/scaffolder.py validate \
    --profile .pi/rolecast.yaml

python3 ~/.pi/agent/pi-rolecast/scripts/scaffolder.py diff \
    --profile .pi/rolecast.yaml
```

## Use

### Via the Pi extension (recommended)

After `pi install`, the extension exposes:

**Slash commands:**

```
/rolecast-init                 # scaffold .pi/rolecast.yaml
/rolecast-validate             # validate the project profile
/rolecast-diff                 # check for framework schema drift
/rolecast-run [phase]          # run gate-runner; phase defaults to all
```

**Model-callable tools** (the LLM can call these directly):

- `scaffolder_init` — wraps `python3 scripts/scaffolder.py init`
- `scaffolder_validate` — wraps `python3 scripts/scaffolder.py validate`
- `scaffolder_diff` — wraps `python3 scripts/scaffolder.py diff`
- `gate_run` — wraps `python3 scripts/gate_runner.py`

**`session_start` hook** — if no `.pi/rolecast.yaml` is found in the project root, you'll see a one-time hint pointing to `/rolecast-init`.

### Via the manual install (shell only)

```bash
python3 ~/.pi/agent/pi-rolecast/scripts/gate_runner.py \
    --profile .pi/rolecast.yaml
```

### Dispatching a role

Roles use the **full prefixed name** in dispatch:

```
@coding-architect design a module boundary for the auth layer
@coding-implementer add the new endpoint
@coding-reviewer review this diff
```

The framework does not register `/role` slash commands. pi-subagents handles dispatch via the `@handle` mention syntax and the `Agent` tool. See [`references/dispatch-model-semantics.md`](references/dispatch-model-semantics.md) for the full mechanism.

## Customise models

Profile bindings reference **aliases** (e.g. `opus-thinking-medium`, `gpt-judgment-high`). Aliases resolve to specific models via `registry/aliases.yaml`.

To override the registry **without editing the framework**, drop a YAML file at one of two layers (deep-merge precedence, lowest first):

1. `<project>/.pi/rolecast-registry.yaml` — project-local (highest priority)
2. `~/.pi/rolecast/registry-overrides.yaml` — user-global

You can also override aliases at `<project>/.pi/rolecast-aliases-overrides.yaml` and `~/.pi/rolecast/aliases-overrides.yaml`.

See [references/registry-resolution.md](references/registry-resolution.md) for the full algorithm.

### Bridging profile bindings to pi dispatch

Profile bindings (alias -> model + channel) live in `.pi/rolecast.yaml`. Pi subagent dispatch reads `~/.pi/agent/settings.json` -> `subagents.agentOverrides.<group>-<role>.model`. The bridge is `scripts/sync_settings.py`:

```
python3 ~/.pi/agent/pi-rolecast/scripts/sync_settings.py --dry-run
python3 ~/.pi/agent/pi-rolecast/scripts/sync_settings.py --clear
python3 ~/.pi/agent/pi-rolecast/scripts/sync_settings.py --status        # show current state vs profile bindings (no changes)
python3 ~/.pi/agent/pi-rolecast/scripts/sync_settings.py --list-groups  # show available role groups from role-packs/
```

`bash scripts/install.sh` runs sync automatically when a profile is found in cwd.

## Directory layout

```
pi-rolecast/
├── SKILL.md                          # skill doc for pi
├── README.md                         # this file
├── package.json                      # npm + Pi `pi.extensions` declaration
├── tsconfig.json                     # TypeScript build config
├── src/
│   └── extension.ts                  # Pi extension factory
├── dist/                             # built TS (gitignored; shipped in npm tarball)
├── scripts/
│   ├── install.sh                    # framework installer
│   ├── profile_loader.py             # load + validate a profile (v0.2.0 grouped roles)
│   ├── gate_runner.py                # execute phases, write logs
│   ├── scaffolder.py                 # init / diff / validate
│   └── sync_settings.py              # profile -> pi settings.json bridge
├── role-packs/
│   └── coding/                       # 11 coding-specialist roles
│       ├── coding-architect.md
│       ├── coding-orchestrator.md
│       └── …
├── registry/
│   ├── built_in.yaml                 # model registry (status, channels)
│   └── aliases.yaml                  # alias → model
├── templates/                        # scaffolder pre-fills
│   ├── rust.yaml
│   ├── typescript.yaml
│   ├── python.yaml
│   ├── go.yaml
│   └── blank.yaml
├── examples/
│   └── rust/                         # reference profile
├── references/                       # deep docs (one per concept)
│   ├── profile-schema.md
│   ├── registry-resolution.md
│   ├── gate-runner-usage.md
│   ├── scaffolder-usage.md
│   ├── sync-settings-usage.md
│   ├── dispatch-model-semantics.md
│   └── migration-from-rust-agent-workflow.md
└── tests/
    ├── unit/                         # Python unit tests + TS extension smoke test
    └── integration/                  # install + sample-rust fixtures + dispatch PoC
```

## How dispatch works

The framework does not run a custom dispatch extension itself. Instead, the **pi-subagents** extension (third-party, by `@tintinweb`, install separately: `pi install npm:@tintinweb/pi-subagents`) reads each role's `model:` + `thinking:` frontmatter and dispatches accordingly.

When `install.sh` or `sync_settings.py` runs against a project with a profile:

- Global symlinks at `~/.pi/agent/agents/<group>-<role>.md` point at the framework defaults (`deepseek-flash` everywhere).
- `sync_settings.py` then writes **project-local** copies at `<project>/.pi/agents/<group>-<role>.md` with `model:` + `thinking:` set from your profile bindings.

**Project-local copies win** (pi-subagents' load order: project before global), so `@coding-architect` in a project will use whatever you bound `coding-architect` to.

## Adding a new role group

1. Create `role-packs/<group>/<role>.md` for each role in the new group. Frontmatter must include `name: <group>-<role>` (hyphen-namespaced).
2. Add the group to `workflow.role_groups` in your profile.
3. Add bindings for the new full role names in `bindings:`.
4. Run `python3 scripts/sync_settings.py`.

See [references/migration-from-rust-agent-workflow.md](references/migration-from-rust-agent-workflow.md) for the planned future groups (video, research, design, music).

## Building from source

```bash
cd pi-rolecast
npm install
npm run build        # tsc → dist/
npm test             # extension smoke test
```

The `dist/` directory is gitignored; the npm tarball includes the prebuilt output.

## Reference docs

- [Profile schema](references/profile-schema.md) — full YAML spec, every field, every validation rule.
- [Registry resolution](references/registry-resolution.md) — alias → model + channel algorithm, override layers, status semantics.
- [Dispatch model semantics](references/dispatch-model-semantics.md) — `@handle` mention vs `Agent` tool vs plain text; why `provider/modelId` is required.
- [Gate runner usage](references/gate-runner-usage.md) — CLI, exit codes, escalation, logs.
- [Scaffolder usage](references/scaffolder-usage.md) — `init` / `diff` / `validate`, auto-detect, templates.
- [Sync settings usage](references/sync-settings-usage.md) — how profile bindings reach pi-subagents dispatch.
- [Migration from rust-agent-workflow](references/migration-from-rust-agent-workflow.md) — v0.1.x → v0.2.0 upgrade path.

## Related projects

- **[@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)** — concurrent sub-agent execution with live monitoring. pi-rolecast owns the *profile + gate + scaffolder* layer; pi-subagents owns *concurrent AgentSession dispatch*. They compose.
- **[Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)** — dynamic workflow composition (different concern: workflows-as-data rather than profile-driven role bindings).

## License

MIT.
