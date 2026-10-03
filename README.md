# pi-agent-workflow

Language-agnostic multi-agent framework. **Profiles** bind roles to models; **gates** verify the project compiles and tests pass; a **scaffolder** bootstraps a profile in any project.

The framework owns the **configuration contract**, not execution: it ships 11 immutable core role agents (architect, planner, implementer, tester, reviewer, mapper, profiler, auditor, canary, docs, orchestrator), a built-in model registry with aliases, a Python gate-runner, and a scaffolder. A profile is one YAML file under your project (`<project>/.pi/agent-workflow.yaml`) that decides which alias + channel serves each role and which commands the gate-runner must execute.

## Prerequisites

- macOS or Linux
- Python 3.10+ (3.12 is fine)
- For the install gate, pyproject.toml or package.json + tsconfig.json or go.mod
- A pi-compatible chat client (or `pi` CLI) to dispatch roles
- Node.js 20+ (only needed to build the Pi extension from source; pre-built `dist/` is shipped in the npm tarball)

## Install

### Via `pi install` (recommended)

```bash
# From a local checkout:
pi install /Volumes/TBU/Workspace/Skills/pi-agent-workflow

# From npm (when published):
pi install npm:@rootazero/pi-agent-workflow
```

This registers the framework as a Pi extension. After installing, run `/reload` in Pi. The extension exposes:

- **Slash commands**: `/workflow-init`, `/workflow-validate`, `/workflow-diff`, `/workflow-run`
- **Model-callable tools**: `scaffolder_init`, `scaffolder_validate`, `scaffolder_diff`, `gate_run`
- **A `session_start` hook** that notifies when no `.pi/agent-workflow.yaml` is present

The extension is a thin TypeScript bridge (`src/extension.ts` → `dist/extension.js`) that shells out to the Python CLI in `scripts/`. Python is the source of truth; the extension adds Pi integration on top.

### Manual install (non-Pi consumers, or fall-back)

From the framework root:

```bash
bash scripts/install.sh
```

Default prefix is `$HOME/.pi/agent/`. The installer:

1. Creates `~/.pi/agent/pi-agent-workflow` → symlink to this repo's `pi-agent-workflow/` directory.
2. Creates `~/.pi/agent/agent-<role>/SKILL.md` → symlinks to `pi-agent-workflow/agents/<role>.md` for each of the 11 core roles. pi's agent discovery picks these up so `/architect`, `/implementer`, etc. become available.
3. Runs `python3 -m pip install --user -r requirements.txt` (PyYAML + pytest) unless PyYAML is already importable.

Flags:

- `--prefix DIR` — install under `DIR` instead of `~/.pi/agent/`
- `--framework-root DIR` — treat `DIR` as the framework root (default: parent of `scripts/`)
- `--no-pip` — skip the `pip install` step (useful in CI or when PyYAML is system-installed)
- `--dry-run` — print what would be created without writing anything

Dry-run example:

```bash
bash scripts/install.sh --dry-run
```

### Uninstall

For `pi install`:

```bash
pi uninstall /Volumes/TBU/Workspace/Skills/pi-agent-workflow
# or, if installed from npm:
pi uninstall npm:@rootazero/pi-agent-workflow
```

For the manual install:

```bash
rm "$HOME/.pi/agent/pi-agent-workflow"
for role in orchestrator architect planner implementer tester reviewer \
            mapper profiler auditor canary docs; do
    rm -rf "$HOME/.pi/agent/agent-$role"
done
```

## Configure (bootstrap a project)

### Manual

```bash
cd <your-project>
python3 ~/.pi/agent/pi-agent-workflow/scripts/scaffolder.py init
```

The scaffolder inspects your tree for `Cargo.toml`, `pyproject.toml`, `package.json + tsconfig.json`, or `go.mod`, picks the matching template, and writes `<project>/.pi/agent-workflow.yaml` with sensible defaults (gates, bindings, escalation). For multi-language projects it lists candidates and asks you to pick one with `--template`.

Templates ship in `templates/{rust,typescript,python,go,blank}.yaml`. Each declares 11 role bindings and 2–3 gate phases (compile / lint / test).

Validate and inspect:

