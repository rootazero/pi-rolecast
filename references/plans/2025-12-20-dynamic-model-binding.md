# Dynamic Model Binding — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Goal:** Bind each role to a dynamically-resolved `provider/modelId` at dispatch time (not at sync time), using a capability-aware resolver that fails explicitly — never silently — when no model satisfies the role's `requires:`.

**Architecture:** Approach 2 from `references/dynamic-model-binding-design.md`. Two real-time hooks:
- `pi.on("tool_call", …)` intercepts Agent tool calls and injects the resolved model into `event.input.model` before `execute()`.
- `pi.on("input", …)` intercepts `@<handle>` mentions and rewrites them into an inline delegation instruction the main LLM acts on, producing the same `Agent` tool call (which the tool_call hook then validates).

Plus a `/rolecast-status` slash command and a session-start banner showing every role's resolution status.

**Tech Stack:** TypeScript (matches existing `src/extension.ts`), Node 22, pi extension API (`@earendil-works/pi-coding-agent`).

**Spec:** `references/dynamic-model-binding-design.md` (design doc).

## Global Constraints

- TypeScript strict mode; no `any` except where `pi` event arg fields require it.
- Resolver must **fail closed** (return `{ ok: false }`) — never fall back to parent model silently. Mirrors the architecture-decision #4 lesson.
- No sync-time changes to `scripts/sync_settings.py` — Approach 2 makes sync-time resolution redundant for both paths. (If we ever need it, add a separate task.)
- New code lives under `src/` and `tests/`. No file restructuring.
- npm package.json `files:` whitelist unchanged.
- Version bump: 0.2.2 → 0.3.0 (additive feature).
- CHANGELOG entry under `## [Unreleased]` → moves to a dated `## [0.3.0]` header on release.

## Review Focus

Five input classes that no individual task's tests directly exercise but the spec implies:

1. **Empty `scopedModels`** (user has `--models` set but no overlap with binding's candidates) — resolver should return `ok: false` with reason "scoped models exclude all candidates", not silently pick a non-scoped model.
2. **Two roles with the same `requires:` but different `fallback_chain`** — resolver must not cross-contaminate candidates.
3. **LLM chooses to ignore the inline delegation instruction** in `input` transform — tool_call hook should still handle the call (LLM might pass `subagent_type` without `model`, hook injects).
4. **`@handle` typed in a non-`source: "interactive"` input** (e.g. `source: "rpc"` from scripted test) — rolecast should NOT intercept; only human-typed mentions trigger transform.
5. **Resolver called BEFORE the user's model registry is warm** (very early `session_start` race) — must not throw; should return `ok: false` with "registry unavailable" reason.

---

## Task 6 — Write `src/model_resolver.ts`

**Files:**
- Create: `src/model_resolver.ts`
- Test: `tests/test_model_resolver.ts` (written in Task 9; stub for now)

**Interfaces:**

```ts
export type CapabilityRequirement = {
  reasoning_tier?: "low" | "medium" | "high";  // advisory filter; min tier
  context_window?: number;                       // min tokens
  features?: Array<"thinking" | "tool_use" | "vision">; // any-of-required
};
export type CapabilityPreference = {
  speed?: "low" | "medium" | "high";
  cost?: "low" | "medium" | "high";
};
export type RoleBinding = {
  alias: string;
  fallback_chain?: string[];   // ordered list of "provider/modelId" candidates
};
export type ResolveInput = {
  binding: RoleBinding;
  registry: {                                  // subset of pi ModelRegistry
    list(): Array<{ provider: string; id: string; reasoning_tier?: string; context_window?: number; features?: string[]; speed?: string; cost?: string }>;
    find(provider: string, id: string): unknown | undefined;
    getAvailable?(): Array<{ provider: string; id: string }>;
  };
  scopedModels?: ReadonlyArray<{ provider: string; id: string }>;
  requires: CapabilityRequirement;
  preferences?: CapabilityPreference;
};
export type ResolvedModel = { provider: string; id: string; slashForm: string };
export type ResolveResult =
  | { ok: true; model: ResolvedModel; source: "fallback_chain" | "registry"; reason: string }
  | { ok: false; reason: string };
export function resolveModel(input: ResolveInput): ResolveResult;
```

- [ ] **Step 1: Create `src/model_resolver.ts` skeleton with the type signatures above and `throw new Error("not implemented")` in `resolveModel` body.**
- [ ] **Step 2: Implement `resolveModel` algorithm.**
   1. If `scopedModels` is set and non-empty, build `allowedSet = new Set(scopedModels.map(m => \`${m.provider}/${m.id}\`))`. Otherwise `allowedSet = null` (allow all).
   2. Build `isAvailable(p, id) = !allowedSet || allowedSet.has(\`${p}/${id}\`)`.
   3. For each candidate in `input.binding.fallback_chain ?? []` (each is slash-form):
      - parse `{provider, id}`,
      - look up model via `input.registry.list()` (or `find`),
      - if missing → record failure, continue,
      - if `!isAvailable(p, id)` → continue,
      - if `requires` filter fails → record, continue,
      - else return `{ok: true, model, source: "fallback_chain", reason: "first matching candidate"}`.
   4. If `fallback_chain` exhausted or empty, walk `input.registry.list()`:
      - for each, apply `isAvailable` + `requires` filter,
      - sort survivors by preference score (see below),
      - return first or `{ok: false}`.
   5. Preference score: start `0`; `+1` per matched `speed`/`cost` value if model exposes it; higher is better.
- [ ] **Step 3: Verify file compiles.** Run `npx tsc --noEmit`. Expected: 0 errors.

## Task 7 — Wire hooks into `src/extension.ts`

**Files:**
- Modify: `src/extension.ts` (existing 355-line file)

**Interfaces:**
- Consumes: `resolveModel` from `src/model_resolver.ts`
- Produces: pi hooks `tool_call` + `input` + extended `session_start`

- [ ] **Step 1: Add imports.** `import { resolveModel } from "./model_resolver.js";` plus the `ToolCallEvent`/`InputEvent`/`SessionStartEvent` types from `@earendil-works/pi-coding-agent`.
- [ ] **Step 2: Implement `tool_call` handler.**
   - If `event.toolName !== "agent"` or no `event.input.subagent_type`, return nothing.
   - Parse `subagent_type` as `<group>-<role>` (validate against `\/[\w-]+\/`, slice on first `-`).
   - Look up binding from loaded profile.
   - Parse role's frontmatter `requires:` block.
   - Call `resolveModel({ binding, registry: ctx.modelRegistry, scopedModels: ctx.scopedModels, requires })`.
   - If `ok: true`: `event.input.model = result.model.slashForm`. No event result (continue).
   - If `ok: false`: return `{ block: true, reason: \`rolecast: cannot resolve model for ${subagent_type} — ${result.reason}\` }`.
- [ ] **Step 3: Implement `input` handler.**
   - If `event.source !== "interactive"`, return nothing (per gotcha #5).
   - Match `/^\s*@([\w-]+)\s+([\s\S]+)$/`.
   - If no match → return nothing.
   - If match: look up binding, resolve model (same as Step 2). If `ok: false` → return `{action: "handled"}` and `ctx.ui.notify(...)`. If `ok: true` → return `{action: "transform", text: originalText stripped of @handle + inline delegation hint}`.
- [ ] **Step 4: Extend `session_start` handler.** Add after existing profile-status check: for every role in current profile's `workflow.role_groups`, attempt resolution and append a status line for any role where resolver returns `ok: false`.
- [ ] **Step 5: Verify `npx tsc --noEmit`.** Expected: 0 errors.

## Task 8 — `/rolecast-status` command

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Same as Task 7 + slash command registration

- [ ] **Step 1: Register `pi.registerCommand("rolecast-status", { description, handler })`.**
- [ ] **Step 2: Implement handler.** Iterates roles in current profile's `workflow.role_groups`, runs resolver on each, prints a table to `ctx.ui.notify` (multi-line) showing: role / source (chain|registry) / slash-form / reason-or-failure. For roles in failure, append the resolver's reason.

## Task 9 — Resolver unit tests

**Files:**
- Create: `tests/test_model_resolver.ts`

- [ ] **Step 1: Test 1 — fallback chain first-match.** `binding.fallback_chain = ["anthropic/sonnet", "deepseek/flash"]`, both available, both satisfy requires → returns anthropic, source `"fallback_chain"`.
- [ ] **Step 2: Test 2 — required feature filter.** Same setup but `requires: { features: ["vision"] }`; only second model has vision → returns deepseek, source `"fallback_chain"`.
- [ ] **Step 3: Test 3 — fails closed when nothing satisfies.** `requires: { context_window: 1_000_000 }`; no model meets it → returns `{ok: false, reason: "no model satisfies requires"}`.
- [ ] **Step 4: Test 4 — respects `scopedModels`.** registry has 3 models, `scopedModels = [one]`, binding.fallback_chain covers all 3 → only the one in scoped is considered; returns it or fails.
- [ ] **Step 5: Test 5 — empty fallback_chain walks registry.** `fallback_chain = []`, requires met by 2 of 5 → first by stable order, source `"registry"`.
- [ ] **Step 6: Test 6 — preference score tie-break.** Two models both satisfy, only second matches `preferences.cost = "low"` → second wins even if listed first in fallback_chain (preference overrides ordering).
- [ ] **Step 7: Run tests.** `npx vitest run tests/test_model_resolver.ts`. Expected: 6/6 pass.

## Task 10 — Version + CHANGELOG

- [ ] **Step 1:** Edit `package.json` version `"0.2.2"` → `"0.3.0"`.
- [ ] **Step 2:** Add to `CHANGELOG.md` under `## [Unreleased]`:
   ```
   - Add dynamic model binding — resolver-driven role→model selection at dispatch time on both Agent tool path and `@handle` path. Capability filter (`requires:` in role frontmatter); explicit failure with user-visible reason when no model resolves. New `/rolecast-status` command for diagnostics. No silent fallback.
   ```
- [ ] **Step 3:** Move the entry from `## [Unreleased]` into a new `## [0.3.0] - <today's date>` section per the existing CHANGELOG format (read top of CHANGELOG.md to confirm).

## Task 11 — Gates

- [ ] **Step 1:** `gate_run` (all).
- [ ] **Step 2:** Fix any failures (compile, lint, test).
- [ ] **Step 3:** Re-run until clean.

---

## Execution

Implementing natively in this session (per architect's "开始实施" directive). Each task starts with TaskUpdate to `in_progress` and ends with `completed`.