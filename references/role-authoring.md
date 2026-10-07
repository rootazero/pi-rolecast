# Role authoring guide

> **Status**: canonical (v0.3.0)
> **Scope**: how to author a role pack under `role-packs/<group>/<role>.md`
> **Audience**: contributors adding a new role, or framework users extending `custom_roles`

A role pack is the contract that tells the orchestrator two things: **what work this role
does** and **what model cost/quality envelope it lives in**. The first lives in the role's
body (`## Responsibilities`, `## Output format`, `## Trigger phrases`); the second lives
in two frontmatter fields plus a mandatory body section. This guide covers both.

---

## Frontmatter (required + new tier fields)

```yaml
---
name: coding-example
category: coding
description: <one-line, sentence-case, no period>
model: deepseek-flash              # pi-subagents fallback; the framework's
                                   # real binding comes from the user's profile
thinking: <low | medium | high>    # effort hint for thinking-capable models
model_tier: <strong|balanced|cheap>             # NEW in v0.3.0
model_recommendation: <alias-name>              # NEW in v0.3.0
requires:                                        # capability floor (optional)
  reasoning_tier: <low|medium|high>
  context_window: <int>
  features: [<feature-name>, ...]
preferences:                                     # preference ranking (optional)
  speed: <low|medium|high>
  cost: <low|medium|high>
---
```

### `model_tier` (required)

The role's **self-declared** cost/quality tier. Three values:

| Tier        | Use when                                                            | Example roles                              |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `strong`    | Judgement work: design, security audit, code review, dispatch       | `coding-architect`, `coding-auditor`, `coding-reviewer`, `coding-orchestrator` |
| `balanced`  | Verifiable execution: planning, mapping, profiling, testing, implementing | `coding-implementer`, `coding-mapper`, `coding-planner`, `coding-profiler`, `coding-tester` |
| `cheap`     | High-volume mechanical generation or routing checks                 | `coding-canary`, `coding-docs`             |

The orchestrator reads this field (and the matching `## Cost & quality envelope` section
in the body) when deciding whether to dispatch to a role. Reaching for a `strong` role
when a `cheap` one fits is the most expensive mistake the orchestrator can make.

### `model_recommendation` (required)

The **framework's** recommended starting alias for this role. Must be a key defined in
`registry/aliases.yaml`. The resolver uses this as the initial preference target, then
walks `fallback_chain` if the user lacks the recommended model, then downgrades with an
explicit warning if no fallback is available.

Convention:
- `strong` tier → `opus-thinking-medium` or `opus-thinking-high` (or `gpt-judgment-*` for relay work)
- `balanced` tier → `deepseek-verifiable`
- `cheap` tier → `minimax-fast` (no judgement) or `minimax-medium` (generation)

The recommendation is what the user gets by default if they don't override it in their
profile binding. Users with different subscriptions override via `bindings.<role>.alias`.

### `requires` / `preferences` (optional but recommended)

Capability floor and preference ranking. Already documented in `references/profile-schema.md`.
Tier and requires/preferences are complementary:
- **`tier`** is what the orchestrator sees at planning time (LLM-visible).
- **`requires`/`preferences`** are what the resolver uses at dispatch time (machine-visible).

They should agree: a `strong` tier role usually has `requires.reasoning_tier: high`.

---

## Body section: `## Cost & quality envelope` (required)

Place this section immediately after the role's intro paragraph and before
`## Responsibilities`. Three templates, one per tier:

### `strong` tier

```markdown
## Cost & quality envelope

Tier: **strong**. Bind to a high-reasoning model on a trusted channel.
Trade-off: every strong-tier call is the most expensive in the workflow. For trivial subtasks, defer to a `balanced`-tier role (e.g. `coding-implementer`) before invoking this role.
```

For dispatch-only roles (currently just `coding-orchestrator`), replace the trade-off line with:

