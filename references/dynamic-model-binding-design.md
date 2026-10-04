# Dynamic Model Binding — Design Proposals

> **Status**: draft v0.1 (architectural brainstorm, pre-spec)
> **Author**: assistant (with @architect)
> **Problem reference**: pi-rolecast's role→model binding is currently hard-coded to one
> `provider/modelId` per role in the profile. This fails when:
> - The user never configured that exact model (their `~/.pi/models.json` differs).
> - The model is currently unavailable (rate limit, quota, vendor outage, withdrawn).
> - The user's tooling has shifted since the profile was authored.
>
> Existing fallback `resolveDefaultModel → parentModel` is silent — the role's prompt still
> runs, just under a model the user never picked. That is the bug the team is no longer
> willing to ship (see `architecture-decisions.md` #4).

---

## Decisions Already Settled

| Decision         | Choice                                                                                                        | Rationale                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Availability src | No cache — adapt on the fly from current pi registry                                                            | Stale cache = wrong decisions; user's pool is private and fluid                                                                          |
| Capability desc  | `requires:` in **role frontmatter**                                                                           | Role semantics are stable; binding stays the user-policy layer                                                                           |
| Interchange      | **No** cross-role substitution; only same-role fallback pool                                                   | Different roles have different values/judgment profiles; interchanging silently degrades work quality                                       |
| Timing           | **Real-time dispatch** for both Path A (Agent tool) and Path B (`@handle`)                                     | A model can die between sync and dispatch; we cannot afford "best-effort at last sync" as the answer                                       |
| Silent fallback  | **Explicit + user-visible** when no model resolves                                                             | The silent parent-fallback in `resolveDefaultModel` is the bug we are rewriting; anything silent is a regression                        |

What remains is *how* to actually do real-time dispatch on both paths.

---

## Two Dispatch Paths (re-statement for clarity)

|        | Path A: `Agent` tool call                                                                                                                                         | Path B: `@handle` mention                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin | LLM tool call (also workflows)                                                                                                                                  | Human-typed interactive prompt                                                                                                                                                                                                                     |
| Wire   | LLM emits `tool_call` event with `input = { prompt, description, subagent_type, model?, ... }`. Agent tool `execute()` then spawns a session via `resolveDefaultModel`. | pi-subagents' `input` handler (`dist/index.js:42709`) matches `@<handle>`. In `model` mode it clones the conversation and the clone makes the `Agent` tool call (which still has no model param). In `direct` mode it calls `spawnTopLevel` (no model). |
| Hook   | `pi.on("tool_call", …)` — mutate `event.input.model` in place                                                                                                   | `pi.on("input", …)` — three outcomes: `continue`, `transform`, `handled`                                                                                                                                                                            |
| Order  | Always one handler per extension; tool_call fires once per call                                                                                                  | `emitInput` iterates extensions in **load order**; first `handled` short-circuits (`runner.js:1202`). `transform` chains forward.                                                                                                                       |

### The Path B problem in detail

For the search to succeed we need to either:

1. Make sure the model reaches the spawn point at all (pi-subagents currently drops it).
2. Inject the model **before** pi-subagents' `input` handler reads it.
3. Replace pi-subagents' `input` handler entirely for mentions we own.

`@handle` parsing is a regex in pi-subagents (`mention.js`); we cannot inject a model hint through the text. The mention drives `subagent_type` for the `Agent` tool call (in `model` mode the clone makes the call; in direct mode it spawns top-level with the role's `agentConfig.model`). There is no "model param" anywhere on the path — the role's frontmatter `model:` is what feeds `resolveDefaultModel`.

---

## Three Approaches

### Approach 1 — "Sync Best, Live for Tool Calls"

```
sync_settings.py at every run:
  - For each (group, role) in workflow.role_groups:
    - Resolve binding.alias through alias layers
    - Walk binding.fallback_chain (or default to alias only)
    - Pick first model in registry.getAvailable() (slash-form, not shadowed)
    - Write `model: <provider>/<modelId>` into .pi/agents/<role>.md frontmatter
    - Write last-resolved-at timestamp into a sibling meta file for diagnostics

Extension (src/extension.ts):
  - pi.on("tool_call", handler):
    - if toolName === "agent" and event.input.subagent_type:
      - resolve dynamic model (alias chain × current registry)
      - event.input.model = resolved_slash_form
    - else no-op
  - pi.on("input", handler):
    - (NOT used — pi-subagents owns the mention dispatch)
  - pi.on("session_start", …):
    - existing status check + new: notify if any role's sync-time model is missing
      from current registry (visible warning, no auto-fallback)
```

**Behavior**
- Path A: real-time dynamic, single source of truth at dispatch.
- Path B: at-mention model is whatever was written at the last `sync_settings.py` run.
  If that model has since died, pi-subagents' silent fallback still happens. The user
  notices by role prompt running under a wrong model, not by an error message. **This
  violates the "no silent fallback" decision.**

**Why this fails the brief**
The user's requirement (m00037 answer 4) is that Path B also gets real-time. Sync-best
is not real-time. We'd be asking the user to live with a degraded Path B.

---

### Approach 2 — "Tool-Call Hook + Input-Transform Hand-Off"

```
Extension (src/extension.ts):
  - pi.on("tool_call", handler): same as Approach 1 (dynamic injection)

  - pi.on("input", handler):
    if /@<handle>/ matches AND handle resolves to a known (group, role):
      resolved = resolveDynamicModel(binding)         # fresh registry query
      if not resolved:
        return { action: "handled" }                   # consume + notify user
      rolecast_note = `Use the agent tool: subagent_type="${role}", model="${resolved.slashForm}", prompt=<orig without @handle>`
      return {
        action: "transform",
        text: `<original prompt stripped of @handle>

         <rolecast-dispatch>
         ${rolecast_note}
         </rolecast-dispatch>`,
      }
    else:
      return (undefined → continue)
```

**Behavior**
- Path A: real-time dynamic, as before.
- Path B:
  - The user types `@architect do Y`.
  - rolecast's `input` handler strips the mention and appends an inline dispatch
    instruction to the text. The main LLM reads the instruction, calls the `Agent`
    tool with `subagent_type=architect, model=dynamic-slash-form`.
  - rolecast's `tool_call` handler then runs **on the main session's tool call**,
    validates the model, and either keeps it (still dynamic because the LLM was told
    to pass it) or overrides it (if the LLM chose something worse).
  - The subagent spawns under the right model.

**Cost / risk**
- The main LLM incurs one visible turn per `@handle` mention: its reasoning ("the user
  asked me to delegate to @architect with model X, so I will call the Agent tool…")
  appears in the user's transcript. Some users will find this noise.
- rolecast depends on the main LLM correctly reading the inline dispatch instruction
  and producing a tool call with the expected shape. If the main LLM is weak or
  distracted, the dispatch breaks. We add tests for this.
- We are now relying on `pi.on("input", …)` being called for mentions, which it is —
  but pi-subagents' own `input` handler is registered too. rolecast must load **after**
  pi-subagents for its `transform` to actually reach pi-subagents' handler (otherwise
  pi-subagents' handler runs first, sees `@handle`, and returns `handled` before we
  get a turn). See "Load Order" below.

**Why this is the right shape, and the load-order trap**
The pattern works as long as rolecast's handler runs *before* pi-subagents' in
extension load order. pi loads extensions from `.pi/extensions/`, npm-installed
packages, etc. There is no documented ordering guarantee. We have two options:

- (a) **Document the load-order requirement** and ship a `pi-load-order.md` note
  telling the user to configure rolecast first. Brittle.
- (b) **Detect and reorder** by reading the registered input handlers at
  `session_start`. Not actually possible — the EventBus API does not expose a
  re-register call. So (a) it is.

---

### Approach 3 — "Sentinel Agent File + Live Resolution in tool_call Only"

```
sync_settings.py at every run:
  - For each role, write agent file with a sentinel model that is *guaranteed* to
    exist (e.g., a generic lightweight model that user is extremely likely to have,
    or "best effort if none" we pick from role's binding.alias).
  - The "real" model is NOT in the frontmatter.

Extension (src/extension.ts):
  - pi.on("tool_call", handler):
    if toolName === "agent" and event.input.subagent_type and
       event.input.model is sentinel OR event.input.model is missing:
      event.input.model = resolveDynamicModel(role)
    (else: no-op, leave explicit LLM-chosen models alone)

  - pi.on("input", handler): NOT used

  - pi.on("session_start", handler):
    existing status check + on success: validate every (group, role) in
    workflow.role_groups has a resolvable dynamic model; warn the user with a
    visible banner listing roles that cannot be resolved right now.
```

**Behavior**
- Path A: real-time dynamic, as before. LLM-chosen explicit models are respected
  (the LLM may have better context).
- Path B: the agent file uses a sentinel (cheapest reliable model, e.g., a
  haiku-class default). When pi-subagents' mention dispatch spawns the session,
  it uses the sentinel. **The sentinel is still a model** — the role runs under
  the sentinel, not the user's preferred model. **This is also a regression.**

**Why this fails the brief, but in a different way**
Path B's "sentinel + override" pattern only works if the agent's actual run is
*deferred* until the override completes. It is not — `resolveDefaultModel` runs
inside the spawn call (`agent-runner.js:316`), so by the time rolecast sees any
event the session already has the wrong model.

There is a niche option here:
- write the sentinel with a model that `resolveDefaultModel` will recognize as
  "absent" (e.g., a slug no parent ever wires). Then `resolveDefaultModel` falls
  back to parentModel. But that is the silent parent fallback we are explicitly
  avoiding. **Dead end.**

---

## Cross-Approach Decisions (any choice)

1. **Resolver core**: a single TypeScript module `src/model_resolver.ts` that takes
   `{ binding, registry, scopedModels }` and returns the best available slash-form
   `provider/modelId` or a structured failure. Used by:
   - `sync_settings.py` at sync time
   - `tool_call` hook at dispatch time
   - `input` hook in Approach 2

2. **Capability matching shape** (role frontmatter):
   ```yaml
   ---
   name: architect
   requires:
     reasoning_tier: high           # low|medium|high  (advisory)
     context_window: 32000         # minimum
     features: [thinking, tool_use]   # any-of-required
   preferences:
     speed: medium                  # advisory; lower priority than availability
     cost: low
   ---
   ```
   The resolver applies `requires` as a hard filter and `preferences` as a
   tie-breaker among the model's `fallback_chain`. Without `fallback_chain`,
   the resolver walks every model in `scopedModels` (or the alias's candidate
   list) and ranks by `(available, satisfies_requires, preference_score)`.

3. **Failure surfacing** (the explicit-not-silent part):
   - If the resolver returns no model, the `tool_call` handler must `block`
     with a user-readable `reason`, and the `input` handler (if used) must
     return `handled` and `notify` the user.
   - At `session_start`, an offline-friendly banner lists each role's
     resolution status (resolved / shadowed-by-quota / unresolvable).

4. **Diagnostic surface**: a `/rolecast-status` slash command that shows
   current resolution for every role, the chosen model, the fallback chain,
   and the resolver's last-known outcome. Lets the user verify without
   re-reading the YAML.

---

## Recommendation

| Approach | Path A | Path B                                            | Silent fallback risk        | Complexity |
| -------- | ------ | ------------------------------------------------- | --------------------------- | ---------- |
| 1        | ✓      | ✗ (best-effort at last sync)                      | **High** for Path B         | Low        |
| 2        | ✓      | ✓ (real-time, paid for with one main-LLM turn)     | Low — blocked on failure    | Medium     |
| 3        | ✓      | ✗ (sentinel is a different wrong model)           | High — sentinel is not the user's pick | Medium |

Approach 2 is the only one that satisfies all four settled decisions. The cost is
one visible main-LLM reasoning turn per `@handle` mention, and a load-order
requirement that we will document and test.

If the visible main-LLM turn is unacceptable, the only honest path is to **also
relax the Path B requirement** (Approach 1) and accept that Path B re-syncs on
demand via `/rolecast-resresh` or similar. That is a separate decision the
architect needs to make.

**Default recommendation: Approach 2**, with explicit `block` + `notify` on
resolver failure and a `/rolecast-status` slash command for diagnostics.

---

## Open Items for the Architect

1. **Approach pick** — 1, 2, or 3.
2. **Main-LLM turn visibility on `@handle`** — is one visible reasoning turn
   per mention acceptable? (Approach 2 cost; if not, fall back to 1 + manual
   refresh.)
3. **Load-order documentation** — OK to ship a `docs/load-order.md` and a
   runtime check that warns the user if rolecast loaded after pi-subagents?
4. **Capability descriptor expressiveness** — does the `requires: { reasoning_tier,
   context_window, features }` shape above cover the cases you have, or is there
   a property we are missing (e.g., latency, locale, knowledge cutoff)?
6. **Resolver failure UX** — `block` with a `reason` (the tool call errors out)
   vs `handled` with `notify` (the dispatch is cancelled, user retries) — pick a
   default for the `tool_call` path.
7. **`/rolecast-status` scope** — show all roles in all groups? Current
   workflow's groups only? Filterable by group?