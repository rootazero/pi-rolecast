---
title: Operational gotchas
description: Non-obvious operational issues encountered during pi-rolecast development — bash behavior, npm auth, pi-subagents internals, etc.
---

# Operational gotchas

Hard-won lessons. Most are NOT documented in upstream tools. Read before debugging.

## Bash tool `cd` does NOT persist

**Symptom:** Commands work in the same tool call but break in the next call with "no such file or directory".

**Root cause:** Each `bash` tool invocation is a fresh subprocess. `cd` only affects that one subprocess.

**Fix:**
- Use absolute paths, or
- Use `git -C <repo> <command>`, or
- Chain with `cd <repo> && <command>` within ONE call.

**Affected commands:** every `bash` invocation in pi-coding-agent and other AI coding agents that wrap a shell tool.

## npm publish EOTP URL is hard-redacted

**Symptom:** `npm publish` (or `npm login`) prints a one-time-password URL like `https://www.npmjs.com/settings/.../otp?code=...`. The URL appears blanked out in the AI tool's captured output (every channel: stdout, stderr, log files).

**Root cause:** npm's auth flow intentionally redacts the OTP URL to prevent leakage. The redaction is applied at the npm CLI level, so it's invisible regardless of how output is captured.

**Fix:** `npm publish` MUST be run by the human user, in their terminal, where they can complete the 2FA prompt. The AI agent should commit + push + create the GitHub release, but stop short of `npm publish`.

## npm stale-cache 404 after publish

**Symptom:** Immediately after `npm publish` succeeds (`+ pi-rolecast@0.2.0` logged), `npm view pi-rolecast` returns 404 for the next minute or two. `npm install -g pi-package` also fails.

**Fix:** Wait 30-60 seconds, or `npm cache clean --force`, or just retry after a brief pause. The package DID publish — this is just CDN propagation.

**Common confusions:**
- 404 does NOT mean the publish failed.
- E401 from `npm whoami` means the token expired; re-`npm login`.

## pi-subagents discovery is hardcoded

**Paths checked in this exact order** (see `dist/index.js:3661` area):
1. `<cwd>/.pi/agents/*.md` (project-local)
2. `<workspace>/.agents/agents/*.md` (workspace)
3. `~/.pi/agent/agents/*.md` (global)

The npm install location (`~/.pi/agent/npm/node_modules/<pkg>/...`) is NOT in this list. Per-role symlinks from the npm install to `~/.pi/agent/agents/` are required so pi-subagents finds the agents.

**Implication for new packages:** A pi extension that ships agents as part of an npm package MUST create symlinks (or copies) in `~/.pi/agent/agents/` for each role. The `install.sh`/`uninstall.sh` pattern in pi-rolecast is reusable.

## pi-subagents `@handle` mention syntax

**Regex:** `^@([\w-]+)\s+([\s\S]+)$` at `dist/index.js:3661` area.

**Matches:**
- `@architect design the API` ✓ (handle = `architect`, message = `design the API`)
- `@coding-architect design the API` ✓ (hyphens allowed)
- `@coding/architect design` ✗ (slashes NOT allowed in handle)
- `architect design the API` ✗ (missing `@`)

**Implication for role naming:** Use hyphens (`coding-architect`), NEVER slashes (`coding/architect`).

## pi-subagents slash-command registration

**Only `/agents` is registered** by pi-subagents (`dist/index.js:3661`). Sub-commands like `/architect`, `/implementer` etc. do NOT exist — even if a role has that handle.

**Workaround:** Mention with `@handle` (works) or `/agents @<handle> <message>` (also works).

**Implication for users:** Document role invocation as `@<handle>` in skill docs, not `/<handle>`.

## pi-subagents `resolveDefaultModel` silent fallback

**At `dist/agent-runner.js:316-333`:**
```js
const slashIdx = configModel.indexOf('/');
if (slashIdx !== -1) {
  // resolve provider/modelId
} else {
  return parentModel;  // ← silent fallback, no warning
}
```

**Symptom:** Role bound to a non-default model silently uses the default model instead. No error logged.

**Fix (at framework level):** `sync_settings.py` MUST write `provider/modelId` slash-form, never bare modelId. The `_provider_for_model` helper + `VENDOR_TO_PROVIDER` map in `sync_settings.py` enforces this.

## pyproject.toml vs setup.py

**Symptom:** Python imports fail with "attempted relative import with no known parent package".

**Root cause:** Scripts use `from . import foo` style relative imports; running them directly via `python3 scripts/foo.py` doesn't establish a package.

**Fix:** Either (a) run as module: `python3 -m scripts.foo`, or (b) use absolute imports (`from scripts import foo`), or (c) add a `scripts/__init__.py`. pi-rolecast chose (c).

## pytest tmp_path permissions on macOS

**Symptom:** Tests creating files in `tmp_path` fail with permission errors on macOS in some sandboxed environments.

**Fix:** `chmod -R u+rwX` on the tmp_path fixture, or run pytest without sandboxing. pi-rolecast's tests don't typically hit this.

## GitHub repo rename preserves history

**Renaming** `rootazero/pi-agent-workflow` → `rootazero/pi-rolecast` via Settings → General → Repository name preserves all git history, stars, issues, and releases. Old URL auto-redirects to new. No need to push from scratch.

**Renaming local folder + git remote:**
```bash
mv /path/old-name /path/new-name
cd /path/new-name
git remote set-url origin git@github.com:user/new-name.git
```

**Symlinks that pointed at the old folder** must be re-pointed (`rm` + `ln -s`) or replaced.

## npm `files` field overrides `.npmignore`

**Symptom:** `.npmignore` exists in repo, but package still includes files it should exclude (e.g., `__pycache__`).

**Root cause:** When `package.json` has a `files` array, npm ONLY includes listed files. `.npmignore` is ignored.

**Fix:** Use `files[]` with negation patterns: `"!scripts/__pycache__/"`. This is the only way to skip files when using `files[]`.

## pi-package `pi.extensions` field

**Required for any pi extension:** `package.json` must have:
```json
{
  "type": "module",
  "pi": {
    "extensions": ["./dist/extension.js"]
  }
}
```

Without `type: "module"`, the extension's `import` statements fail with `ERR_REQUIRE_ESM`.

## Why pi-rolecast is unscoped (not `@rootazero/...`)

The username `pi-agent-workflow` on npmjs is owned by another user (`pgciq`) at v0.2.1. Renaming a username does NOT transfer package ownership — the new username would not get the old packages. So we went unscoped.

Tradeoff: unscoped packages can be claimed by anyone, but in practice the name `pi-rolecast` was free. If we lose the name in future, we can scope-shift to `@rootazero/pi-rolecast` (no migration needed for `npm install`).