```markdown
Trade-off: this role dispatches — it does not perform work itself. Honour every role's `model_tier`: prefer `cheap`-tier roles for mechanical work, `balanced`-tier for verifiable execution, `strong`-tier only for judgement. Reaching for a strong-tier role when a cheap-tier one fits is the most expensive mistake this role can make.
```

### `balanced` tier

```markdown
## Cost & quality envelope

Tier: **balanced**. Bind to a verifiable-output model on a trusted channel.
Trade-off: for judgement-heavy work (design, security audit, code review), escalate to a `strong`-tier role (e.g. `coding-architect`) rather than running it through this one.
```

Customise the trade-off line with the role's specific escalation target if it's not `coding-architect`.

### `cheap` tier

```markdown
## Cost & quality envelope

Tier: **cheap**. Bind to a fast, inexpensive model.
Trade-off: do NOT use this role for judgement or analysis — escalate to a `strong` or `balanced` role instead. This role is for high-volume mechanical work where cost dominates.
```

---

## How to pick a tier for a new role

1. **Read the role's output category.** If the output is *judgement* (a decision, a verdict,
   a review) → `strong`. If the output is *verifiable by running* (a diff, tests, a plan
   with verify clauses, a structural map) → `balanced`. If the output is *generation or
   routing* (a README, a canary verdict) → `cheap`.
2. **Check the existing `thinking:` field.** Roles with `thinking: high` almost always
   belong in `strong`. `thinking: low` is either `cheap` (no reasoning required) or
   `balanced` (mechanical execution that needs medium reasoning).
3. **Look at who should defer to this role, and to whom it should defer.** A `strong` role
   defers trivial subtasks to `balanced`. A `balanced` role escalates judgement to `strong`.
   A `cheap` role never accepts judgement work. The trade-off line of the envelope section
   should name the actual escalation/deferral target — make it concrete.
4. **Pick a `model_recommendation` alias that matches the tier.** Use the table in
   the previous section. If you need a tier-fit alias that doesn't exist yet, define it
   in `registry/aliases.yaml` (this is a framework-level change, not role-pack-level).
5. **Sanity-check against the `requires:` floor.** `requires.reasoning_tier: high` and
   `model_tier: cheap` would be a contradiction — pick the tier that matches the floor.

---

## Resolver behaviour this sets up (v0.3.x roadmap)

The `model_tier` and `model_recommendation` fields are **declarative for the
orchestrator** in v0.3.0 — the resolver (`src/model_resolver.ts`) does not yet consume
them. The current resolver uses `binding.alias` + `fallback_chain` + the role's existing
`requires:` / `preferences:` to pick a model. The planned v0.3.x upgrade is:

| Scenario                              | v0.3.0 behaviour                          | Planned v0.3.x behaviour                                |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| User has recommended model            | Resolver picks it (unchanged)             | Same                                                    |
| User lacks recommended, has fallback  | Resolver walks `fallback_chain` (silent)  | Same + explicit warning listing which models were tried |
| User has no fallback                  | Resolver surfaces failure in session_start | Same + automatic downgrade to user's best tier-matching model, with explicit warning |
| Orchestrator dispatches wrong-tier role | Orchestrator doesn't know the tier        | Orchestrator sees `model_tier` in role file before dispatch; can refuse or warn |

The first three rows are resolver-side work; the fourth is LLM-side work and depends on
the orchestrator actually reading the new fields. **That's why this first step is
frontmatter + body only** — prove the orchestrator reads the fields and uses them to
restructure dispatch, then upgrade the resolver.

---

## Reference: tier assignments for the 17 shipped roles