```bash
# Is the profile well-formed and does every alias resolve?
python3 ~/.pi/agent/pi-agent-workflow/scripts/scaffolder.py validate \
    --profile .pi/agent-workflow.yaml

# Did the framework schema drift since I generated my profile?
python3 ~/.pi/agent/pi-agent-workflow/scripts/scaffolder.py diff \
    --profile .pi/agent-workflow.yaml
```

### Via a pi agent

> Bootstrap a workflow profile for this project, then validate it.

The agent will:

1. Run `python3 $SKILL_ROOT/scripts/scaffolder.py init` (auto-detects language).
2. Run `scaffolder.py validate --profile .pi/agent-workflow.yaml`.
3. Report any required-but-missing fields and ask you to fill them in.

## Use

### Via the Pi extension (recommended)

After `pi install`, the extension exposes:

**Slash commands:**

```
/workflow-init                 # scaffold .pi/agent-workflow.yaml
/workflow-validate             # validate the project profile
/workflow-diff                 # check for framework schema drift
/workflow-run [phase]          # run gate-runner; phase defaults to all
```

**Model-callable tools** (the LLM can call these directly):

- `scaffolder_init` — wraps `python3 scripts/scaffolder.py init`
- `scaffolder_validate` — wraps `python3 scripts/scaffolder.py validate`
- `scaffolder_diff` — wraps `python3 scripts/scaffolder.py diff`
- `gate_run` — wraps `python3 scripts/gate_runner.py`

**`session_start` hook** — if no `.pi/agent-workflow.yaml` is found in the project root, you'll see a one-time hint pointing to `/workflow-init`.

Example interaction:

> /workflow-init
> /workflow-validate
> /workflow-run compile
> /workflow-run test

Or let the model call them in response to natural-language requests:

> Bootstrap a workflow profile for this project, then validate it.
> Imperative workflow: plan, implement, verify this change.

### Via the manual install (shell only)

Run gates (compile / lint / test):

```bash
python3 ~/.pi/agent/pi-agent-workflow/scripts/gate_runner.py \
    --profile .pi/agent-workflow.yaml
```

Run one phase at a time:

```bash
python3 ~/.pi/agent/pi-agent-workflow/scripts/gate_runner.py \
    --profile .pi/agent-workflow.yaml --phase compile
```

Logs land under `--log-dir` (default `<project>/.pi/agent-workflow-logs/<timestamp>/<phase>-attempt<N>.log`) plus a `summary.json` written to stdout.

Dispatching a role is the role's name with a `/` prefix once pi's discovery has indexed the symlinks:

```
/architect design a module boundary for the auth layer
/implementer /dev add the new endpoint
/reviewer /dev review this diff
```

## Customise models

Profile bindings reference **aliases** (e.g. `opus-thinking-medium`, `gpt-judgment-high`). Aliases resolve to specific models via `registry/aliases.yaml`.

To override the registry **without editing the framework**, drop a YAML file at one of two layers (deep-merge precedence, lowest first):

1. `<project>/.pi/agent-workflow-registry.yaml` — project-local (highest priority)
2. `~/.pi/agent-workflow/registry-overrides.yaml` — user-global

You can also override aliases at `<project>/.pi/agent-workflow-aliases-overrides.yaml` and `~/.pi/agent-workflow/aliases-overrides.yaml`.

See [references/registry-resolution.md](references/registry-resolution.md) for the full algorithm.

### Bridging profile bindings to pi dispatch

Profile bindings (alias -> model + channel) live in `.pi/agent-workflow.yaml`. Pi subagent dispatch reads `~/.pi/agent/settings.json` -> `subagents.agentOverrides.<role>.model`. The bridge is `scripts/sync_settings.py`:

```
python3 ~/.pi/agent/pi-agent-workflow/scripts/sync_settings.py --dry-run
python3 ~/.pi/agent/pi-agent-workflow/scripts/sync_settings.py --clear
```

`bash scripts/install.sh` runs sync automatically when `.pi/agent-workflow.yaml` exists in cwd. The npm install path does not.

### When bindings won't resolve at runtime

The framework's built-in `registry/built_in.yaml` ships vendor names your pi may not have (e.g. `claude-opus-5-5`, `gpt-6.1-sol`). Drop a user-global file at `~/.pi/agent-workflow/registry-overrides.yaml` mapping the IDs you actually have, then re-run sync.

