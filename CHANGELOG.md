# Changelog

All notable changes to pi-rolecast are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### ⚠ BREAKING CHANGES (opt-in via `legacy_role_aliases`)

- **`coding-implementer`, `coding-reviewer`, `coding-docs` are DEPRECATED** and rewritten to `coding-coder`, `coding-judge`, `coding-diarist` respectively. Old names keep loading for one release with a `DEPRECATED` warning on `profile.load_warnings`. New profiles should use the new names directly.
- **`coding-orchestrator` is REMOVED.** Per ADR-0010, there is no in-pack dispatcher — callers compose workflows via the Agent tool. The old name produces a louder `REMOVED` warning at profile load and the binding is dropped. The file is preserved with `deprecated_redirect: null` for one release.
- **`Profile.contracts` is now a parsed mapping (was unset).** Profiles can declare per-role output contracts under `contracts.<role>`. `validateAllContracts` runs on profile validation; violations surface as `ContractError` instances.

### Added (A套 — output contracts + toolset narrowing)

- **`Profile.contracts: Record<string, unknown>`.** Profiles can declare per-role output contracts (schema, payload checks, etc.) under a top-level `contracts:` mapping. Validated by `validateAllContracts` in `src/contracts.ts` (`validateContractSchema`, `checkContractPayload`, `ContractError`).
- **`allowed_tools` frontmatter on role files (per ADR-0008).** Each role file may declare a narrowed toolset, e.g. `allowed_tools: [read, grep, find, ls]`. The framework `sync_settings.writeAgents` emits a "Tool restrictions" block in the generated `.pi/agents/<role>.md` so pi honors the narrowing at dispatch.
- **`soul_path` frontmatter + soul prepending (per ADR-0005).** Roles can reference a soul file (default location: `role-packs/coding/souls/<name>.md`). The framework prepends the soul content to the generated agent file so the role's voice is consistent across dispatches. `souls/audit-law.md` ships as the canonical soul for audit-triad roles.
- **`forbidden_bash_patterns` frontmatter + bash seatbelt (per ADR-0008).** Roles can declare a list of forbidden bash substrings; the framework emits a "Bash seatbelt" block in the generated agent file. The canonical four (`rm -rf`, `git reset --hard`, `git clean`, `git checkout --`) ship with `coding-coder` and `coding-fixer`.
- **`Escalation.audit_max_resubmits`** (number, default `null` = unbounded per ADR-0007). Profiles can cap how many times a failing audit finding can be resubmitted before the orchestrator escalates permanently.
- **`load_warnings: string[]` on the parsed `Profile`.** Forward-reference and deprecation warnings surface here instead of being silent. `dumpBindings` includes them in stdout when present.

### Added (B套 — audit triad + worker split)

- **Audit triad** (per ADR-0032): four new role files in `role-packs/coding/`:
  - **`coding-judge`** — verdict seat; primary auditor; emits `GATES_GREEN` / `NEEDS_REWORK` / `SEATBELT_HIT`. Strong tier (`gpt-judgment-high`).
  - **`coding-countersign`** — adversarial second pair of eyes; tries to refute the judge's verdict; either confirms or raises a counter-finding. Strong tier (`opus-thinking-high`).
  - **`coding-notary`** — evidence collector; pulls exact passages, line numbers, test outputs, command results. Read-only — no bash. Cheap tier.
  - **`coding-secretariat`** — audit log recorder; writes findings to a durable record. Opt-in. Cheap tier.
  All four bind the audit-law soul and the four canonical forbidden bash substrings.
- **Worker split (per ADR-0034):** the old `coding-implementer` is replaced by:
  - **`coding-coder`** — two-phase worker (`plan` and `apply`). The dispatcher passes one phase per dispatch; coder refuses if neither is set. Balanced tier (`deepseek-verifiable`).
  - **`coding-fixer`** — finalization phase (`finalize`). Runs gates, fixes the easy red, hands off the hard red. The bash seatbelt role. Balanced tier.
  Old `coding-implementer` is preserved with `deprecated_redirect: coding-coder` for one release.

### Added (C套 — dispatcher removal + diarist rename)

- **`coding-orchestrator` deprecated with `deprecated_redirect: null`** (per ADR-0010). The dispatcher logic moves to the caller. No replacement role; the file is preserved for one release so users with old profiles see a `REMOVED` warning instead of a hard error.
- **`coding-diarist`** — new name for `coding-docs` (ak semantics alignment: "diarist" = records findings for human readers). Allows `write`/`edit` but excludes `bash`. Old `coding-docs` is preserved with `deprecated_redirect: coding-diarist` for one release.

### Changed