| Role                       | Tier       | Recommended alias      | One-line scope                                              |
| -------------------------- | ---------- | ---------------------- | ----------------------------------------------------------- |
| `coding-architect`         | `strong`   | `opus-thinking-medium` | System boundary + public API design                         |
| `coding-auditor`           | `strong`   | `opus-thinking-high`   | Security + cross-cutting code health                        |
| `coding-canary`            | `cheap`    | `minimax-fast`         | Relay route verification                                    |
| `coding-coder`             | `balanced` | `deepseek-verifiable`  | Two-phase (plan + apply) worker                             |
| `coding-countersign`       | `strong`   | `opus-thinking-medium` | Pre-work approval (ak 给事中) — three-state                 |
| `coding-diarist`           | `balanced` | `deepseek-verifiable`  | Decision recorder (ak 起居郎) — two-state                   |
| `coding-doctor`            | `balanced` | `deepseek-verifiable`  | Factory health diagnostic (ak 太医署)                       |
| `coding-fixer`             | `balanced` | `deepseek-verifiable`  | Finalization (run gates, fix easy red)                      |
| `coding-inspector`         | `strong`   | `opus-thinking-high`   | Post-impl code quality gate (ak 台院) — three-state          |
| `coding-judge`             | `strong`   | `gpt-judgment-high`    | Verdict on a diff (APPROVE/REJECT)                          |
| `coding-mapper`            | `balanced` | `deepseek-verifiable`  | Structural map / dependency graph                           |
| `coding-notary`            | `cheap`    | `deepseek-verifiable`  | Read-only evidence collector                                |
| `coding-objector`          | `strong`   | `gpt-judgment-high`    | Judge adversary (refutes coding-judge verdicts)             |
| `coding-planner`           | `balanced` | `deepseek-verifiable`  | Step-by-step plan with Verify per step                      |
| `coding-profiler`          | `balanced` | `deepseek-verifiable`  | Performance diagnosis (perf only)                           |
| `coding-secretariat`       | `cheap`    | `minimax-medium`       | Audit log recorder (opt-in)                                 |
| `coding-tester`            | `balanced` | `deepseek-verifiable`  | Test generation + maintenance                               |

These are the framework's default assignments. Users override them per-role in their
profile's `bindings:` if their subscription or cost model differs.

---

## Three-state output for judgment roles (v0.9.0+)

Ak-faithful judgment roles (currently `coding-countersign` and `coding-inspector`)
emit a three-state verdict:

- `converged` — all audit steps pass; release-ready.
- `continue` — must return for rework; cite the failed step + specific finding.
- `escalate` — the seat cannot rule (e.g. countersign finds owner-intent conflict).
  Route to the next tier (owner, `coding-judge`, or strong-tier re-review).

This differs from existing binary judgment roles (`coding-judge` = APPROVE/REJECT,
`coding-objector` = CONFIRM/OBJECT, `coding-fixer` = GATES_GREEN/NEEDS_REWORK/
SEATBELT_HIT). The divergence is intentional: ak's pattern requires three states
for any role that owns an escalation path. Existing roles keep their role-specific
output formats.

Codemode scripts that parse `VERDICT:` lines must handle BOTH two-state (existing)
and three-state (new) verdict values.

---

## Shared souls (v0.9.0+)

Roles declare a primary `soul:` plus an optional `souls_extra:` list in their
frontmatter. The shared-soul catalogue is rooted at the repo's `souls/` directory;
role frontmatter references it via `../../souls/<soul-name>.md` (relative to the role
file). Generic law is prepended before role-specific law; role body comes last.

- `../../souls/audit-law.md` — base layer for audit-facing roles
- `../../souls/countersign-law.md` — 5-step audit + 5-question rubric (v0.9.0)
- `../../souls/inspector-law.md` — 4-dimension code-quality gate (v0.9.0)
- `../../souls/doctor-law.md` — factory health diagnostic posture (v0.9.0)
- `../../souls/quality-law.md` — complexity + test budgets (v0.9.0)

---

## See also

- `references/profile-schema.md` — full profile YAML schema and binding semantics
- `references/dynamic-model-binding-design.md` — why we need real-time binding (rationale for this whole design)
- `registry/aliases.yaml` — the alias catalogue `model_recommendation` points into
- `role-packs/coding/*.md` — the 17 shipped role packs this guide documents
