---
title: Dispatch model semantics
description: How role model bindings flow through pi-subagents dispatch paths
---

# Dispatch model semantics

`sync_settings.py` writes project-local agent files at `<cwd>/.pi/agents/<role>.md`
with a `model: provider/modelId` frontmatter field for every profile binding.
This doc explains how that field is consumed on each dispatch path.

## The three dispatch paths in pi-subagents

### Path 1: Plain text prompt (no `@` mention)

- User types `design the API` or `/architect design the API` directly
- pi checks for a registered slash command — `/architect` is **not** registered
  (only `/agents` is, by pi-subagents itself)
- Text falls through to the `input` event and reaches the **main LLM**
- The main LLM may decide to call the `agent` tool with
  `subagent_type: "architect"`, but that is its choice — not guaranteed
- The main LLM uses the session's default model

> **Pitfall.** Typing `/architect design the API` does *not* dispatch a
> subagent. It is just text the main LLM sees. To get a guaranteed
> subagent dispatch you must use either Path 2 (`@handle` syntax) or Path 3
> (the `agent` tool).

### Path 2: `@handle` mention syntax (Claude Code style)

- User types `@architect design the API`
- pi-subagents' `input` handler (`dist/index.js` ≈ line 800) intercepts the
  text. The mention regex is `/^@([\w-]+)\s+([\s\S]+)$/`
- pi-subagents dispatches **synchronously** to a subagent with the agent
  file's `model:` and `thinking:` fields
- The subagent session is **fresh**; the parent's model does not change

> **Quirk.** This path requires `@` (not `/`) and at least one space before
> the message. `@architect` with no message is left alone.

### Path 3: `agent` tool / `SubagentWorkflow`

- `Agent({ subagent_type: 'architect' })` or
  `SubagentWorkflow({ agentType: 'architect' })` — model-driven dispatch
- The new subagent session uses the agent file's `model:` and `thinking:`
- `resolveDefaultModel` (`@tintinweb/pi-subagents/dist/agent-runner.js`
  ≈ line 316) parses `provider/modelId` and resolves via the model registry

```js
// Agent tool example (subagent_type matches the role name)
await parallel([
  () => agent("design the API", { label: 'architect', agentType: 'architect' }),
  () => agent("implement it",  { label: 'impl',     agentType: 'implementer' }),
])

// SubagentWorkflow
await agent('coordinate the build', { agentType: 'orchestrator' })
```

## Why `provider/modelId` format

`resolveDefaultModel` does:

```js
if (configModel) {
  const slashIdx = configModel.indexOf("/");
  if (slashIdx !== -1) {
    const provider = configModel.slice(0, slashIdx);
    const modelId  = configModel.slice(slashIdx + 1);
    // resolve in registry.find(provider, modelId)
  }
}
return parentModel;  // silent fallback
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

## Summary

| Path                | Dispatch mechanism | Binding honoured? | Caveats                          |
| ------------------- | ------------------ | ----------------- | -------------------------------- |
| Plain text          | main LLM           | no                | model is session default         |
| `@handle` mention   | sync subagent      | **yes**           | needs `@` + space + message      |
| `agent` tool        | sync subagent      | **yes**           | model-driven, needs no @ syntax  |
| `SubagentWorkflow`  | subagent pipeline  | **yes**           | orchestrator pattern             |

## Practical usage

For interactive `pi` sessions, the cleanest invocation is the `@handle`
mention. For automation and subagent pipelines, use `agent` /
`SubagentWorkflow` with `subagent_type` / `agentType`.

The `sync_settings.py` output is the same for both — `provider/modelId` is
all that matters.
