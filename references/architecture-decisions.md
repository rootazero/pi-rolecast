---
title: Architecture decisions
description: Design rationale captured during pi-rolecast development — why each choice was made and what alternatives were considered.
---

# Architecture decisions

Captures the "why" behind pi-rolecast's design. Future contributors (human or AI) should read this before refactoring — many decisions were non-obvious and had real alternatives.

## 1. Role-pack grouping (v0.2.0)

**Choice:** Roles live under `role-packs/<group>/<role>.md`. Names are `<group>-<role>` (hyphen, NOT slash). Profile declares enabled groups via `workflow.role_groups: list[string]`.

**Why:**
- Future expansion to non-coding groups (video, research, design, music) without bloating the default install.
- Group prefix in role names makes dispatch + log filtering group-scoped automatically (e.g., `grep coding-` for video roles vs coding roles).

**Alternatives considered:**
- Flat role list with a `category` frontmatter field only → loses filter naming convention.
- Sub-extension per name → too many extensions to manage.
- Slash-form names (e.g., `coding/architect`) → rejected: slashes break pi-subagents' `@handle` mention regex which uses `^@([\w-]+)\s+([\s\S]+)$` (requires `@` + space, `\w-` allows hyphens but NOT slashes).

## 2. Symlinks vs copies (v0.2.0 → v0.2.2)

**Choice:** v0.2.0/v0.2.1 used per-role symlinks at `~/.pi/agent/agents/<role>.md` pointing into `~/.pi/agent/pi-rolecast/role-packs/.../`. v0.2.2 dropped the `pi-rolecast` framework symlink entirely.

**Why symlinks are still required (not copies):**
- pi-subagents agent discovery is **hardcoded** in extension code. Three paths checked in order:
  1. `.pi/agents/` (project-local)
  2. `.agents/agents/` (workspace)
  3. `~/.pi/agent/agents/` (global)
- The npm install location `~/.pi/agent/npm/node_modules/pi-rolecast/role-packs/<group>/*.md` is NOT in this list.
- Therefore symlinks (or copies) ARE still required so pi-subagents can find the agents.

**Why drop the framework symlink in v0.2.2:**
- The npm install path is already canonical and self-locating. The framework symlink at `~/.pi/agent/pi-rolecast` was redundant.
- Symlinks that point into `node_modules/` break when npm prunes/reinstalls. A dedicated framework symlink just adds another dangling-link failure mode without benefit.
- Users can find the framework via `npm root -g` + `node_modules/pi-rolecast` if needed.

**Alternatives considered:**
- (A) Keep framework symlink + add uninstall.sh → minimal change, accepted as Plan B.
- (B) A + drop framework symlink → cleaner, **chosen**.
- (C) A + use copies instead of symlinks → no dangling links but harder to update.
- (D) PR pi-subagents to support npm-embedded role-packs → best long-term but waits for upstream.

## 3. Legacy compat shims (v0.2.1) → removed (v0.2.2)

**v0.2.1 added shims:** Both prefixed `coding-<role>.md` AND bare `<role>.md` symlinks/files. Reason: bundled extensions read `~/.pi/agent/agents/*.md` by **filename** (not frontmatter `name:`), so the legacy `architect.md` basename was needed.

**v0.2.2 removed shims:** pi-rolecast had only been out a few days. Carrying backward-compat code for no real users was unjustified complexity. The upstream extension was fixed separately.

**Lesson:** When shipping a breaking rename early, don't carry dual-write compat code "just in case". Use semantic versioning honestly: breaking = major bump, no preview branches.

## 4. VENDOR_TO_PROVIDER map (sync_settings.py)

**Choice:** `sync_settings.py` translates `vendor` (user's registry concept) to pi's `provider` via a hardcoded map: `minimax→minimax-cn`, `deepseek→deepseek`, `openai→openai-codex`, `anthropic→anthropic`, `moonshotai→kimi-coding`, `typesafe→typesafe`.

**Why:** pi-subagents' `resolveDefaultModel` at `dist/agent-runner.js:316-333` requires a `provider/modelId` slash-form. If the model field has no slash, it falls through to `parentModel` (the default). Silent fallback — no error. So we MUST write slash-form.

**Lesson:** Silent defaults are debugging hazards. We discovered the bug only because one role binding (gpt-6.1-sol) was different from the default model, and the wrong default ran silently.

## 5. Profile filename dual-acceptance (extension.ts)

**Choice:** `PROFILE_FILENAMES = ['rolecast.yaml', 'agent-workflow.yaml']`. Both filenames accepted in v0.2.0 → v0.2.1 for migration.

**Why:** Existing users had `agent-workflow.yaml`. Forcing them to rename during v0.2.0's bigger changes (role grouping) was a needless extra step. Dual-acceptance is cheap; a separate cleanup release can drop the legacy filename later.

## 6. Two-phase sync_settings.py output (v0.2.0+)

**Choice:** `sync_settings.py` writes **two layers** of agent files:
1. Project-local at `<cwd>/.pi/agents/<group>-<role>.md` (with model field)
2. Global symlinks at `~/.pi/agent/agents/<group>-<role>.md` (via install.sh)

**Why project-local:** Pi-subagents checks `.pi/agents/` first, so project-local files take precedence. Users can override per-project without touching global state.

**Why global symlinks:** So `pi-subagents` finds roles even when invoked outside any project (e.g., from `~`).