- **`LEGACY_ROLE_ALIASES` table** added to `src/profile_loader.ts`. Maps four legacy role names to their v0.6.0 targets (or `null` for full removal). The table includes a **forward-reference guard**: if the target role is not yet shipped in `role-packs/`, the old name is kept and a `deferred rewrite` warning is emitted instead of breaking the profile. Once B套/C套 shipped, the guard lets the rewrite fire end-to-end.
- **6 starter templates** (`rust`, `typescript`, `python`, `go`, `javascript`, `blank`) updated to use the new active role names and to comment-out the audit-triad + fixer bindings (they're opt-in).

### Deprecated

- `coding-implementer` → use `coding-coder`
- `coding-reviewer` → use `coding-judge`
- `coding-docs` → use `coding-diarist`
- `coding-orchestrator` → caller composes via Agent tool (ADR-0010)

### Deferred (not yet shipped)

- **`extension.ts` `tool_call` hook for `allowed_tools` enforcement.** The framework emits the "Tool restrictions" block in generated agent files (visible to pi's prompt layer), but a runtime enforcement hook is not yet implemented. Users who want strict enforcement today must rely on the prompt-level block or invoke `coding-fixer` which has the bash seatbelt prompt.
- **`gate_runner` audit-phase enforcement.** The framework can validate that a profile declares `audit` gates, but the runner does not yet enforce an audit phase (judge + countersign + notary + secretariat). Profiles that opt into the audit triad today must invoke the roles manually.
- **`profile-schema.md` reference doc.** The CHANGELOG entry above and `references/v0.6.0-optimization-roadmap.md` (425 lines) serve as the design-of-record for v0.6.0. A standalone `docs/profile-schema.md` is planned for v0.6.1.

### Test coverage

- **179 / 179 unit tests passing** (`npm test`). typecheck clean. New tests in `tests/unit/test_contracts.ts` (27) and `tests/unit/test_a2_a3_a5_injection.ts` (7) cover the A套 surface. The B/C套 surface is exercised by `test_profile_loader.ts` (end-to-end rewrite test now that targets ship) and the existing fixture-driven tests.

## [0.5.2] — 2026-10-07

### Fixed

- **`scaffoldInit` now bootstraps plain JavaScript projects without `--template`.** Previously, a project containing only `package.json` (no `tsconfig.json`) hit an ambiguous-detect branch: `autoDetectLanguages` returned `["typescript", "javascript"]`, `detectLanguage` returned `null`, and the scaffolder failed with `could not auto-detect language (detected: ["typescript","javascript"]). Pass --template to pick one.` v0.5.2 makes the ambiguous case resolve to `"javascript"` — the absence of `tsconfig.json` is the strongest available signal that a project is plain JS rather than TS, and there is now a `templates/javascript.yaml` template (`node --check` for compile, `npx eslint .` for lint, `npx jest` for test, no `@ts-ignore` / `as any` forbidden-patterns). Users with a TS project that has not yet committed `tsconfig.json` can pass `--template typescript` explicitly. Same behavior as v0.4.x Python scaffolder — that scaffolder also rejected this case with the same message; v0.5.0 preserved the behavior; v0.5.2 fixes it.

## [0.5.1] — 2026-10-07

### Fixed

- **`scaffoldInit` "next steps" message referenced non-existent commands.** The v0.5.0 port of `scaffolder.py → src/scaffolder.ts` carried the Python scaffolder's "next steps" footer over verbatim, which read `pi-rolecast validate --profile <path>` and `pi-rolecast gate --profile <path> --phase all`. There is no `pi-rolecast validate` or `pi-rolecast gate` slash command — the real commands are `/rolecast-validate`, `/rolecast-run [phase]`, and `/rolecast-sync`, and slash commands do not take `--profile` arguments (they auto-discover the profile from cwd via `find_profile`). Users who copy-pasted the footer into their shell would hit `bash: pi-rolecast: command not found`. Updated the footer to use the actual slash command names and added `/rolecast-sync` so the hint reflects every post-init workflow step. Surfaces in the very first thing a new user sees after `/rolecast-init`: the "next steps" block at the bottom of the scaffolder's stdout.

## [0.5.0] — 2026-10-07

### ⚠ BREAKING CHANGE — Pure Node. No more Python dependency at install or runtime.

The framework now ships entirely as a TypeScript extension and Node CLI. The runtime no longer requires Python to be installed on the user's machine; the install-time `pip install -r requirements.txt` step has been removed; and the Pi extension no longer spawns any `python3` subprocess. Developer-facing test scripts may still use Python (`pytest`, `yaml`) — these run only in CI / on a contributor's machine, never on a user's box.

#### What was removed

- `scripts/profile_loader.py` (690 lines) — replaced by `src/profile_loader.ts` (~1,200 lines)
- `scripts/dump_bindings.py` (92 lines) — replaced by `src/dump_bindings.ts` (~580 lines, in-process via `loadBindings()`)
- `scripts/scaffolder.py` (291 lines) — replaced by `src/scaffolder.ts` (~450 lines)
- `scripts/gate_runner.py` (155 lines) — replaced by `src/gate_runner.ts` (~450 lines)
- `scripts/sync_settings.py` (380 lines) — replaced by `src/sync_settings.ts` (~600 lines)
- `requirements.txt` — PyYAML is now a transitive dependency of `js-yaml` (npm), no pip install needed
- The `--no-pip` flag from `install.sh` — the installer no longer touches pip at all

#### Migration guide

For users on v0.4.x who upgraded in-place:

1. **Update `dist/`.** `npm install pi-rolecast` will overwrite the previous version. If you pinned to a specific version, `npm install pi-rolecast@0.5.0` will install the new tarball.
2. **Rebuild from source (only if you cloned the repo).** `npm install && npm run build` will now succeed without `pip install -r requirements.txt`.
3. **Manual CLI invocations change from `python3 scripts/X.py` to `node dist/X.js`.** Concretely:
   - `python3 scripts/scaffolder.py init` → `node dist/scaffolder.js init`
   - `python3 scripts/scaffolder.py validate --profile .pi/rolecast.yaml` → `node dist/scaffolder.js validate --profile .pi/rolecast.yaml`
   - `python3 scripts/scaffolder.py diff --profile .pi/rolecast.yaml` → `node dist/scaffolder.js diff --profile .pi/rolecast.yaml`
   - `python3 scripts/gate_runner.py --profile .pi/rolecast.yaml` → `node dist/gate_runner.js --profile .pi/rolecast.yaml`
   - `python3 scripts/sync_settings.py --status` → `node dist/sync_settings.js --status`
   - `python3 scripts/sync_settings.py --clear` → `node dist/sync_settings.js --clear`
   - Or just use the `/rolecast-*` slash commands — they still work and now route to the in-process TS modules instead of spawning a Python subprocess.
4. **`install.sh` no longer installs Python deps.** It now uses `jq` (instead of a `python3 -c "import yaml"` probe) for the pi-subagents settings.json check. Make sure `jq` is on your `PATH` (it ships with most Linux distros and macOS via Homebrew).
5. **`uninstall.sh` no longer relies on Python either.** It uses an inline Node heredoc to scrub the framework's entries from `~/.pi/agent/settings.json`.

#### Why now

Per the maintainer's direction: pi + pi's plugin system are npm + Node, and forcing Python on users just to install a Pi plugin was a real friction point (especially on Windows, where Python may be missing or only have the stdlib — see the v0.4.4 PyYAML fix that this version fully supersedes). The previous v0.4.4 fix added a graceful error message when PyYAML was missing; v0.5.0 eliminates the root cause entirely.

#### What was added

- **`sync_settings` tool + `/rolecast-sync` slash command.** Previously `sync_settings.py` was only callable via `install.sh` (and `setup.sh` in the e2e tests). Now the Pi extension exposes it both as a model-callable tool and as a slash command, so the orchestrator can re-sync profile bindings to project-local `.pi/agents/*.md` files mid-session without restarting pi.
- **5 new slash commands / 5 tools total** (was 4 / 4). Full list in README.
- **`README.md`** updated: prerequisites section no longer lists Python, "Bridging profile bindings to pi dispatch" shows Node commands, every "Manual install" section uses `node dist/X.js` examples.

#### Tests

- `npm test` covers the in-process TS modules (`test_profile_loader.ts`, `test_dump_bindings.ts`, `test_scaffolder.ts`, `test_gate_runner.ts`, `test_sync_settings.ts`, `test_extension.ts`, `test_model_resolver.ts`, `test_dynamic_binding_smoke.ts`). 142 tests pass on Node 20.
- 6 Python pytest files preserved for YAML structure / role-packs / SKILL.md validation and integration tests against `install.sh` / `uninstall.sh` (`tests/unit/test_registry_resolution.py`, `tests/unit/test_role_agents.py`, `tests/unit/test_skill_md.py`, `tests/integration/test_install.py`, `tests/integration/test_uninstall.py`, `tests/integration/test_dispatch_model.py`).
- 5 Python pytest files deleted alongside the Python scripts they covered (`test_gate_runner.py`, `test_sync_settings.py`, `test_profile_loader.py`, `test_scaffolder.py`, `test_sample_rust_workflow.py`).


## [0.4.4] — 2026-10-06

### Fixed

- **`dump_bindings.py` printed a Python traceback in the session_start warning when PyYAML was not installed.** On systems where the framework was pulled in as an npm dependency but the user never ran `install.sh` (which does `pip install -r requirements.txt`) — most commonly fresh Windows boxes where Node + pi are global but Python is either absent or only has the stdlib — `dump_bindings.py` would fail at module import time with `ModuleNotFoundError: No module named 'yaml'`. The TypeScript extension surfaced the stderr verbatim, producing a warning like `pi-rolecast: failed to load bindings (Traceback (most recent call last): ... ModuleNotFoundError: No module named 'yaml'). Dynamic binding disabled this session.` on every pi startup, scaring users who had no idea Python was involved. Made the PyYAML import lazy in `scripts/profile_loader.py`: the module now sets a sentinel (`_yaml = None`) when yaml cannot be imported, and the three YAML-parsing call sites (`_parse_frontmatter`, `load_profile`, `_read_registry_pair`) call `_require_yaml()` which raises a friendly `ImportError("PyYAML is required to parse pi-rolecast profile YAML files but is not installed")` only when actually invoked. `dump_bindings.py` adds a separate `except ImportError` branch that wraps the message with the install command (`Run `pip install -r requirements.txt` from the pi-rolecast install dir (or `pip install pyyaml`) and restart pi to enable dynamic role-to-model binding.`) and emits the standard `{error: ...}` JSON envelope with exit code 2. The session_start warning now reads `pi-rolecast: failed to load bindings (PyYAML is required to parse pi-rolecast profile YAML files but is not installed. Run `pip install -r requirements.txt` from the pi-rolecast install dir (or `pip install pyyaml`) and restart pi to enable dynamic role-to-model binding.). Dynamic binding disabled this session.` — actionable instead of scary. The framework continues to work in fallback mode (parent session model is used for every dispatch); only the role-specific bindings are disabled. Two regression tests added in `tests/unit/test_profile_loader.py`: `test_profile_loader_imports_without_pyyaml` (asserts `import profile_loader` succeeds when yaml is blocked, and `_require_yaml()` raises the expected ImportError) and `test_dump_bindings_yaml_missing_returns_clean_message` (asserts `dump_bindings.main()` returns exit 2 with a JSON payload containing `PyYAML` + `pip install` and no `Traceback` markers).

## [0.4.3] — 2026-10-06

### Fixed

- **`scaffolder.py init --blank` produced profiles that failed `load_profile` validation.** `_blank_template()` hardcoded `name: ""` and `description: ""` in the in-memory template dict. The dump output (framework_version 0.2.0 plus empty name/description plus empty bindings/gates) parses as a valid YAML mapping but trips the `profile.name is required` check in `parse_profile`. Surfaces at runtime as the session_start warning `pi-rolecast: failed to load bindings ({"error": "load_profile failed: profile.name is required"}). Dynamic binding disabled this session.` whenever the user opens pi in a directory containing such a profile (typically the home directory, where `find_profile(cwd)` picks up `~/.pi/rolecast.yaml`). Replaced the hardcoded dict with a call to `_load_template(framework_root / "templates", "blank")`, so the blank scaffolder now emits the same placeholders (`name: my-project`, `description: '(describe your workflow here)\n  '`) shipped in `templates/blank.yaml`. Single source of truth: the template file. Added a regression assertion to `tests/unit/test_scaffolder.py::test_scaffolder_init_blank_template` that round-trips the generated profile through `load_profile` and asserts `name`/`description` are non-empty. Users who already have a bad blank profile on disk can repair it by re-running `pi-rolecast-init --blank --project-root <dir> --force` (now produces a valid profile) or by editing `name:`/`description:` to non-empty values.

## [0.4.2] — 2026-10-05

### Added

- **`tests/e2e/` — end-to-end test for pi-rolecast profiles.** New self-contained test directory at `tests/e2e/` (not pytest — bash + python scripts, executed via `scripts/verify_all.sh`). Four-piece harness:

  - `fixtures/todo-tui/` — a Rust single-binary crate (add/list/done/remove + JSON persistence + 11 integration tests) used as the project under test. The fixture's `.pi/` is gitignored; the role-pack files under `.pi/agents/*.md` are build artifacts regenerated by `scripts/setup.sh` on each verify run via `scripts/sync_settings.py`.
  - `profiles/` — three reference profiles exercising different cost/quality trade-offs: `cost-optimal.yaml` (judgment→gpt-5.5, verifiable→deepseek-flash, mechanical→M3, total ≤200k tokens, judgment share ≤45%, mechanical share ≤20%), `quality-first.yaml` (all-on-gpt-5.5 baseline), and `rolecast-registry.yaml` (registry+aliases binding the same models the verifier uses).
  - `scripts/setup.sh` — writes the override+profile into the fixture, validates them via `scripts/scaffolder.py`, syncs the 11 role files via `scripts/sync_settings.py`, and prepares the orchestrator prompt.
  - `scripts/verify_all.sh` orchestrator + 4 verifiers: `verify_dispatch.sh` (asserts all 11 `.pi/agents/<role>.md` frontmatter `model:` fields match the golden), `verify_decomposition.sh` (asserts the orchestrator's decomposition contains ≥4 subtasks routed to ≥4 distinct roles), `verify_cost.py` (aggregates the per-phase token ledger and asserts the per-tier ceilings hold), `verify_gates.sh` (runs `scripts/gate_runner.py --profile .pi/rolecast.yaml`).
  - Each verify step exercises one of the four claims the framework makes: bindings resolve to the declared models, the orchestrator decomposes the task into ≥4 distinct roles, the cost ledger stays within the per-tier ceilings, and the gates defined in the profile run clean. The verifier suite is fast enough to be re-run on every e2e invocation; CI integration is a v0.4.x follow-up.
  - `tests/e2e/README.md` explains the design and the contract the fixture is meant to exercise; `tests/e2e/artifacts/REPORT.md` records the final per-phase results from the v0.4.2 dry-run.

### Fixed

- **`package.json` was missing `typescript` from `devDependencies` despite `prepublishOnly` running `tsc`.** `npm run typecheck` (which calls `tsc --noEmit`) and `npm run build` (which calls `tsc`) failed in any environment where typescript wasn't hoisted — including the v0.4.0 / v0.4.1 release workflow on GitHub Actions, which never had an explicit typescript install step. v0.4.0 and v0.4.1 were published manually despite the local gates failing; the CI release workflow would have produced a hard-failing release from the v0.4.0 commit onward. Added `typescript: ^5.7.0` to `devDependencies`; npm picked up 5.9.3 on install. Local gates green: `npm run typecheck` exit 0, `npm run build` exit 0, `npm test` 40/40 passed, `dist/extension.js` generated. This unblocks the v0.4.2 release workflow.

## [0.4.1] — 2026-10-05

### Changed

- **`sync_settings.py` no longer writes `settings.json` by default.** The `--no-settings` flag has been replaced by `--settings-write` (off by default). Rationale: pi-subagents reads the project-local `<project>/.pi/agents/<group>-<role>.md` `model:` and `thinking:` frontmatter as the authoritative dispatch surface; `settings.json`'s `subagents.agentOverrides` is a soft hint used by some third-party extensions and was kept there for parity. New default behavior is project-local agent files only, with `settings.json` available on opt-in for extensions that still read it. The `--clear` flag still always scrubs framework entries from `settings.json` regardless of whether the most recent sync wrote there. `install.sh` picks up the new default without changes.

- **`install.sh` now lazily creates `~/.pi/rolecast/` with a stub README on first run.** The user-global registry/aliases override directory was introduced in v0.2.0 and `profile_loader.py:573-588` reads it via `_user_global_dir()`, but nothing ever created the directory for the user — new users had to read `references/registry-resolution.md` to discover the extension point. `install.sh` now `mkdir -p`'s the dir if it is missing and drops a short `README.md` explaining the two valid override filenames (`registry-overrides.yaml`, `aliases-overrides.yaml`), the merge order, and the silent-skip semantics. Both creation steps are idempotent and never overwrite existing files. A new closing Tip line prints after every install run to surface the two most common extension points (project-local agent files + user-global overrides) and the relevant docs.

### Fixed

- **`gate_runner.py` default log directory was still `.pi/agent-workflow-logs/` (pre-v0.2.0 name).** When `scripts/gate_runner.py` was refactored in v0.2.0 to read `.pi/rolecast.yaml` and `.pi/rolecast-registry.yaml`, the `--log-dir` default at line ~34 was left pointing at the old `.pi/agent-workflow-logs/` path. Running any gate without an explicit `--log-dir` would resurrect the legacy dir on every invocation and bury the new `.pi/rolecast-logs/` next to it. Corrected to match `references/migration-from-rust-agent-workflow.md` and `references/gate-runner-usage.md`.

## [0.4.0] — 2026-10-04

### Changed

- **Slash commands hard-renamed to match the package name.** `/workflow-init`, `/workflow-validate`, `/workflow-diff`, and `/workflow-run` are now `/rolecast-init`, `/rolecast-validate`, `/rolecast-diff`, and `/rolecast-run`. The `/workflow-*` names were a leftover from the original `pi-agent-workflow` package and survived only because no one revisited them after the v0.2.0 rename. The `session_start` "no profile found" hint now points to `/rolecast-init`. The new names align with the existing `/rolecast-status` command that was added in v0.3.0. The project is still pre-user; no backward-compat aliases are kept, so any script that calls `/workflow-*` directly will need a one-line rename to `/rolecast-*`.

### Added

- **Role pack tier system (`model_tier` + `model_recommendation`).** Each role pack now declares its cost/quality tier (`strong` | `balanced` | `cheap`) and the framework's recommended starting alias. This makes the tier classification visible to the orchestrator LLM at planning time, so dispatch decisions account for cost and capability envelopes instead of defaulting to the main model for every role. The 11 shipped roles in `role-packs/coding/` have all been classified and annotated with a `## Cost & quality envelope` body section naming the tier, the binding target, and the trade-off (which roles to defer to, which to escalate to). Authoring guide lives at `references/role-authoring.md`. The resolver (`src/model_resolver.ts`) does not yet consume the new fields — this first step is purely declarative so we can verify the orchestrator reads and acts on the tier metadata before upgrading the resolver. Planned resolver follow-up (v0.4.x): explicit downgrade warnings when no fallback matches the recommended tier, automatic downgrade to the user's best tier-matching model, and a session_start summary listing each role's running tier vs. recommended tier.

## [0.3.1] — 2026-10-05

### Fixed

- **Release workflow first-publish noise on npm 11.** The first publish of `pi-rolecast@0.3.0` via OIDC trusted publishing succeeded (tarball uploaded, provenance attestation published to sigstore), but `npm publish` then printed `E404 Not Found` from a follow-up HEAD/PUT verification call and exited 1. The package was already live; the workflow step ran red despite a successful publish. Added a `Verify publish succeeded` step that runs only on publish failure, queries `npm view pi-rolecast@<tag> version`, and treats a live version as success. Genuine failures (auth, network, version conflict) still propagate the original exit code.

### Known issue (verified non-publish)

The v0.3.1 publish attempt ran into the same `E404 Not Found` noise as v0.3.0 — provenance was signed and the sigstore log entry was published, but `npm view` confirmed the version never reached the registry. The `Verify publish succeeded` step was skipped rather than running the recovery path: the conditional `if: steps.publish.outcome == 'failure'` did not match because the `outcome` field is null on run-shell steps in the GitHub Actions step API (only `conclusion` is populated). v0.3.1 was therefore never published; users should skip to v0.3.2.

## [0.3.2] — 2026-10-05

### Fixed

- **Release workflow verify step skipped on publish failure.** The conditional guarding the `Verify publish succeeded` step read `steps.publish.outcome`, which the GitHub Actions step API returns as `null` for `run` shell steps (only `conclusion` is populated for those). The verify step therefore never ran when the publish step exited 1, even though `conclusion` was correctly `failure`. Changed the conditional to `steps.publish.conclusion == 'failure'`. v0.3.1 had been a non-publish for exactly this reason; v0.3.2 ships the fix.

## [0.3.3] — 2026-10-05

### Fixed

- **Release workflow verify step still skipped after the v0.3.2 conclusion-based fix.** v0.3.2 switched the conditional from `outcome` to `conclusion`, but the step API still reports the verify step as `skipped` on every publish attempt (verified via the v0.3.2 release run). The conditional evidently never evaluates to `true` despite the publish step's `conclusion` being `failure`. Replaced the conditional approach with `if: always()` on the verify step and `continue-on-error: true` on the publish step. The verify step now reads the publish outcome via the `steps.publish.outcome` env var (which IS reliably populated), short-circuits to success when the publish step itself reports success, and only consults `npm view` when the publish step reported a non-success outcome. This guarantees the version-on-npm gate fires on every publish. v0.3.3 is also a non-publish for the same noise reason (E404 + sigstore log published + version never on registry); v0.3.4 will be the first release published under the corrected gate.

## [0.3.4] — 2026-10-05

### Fixed

- **Release workflow verify step queried with the `v` prefix.** `${{ github.ref_name }}` returns `v0.3.3` (with the `v` prefix). `npm view pi-rolecast@v0.3.3` therefore queried for a version literally named `v0.3.3`, which never matches the published `0.3.3` on the registry. The verify step would always exit 1 even when the actual publish had succeeded. v0.3.3 publish was correctly diagnosed as a genuine failure thanks to this fix surfacing the problem; v0.3.4 strips the leading `v` before calling `npm view`. Added `NPM_CONFIG_LOGLEVEL=verbose` to the publish step so the actual HTTP requests are visible in the workflow log for diagnosing future E404 noise.

## [0.3.5] — 2026-10-05

### Fixed

- **Release workflow used npm 10.9.9 which lacks OIDC trusted publishing support.** The verbose log from the v0.3.4 run revealed `npm info using npm@10.9.9` — the default npm bundled with Node 22 on GitHub Actions runners. npm 10 does not know how to use the `ACTIONS_ID_TOKEN_REQUEST_TOKEN` for OIDC, so it publishes against an empty `NODE_AUTH_TOKEN` and npmjs.com returns `404 Not Found` (pretending the package doesn't exist rather than leaking auth state). The v0.3.0 publish succeeded by luck — first-publish noise on npmjs.com allows a one-time grace where the tarball upload is committed even though the metadata PUT fails. Subsequent publishes hit the strict path and fail. v0.3.5 pins `npm-version: 11.5.0` in `actions/setup-node@v4`, which is the first npm version with native OIDC trusted publishing support. Combined with v0.3.4's verify-step fix, the publish gate now reports true success.

## [0.3.6] — 2026-10-05

### Fixed

- **v0.3.5's npm-version pin was silently ignored.** setup-node@v4 ignores `npm-version` unless `bypass-tool-cache: true` is also set, so the workflow continued to use npm 10.9.9 and the publish still failed with the same E404 pattern. v0.3.6 adds `bypass-tool-cache: true` to the setup-node step so the npm 11 pin actually takes effect.

## [0.3.7] — 2026-10-05

### Fixed

- **v0.3.6's bypass-tool-cache flag did not actually swap npm.** Even with `bypass-tool-cache: true`, the workflow still reported `npm info using npm@10.9.9`. The setup-node@v4 cache mechanism restores the bundled npm regardless of the npm-version pin in some runner configurations. v0.3.7 replaces the npm-version approach with an explicit `npm install -g npm@11.5.0` step after setup-node, which forces the bundled npm to be replaced with the OIDC-capable version. Also removed the `cache: npm` option to avoid any cache-related surprises.

### Verified

- **First successful release under the OIDC trusted publishing + robust gate pipeline.** Verbose publish log shows the full OIDC flow: `GET /idtoken 200` → `POST /-/npm/v1/oidc/token/exchange/package/pi-rolecast 201` → `GET /pi-rolecast 200` → `PUT /pi-rolecast 202`. `npm view pi-rolecast@0.3.7` confirms the version is live; maintainer field reads `GitHub Actions <npm-oidc-no-reply@github.com>`, matching npm 11's OIDC exchange response. Provenance attestation at sigstore logIndex=3077530501. All previous v0.3.x publishes (v0.3.1–v0.3.6) were non-publishes — the npm 10 E404 pattern was incorrectly diagnosed as noise for v0.3.0; this release is the first where the publish actually committed.

## [0.3.0] — 2026-10-05

### Added

- **Dynamic role to model binding (Approach 2).** Roles no longer pin a single `provider/modelId` at sync time. A profile can declare:

  - **Capability requirements** on the role frontmatter:

    ```yaml
    ---
    name: coding-architect
    requires:
      reasoning_tier: high
      context_window: 32000
      features: [thinking, tool_use]
    preferences:
      speed: medium
      cost: low
    ---
    ```

  - **A fallback chain** on each binding:

    ```yaml
    bindings:
      coding-architect:
        alias: deepseek-flash
        channels: [coding]
        fallback_chain:
          - deepseek/deepseek-flash
          - openai/gpt-4o-mini
    ```

  At dispatch time the extension walks the chain, then falls back to registry-ranked matches that meet the capability floor and best match the preferences.

- **`scripts/dump_bindings.py`** — emits `{role_groups, bindings}` JSON for the TS extension to cache at session start.

- **`src/model_resolver.ts`** — pure resolution core shared by sync and dispatch-time hooks. Algorithm: walk `fallback_chain` (allowed × available × meetsRequires) then rank `registry.list()` by preference score with stable slash-form tie-break. Returns either `{ok:true, source}` or `{ok:false, reason}`. Fails closed when `scopedModels` is explicitly empty.

- **`/rolecast-status`** slash command — shows the cache state, scoped models, and per-role resolver outcome.

- **`session_start` hook** — loads the bindings cache and surfaces a `warning` banner listing any role whose requirements cannot be satisfied by the current model pool.

- **`tool_call` hook** — when the `Agent` tool is invoked with a `subagent_type` matching a cached binding, resolves a concrete model and mutates `event.input.model` in place. Blocks with a user-readable reason if resolution fails (no silent fallback).

- **`input` hook** — transforms a leading `@handle` mention (where `handle` matches a cached role) into an explicit Agent dispatch instruction, so the main LLM calls the Agent tool, which then takes the `tool_call` path. Skips events where `source === "extension"` to avoid rewriting extension-originated input.

### Changed

- **`scripts/profile_loader.py`** — additive schema extension:
  - `Binding` gains `fallback_chain`, `role_group`, `role_name`.
  - `RoleDef` gains `requires`, `preferences`.
  - `_parse_frontmatter` now uses PyYAML `safe_load`, handling nested blocks + inline lists (was hand-rolled flat regex).
  - `_parse_bindings` accepts the discovered packs so it can stamp `role_group`/`role_name`.

### Why this matters

Prior versions pinned each role to one `provider/modelId`. That broke whenever:

- A vendor withdrew or rate-limited the bound model.
- A user's `~/.pi/models.json` no longer contained it.
- A new role-pack was added whose pinned model the user hadn't configured.

The resolver treats availability, capability, and preference as runtime properties of the user's actual model pool. Falls back explicitly, never silently (per arch-decision #4 lesson — `resolveDefaultModel`'s parentModel silent fallback is the bug we explicitly avoid).

### Tests

- 5 new Python tests for the schema extension (`tests/unit/test_profile_loader.py`).
- Node tests for `src/model_resolver.ts` (`tsx --test`).

### Migration

Existing profiles keep working — `fallback_chain` defaults to `[]`, `requires`/`preferences` default to empty. Operators wanting dynamic binding opt in by adding `fallback_chain` and/or `requires` to their role frontmatter + bindings.

## [0.2.2] — 2026-10-04

### Added

- **`scripts/uninstall.sh`** — idempotent cleanup of all framework artifacts. Removes the framework symlink, global agent symlinks targeting pi-rolecast, pi-agent-workflow, and any other framework-targeted symlinks, `settings.json` `subagents.agentOverrides` entries for framework roles, and project-local files authored by the framework (matched against `role-packs/<group>/<role>.md` enumeration). User-created files and non-framework entries are left intact.

### Changed

- **`scripts/install.sh`** — no longer creates the `~/.pi/agent/pi-rolecast` framework symlink. Per-role symlinks at `~/.pi/agent/agents/<group>-<role>.md` remain so pi-subagents can still discover agents. The npm install path (`~/.pi/agent/npm/node_modules/pi-rolecast`) is now the canonical location for the framework directory.

### Tests

- 9 new uninstall tests (`tests/integration/test_uninstall.py`).
- 2 install tests updated for the removed framework symlink.
- 97 passed, 1 skipped (cargo-not-installed).

### Migration

Users with custom REPL aliases pointing at `~/.pi/agent/pi-rolecast` should update them to `~/.pi/agent/npm/node_modules/pi-rolecast`.

## [0.2.1] — 2026-10-04

### Added

- **Legacy compat shims for filename-based agent discovery.** Bundled extensions (e.g. `pi-cc-extensions`) read `~/.pi/agent/agents/*.md` and use the **filename** as the agent key (NOT the frontmatter `name:` field). After v0.2.0's `coding-*.md` rename, the legacy `architect.md` basename disappeared, which crashed `/reload` with `ENOENT`. `install.sh` and `sync_settings.py` were extended to write both prefixed and bare-name symlinks/files for coding roles.

### Removed (v0.2.2)

These shims were removed in 0.2.2 because pi-rolecast had only been out a few days and no users depended on the legacy compatibility. The upstream extension that read by filename was updated separately.

## [0.2.0] — 2026-10-04

### BREAKING — package rename

- `pi-agent-workflow` → `pi-rolecast` (npm scope: `@rootazero/pi-agent-workflow` → unscoped `pi-rolecast`).
- Old package deprecated via `npm deprecate @rootazero/pi-agent-workflow@0.1.5 "<migration message>"`.

### Added — role packs

- New layout: `role-packs/<group>/<role>.md` with prefixed filenames and `category: <group>` field.
- First group: `coding` (11 roles: architect, planner, orchestrator, implementer, tester, reviewer, mapper, profiler, auditor, canary, docs).
- Profile schema gains `workflow.role_groups: list[string]`.

### Changed — internal

- `scripts/profile_loader.py` rewritten with `WorkflowConfig` dataclass and `discover_role_packs()` walker.
- `scripts/sync_settings.py` rewritten to walk `role-packs/<group>/` instead of the legacy `agents/` directory. Preserves `_provider_for_model` + `VENDOR_TO_PROVIDER` map.
- `src/extension.ts` updated: `PROFILE_FILENAMES = ['rolecast.yaml', 'agent-workflow.yaml']`; accepts both legacy and new profile filenames.
- 5 templates (rust/typescript/python/go/blank) updated to v0.2.0 schema with `coding-*` bindings.
- 1 scaffolder template (blank) retained for the `--blank` flow.

### Tests

- 77 → 93 passed (one skipped: cargo-not-installed).

## [0.1.x] — historical

Pre-rename era as `@rootazero/pi-agent-workflow`. See `git log --oneline` for full history (commits a7fe78 / 1e13d89 and earlier).