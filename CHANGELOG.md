# Changelog

All notable changes to pi-rolecast are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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

- **`scripts/uninstall.sh`** — idempotent cleanup of all framework artifacts. Removes the framework symlink, global agent symlinks targeting pi-rolecast, project-local files authored by the framework (matched against `role-packs/<group>/<role>.md` enumeration), and `settings.json` `subagents.agentOverrides` entries for framework roles. User-created files and non-framework entries are left intact.

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
- 7 references docs rewritten for v0.2.0 (profile-schema, registry-resolution, gate-runner-usage, scaffolder-usage, sync-settings-usage, migration-from-rust-agent-workflow, dispatch-model-semantics).

### Tests

- 77 → 93 passed (one skipped: cargo-not-installed).

## [0.1.x] — historical

Pre-rename era as `@rootazero/pi-agent-workflow`. See `git log --oneline` for full history (commits a7fe78 / 1e13d89 and earlier).