# Changelog

All notable changes to pi-rolecast are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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