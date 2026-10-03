---
title: Dispatch model semantics
description: How role model bindings flow through pi-subagents dispatch
---

# Dispatch model semantics

`sync_settings.py` writes project-local agent files at `<cwd>/.pi/agents/<role>.md`
with a `model: provider/modelId` frontmatter field for every profile binding.
This doc explains how that field is consumed — and the surprise that trips up
real-world testing.

## Two dispatch paths in pi-subagents

### Path A: Slash command (`/architect`, `/orchestrator`, …)

- pi-subagents injects the agent's **system prompt** into the *current*
  session
- The session's **model stays as it was set at startup** (the default)
- The agent file's `model:` field is **ignored**
- `thinking:` is similarly ignored

This is what happens when a user types `/architect` in an interactive `pi`
session, or when `pi -p "/orchestrator ..."` is run.

### Path B: Subagent dispatch (`Agent` tool, `SubagentWorkflow`)

- `Agent({ subagent_type: 'architect' })` or
  `SubagentWorkflow({ agentType: 'architect' })` spawns a **fresh session**
- The new session uses the agent file's `model:` and `thinking:`
- `resolveDefaultModel` (`@tintinweb/pi-subagents/src/agent-runner.ts:370`)
  parses `provider/modelId` and resolves via the model registry

## Why `provider/modelId` format

`resolveDefaultModel` does:

```ts
const slashIdx = configModel.indexOf("/");
if (slashIdx !== -1) {
  const provider = configModel.slice(0, slashIdx);
  const modelId  = configModel.slice(slashIdx + 1);
  // … resolve in registry
}
// otherwise fall through to parentModel
```

A plain `model: MiniMax-M3` (no slash) is rejected. The runner silently
falls back to the parent session's model — which is usually the default
model set at startup.

`sync_settings.py` therefore rewrites every binding to
`provider/modelId`. The mapping lives in the script as `VENDOR_TO_PROVIDER`:

| registry `vendor` | pi provider key   | example model binding         |
| ----------------- | ----------------- | ----------------------------- |
| `minimax`         | `minimax-cn`      | `minimax-cn/MiniMax-M3`       |
| `deepseek`        | `deepseek`        | `deepseek/deepseek-flash`     |
| `openai`          | `openai-codex`    | `openai-codex/gpt-6.1-sol`    |
| `moonshotai`      | `kimi-coding`     | `kimi-coding/kimi-for-coding` |
| `typesafe`        | `typesafe`        | `typesafe/jev-latest`         |

If your registry uses a vendor not in the table, add it to the script's
`VENDOR_TO_PROVIDER` and re-run `sync_settings.py`.

## How to exercise bindings

Use the `Agent` tool with `subagent_type`, or `SubagentWorkflow` with
`agentType`.  The `model:` field is honoured on these paths.

```js
// Agent tool example (subagent_type matches the role name)
await parallel([
  () => agent("design the API", { label: 'architect', agentType: 'architect' }),
  () => agent("implement it",  { label: 'impl',     agentType: 'implementer' }),
])

// SubagentWorkflow
await agent('coordinate the build', { agentType: 'orchestrator' })
```

Slash commands (`/architect ...`) will **not** honour bindings in this
version. If you need that, file an issue upstream against
`@tintinweb/pi-subagents` — the runner would need to call
`setModel()` before injecting the prompt.