## Uninstall

### Manual

```bash
# Remove the framework symlink
rm "$HOME/.pi/agent/pi-agent-workflow"

# Remove the 11 role symlinks
for role in orchestrator architect planner implementer tester reviewer \
            mapper profiler auditor canary docs; do
    rm -rf "$HOME/.pi/agent/agent-$role"
done
```

If you installed under a custom prefix, substitute that path. The installer did not touch anything outside the prefix, so no other cleanup is needed. PyYAML is installed via `--user` and is not removed automatically; remove it with `python3 -m pip uninstall PyYAML` if you no longer need it.

### Via a pi agent

> Uninstall pi-agent-workflow.

The agent will run the `rm` commands above against the same prefix it used at install time. Confirm the prefix before it runs.

## Directory layout

```
pi-agent-workflow/
├── SKILL.md                          # skill doc for pi (back-compat)
├── README.md                         # this file
├── package.json                      # npm + Pi `pi.extensions` declaration
├── tsconfig.json                     # TypeScript build config
├── src/
│   └── extension.ts                  # Pi extension factory
├── dist/                             # built TS (gitignored; shipped in npm tarball)
├── scripts/
│   ├── install.sh                    # framework installer (fall-back path)
│   ├── profile_loader.py             # load + validate a profile
│   ├── gate_runner.py                # execute phases, write logs
│   ├── scaffolder.py                 # init / diff / validate
│   └── sync_settings.py              # profile -> pi settings.json bridge
├── agents/                           # 11 immutable core role agents
│   ├── orchestrator.md
│   ├── architect.md
│   └── …
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
│   └── rust/                         # reference profile for migration
├── references/                       # deep docs (one per concept)
│   ├── profile-schema.md
│   ├── registry-resolution.md
│   ├── gate-runner-usage.md
│   ├── scaffolder-usage.md
│   └── migration-from-rust-agent-workflow.md
└── tests/
    ├── unit/                         # Python unit tests + TS extension smoke test
    └── integration/                  # install + sample-rust fixtures
```

## Building from source

```bash
cd pi-agent-workflow
npm install
npm run build        # tsc → dist/
npm test             # extension smoke test (6 tests)
```

The `dist/` directory is gitignored; the npm tarball includes the prebuilt output. To install the local build into Pi:

```bash
pi install /Volumes/TBU/Workspace/Skills/pi-agent-workflow
```

## Reference docs

- [Profile schema](references/profile-schema.md) — full YAML spec, every field, every validation rule.
- [Registry resolution](references/registry-resolution.md) — alias → model + channel algorithm, override layers, status semantics.
- [Gate runner usage](references/gate-runner-usage.md) — CLI, exit codes, escalation, logs.
- [Scaffolder usage](references/scaffolder-usage.md) — `init` / `diff` / `validate`, auto-detect, templates.
- [Migration from rust-agent-workflow](references/migration-from-rust-agent-workflow.md) — old → new role map and manual steps.

## Related projects

- **[@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)** — concurrent sub-agent execution with live monitoring. pi-agent-workflow owns the *profile + gate + scaffolder* layer; pi-subagents owns *concurrent AgentSession dispatch*. They compose: bind a profile to a pi-subagents run and you get parallel role execution with the gate runner as the safety net.
- **[Michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)** — dynamic workflow composition (different concern: workflows-as-data rather than profile-driven role bindings). Useful if your project needs to assemble steps at runtime instead of from a checked-in profile.

If you maintain a Pi extension registry or community compat list, PRs adding pi-agent-workflow are welcome.

## Spec and plan

Design history preserved in the original `rootazero/Skills` repo (kept for the record of how this framework was designed and built):

- Spec: [rootazero/Skills :: docs/superpowers/specs/2026-10-03-pi-agent-workflow-design.md](https://github.com/rootazero/Skills/blob/main/docs/superpowers/specs/2026-10-03-pi-agent-workflow-design.md)
- Plan: [rootazero/Skills :: docs/superpowers/plans/2026-10-03-pi-agent-workflow.md](https://github.com/rootazero/Skills/blob/main/docs/superpowers/plans/2026-10-03-pi-agent-workflow.md)