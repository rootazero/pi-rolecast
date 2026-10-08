# Design — pi-rolecast ak-semantics alignment + role ecosystem optimization

**Date:** 2026-10-07
**Status:** design (pending plan)
**Scope:** v0.9.0
**Source of truth:** this doc; supersedes CHANGELOG entries prior to v0.9.0.

---

## 1. Motivation

Pi-rolecast already ports core ak-pi-workflow-roles patterns in v0.6.0 (audit triad: judge/countersign-adversary/notary/secretariat + worker split: coder/fixer), but the **naming convention deviates from ak** and several ak roles are still missing. This makes it harder to:

- Reason across the two projects (a developer who knows ak must re-learn roles whose names imply ak semantics but do something different).
- Compose judgment seats that ak expects as distinct (pre-work approval vs verdict vs post-impl quality scan).
- Diagnose overall project health (currently no role covers ak's `doctor`; `coding-profiler` is perf-only).

This spec adds the missing ak roles, realigns names, and patches two latent bugs found during the audit.

---

## 2. Background — current state (v0.8.0)

- **14 role files in `role-packs/coding/`**: architect, auditor, canary, coder, countersign, diarist, fixer, judge, mapper, notary, planner, profiler, secretariat, tester.
- **Existing `coding-countersign`** is the **judge adversary** (CONFIRM/OBJECT, refutes `coding-judge` verdicts) — NOT ak's `countersign` (给事中, pre-work approval). Naming collision blocks the ak-faithful role.
- **`coding-judge`** corresponds to ak's `judge` (post-implementation verdict, APPROVE/REJECT).
- **`coding-notary`** is ak-faithful (read-only evidence).
- **`coding-secretariat`** is ak-faithful (audit log).
- **`coding-coder`** + **`coding-fixer`** split matches ak's `coder` + `fixer` pattern.
- **`coding-diarist`** has ak-style "records findings" framing but tier is `cheap` and the description mixes "write README" (docs work, ak-`diarist` is a narrow recorder).
- **`coding-profiler`** is perf-only; ak's `doctor` (overall project health) has no equivalent.
- **`coding-inspector`** (ak 台院) is missing.
- **Ak-faithful `countersign`** (ak 给事中, pre-work approval) is missing.

### Latent bugs discovered during audit

1. **Soul-path bug.** Six roles declare `soul: souls/audit-law.md` (judge, countersign, fixer, coder, notary, secretariat). The framework resolves this via `path.resolve(path.dirname(roleFilePath), soulPath)` → `role-packs/coding/souls/audit-law.md`. That directory does NOT exist; the only `souls/audit-law.md` is at the repo root. `sync_settings.ts` emits a warning and falls back to no soul preload — these six roles are silently NOT inheriting the audit-law soul. Fix: use `../../souls/audit-law.md` (two `..` segments because the role file is 2 levels deep, not 1). Note: the existing canonical example at `profile_loader.ts:142` is also broken (`../../souls/coding/_common.md` would resolve to `role-packs/souls/coding/_common.md`, also non-existent); it is comment-only and harmless until someone follows it.
2. **ESM `__dirname` blocker.** `src/sync_settings.ts:559` uses `__dirname` in the CLI wrapper, but `package.json` declares `"type": "module"`. `npx tsx src/sync_settings.ts sync` errors out with `__dirname is not defined` before any sync work runs. This blocks all soul-preload verification across T1-T8 in the plan. Folded into T1 as Step 0 (out-of-band infrastructure fix), since the spirit-correct path (above) cannot be verified without it.
3. **Authoring guide stale.** `references/role-authoring.md` tier table lists the 11 legacy roles (includes `coding-orchestrator` removed in v0.6.0 and `coding-implementer`/`coding-reviewer`/`coding-docs` removed in v0.6.0). With this spec's additions, shipping count becomes 17 (1 rename + 14 verify-only + 4 new − 2 of those = 17 roles in `role-packs/coding/`).

---

## 3. Goals

- Add ak-faithful pre-work approval (`coding-countersign`, ak 给事中).
- Add ak-faithful post-implementation code quality gate (`coding-inspector`, ak 台院).
- Add ak-faithful factory health diagnostic (`coding-doctor`, ak 太医署).
- Tighten `coding-diarist` to ak-faithful recorder semantics; upgrade tier cheap → balanced.
- Rename existing `coding-countersign` (judge adversary) → `coding-objector` to free the ak-faithful name.
- Fix the soul-path bug so audit-law inheritance actually works for the 6 affected roles.
- Refresh `references/role-authoring.md` so the tier table reflects shipping reality.

## 4. Non-goals

- Migrate existing judgment roles (e.g. `coding-judge`) to the three-state output format. Existing roles keep their role-specific output contracts (APPROVE/REJECT, GATES_GREEN/NEEDS_REWORK/SEATBELT_HIT, etc.). Adding `escalate` to existing binary verdicts is a separate proposal for a future spec.
- Add a runner / orchestrator. ADR-0010 keeps composition with the caller.
- Touch the dispatch or gate-runner semantics; this spec is roles + bindings only.
- Rewrite role bodies for the verify-only 12 existing roles. They are touched only for the soul-path fix and the authoring-guide refresh.
- 1:1 port all 24 ak souls. Only the souls required by the new roles are added (3 new souls + 1 inherited).

---

## 5. Design decisions

### D1. Naming: rename `coding-countersign` → `coding-objector`

The existing role is the judge adversary (refutes the verdict seat). `objector` accurately describes the behavior; it also matches the audit language ("object to a finding"). Freeing `coding-countersign` lets the new ak-faithful pre-work approval seat use the canonical ak name without confusion. **Migration cost:** one role-file rename + the corresponding binding key in `.pi/rolecast.yaml`. No behavior change.

### D2. Soul-path: use `../../souls/audit-law.md` paths (two `..` segments)

Edit the 6 affected role frontmatter entries to use `../../souls/audit-law.md`. This resolves via `path.resolve(role-packs/coding, ../../souls/audit-law.md)` → repo root `souls/audit-law.md`. Two `..` segments are required because the role file is 2 levels deep (`role-packs/coding/<role>.md`); one `..` only climbs to `role-packs/` and would resolve to the non-existent `role-packs/souls/audit-law.md`.

### D3. Three-state output for new judgment roles

`coding-countersign` (new) and `coding-inspector` (new) emit:
```
VERDICT: converged | continue | escalate
FINDINGS: zero or more entries shaped as {file:line — rule — fix}
NOTES: scope coverage, escalation rationale
```

Semantics:
- `converged` — the five-step audit passes (countersign: 立法 / 符合陛下意图 / 相抵 / 缺失 / 擅加; inspector: correctness / complexity / test-quality / test-duration).
- `continue` — must return for rework; cite the failed step + the specific finding.
- `escalate` — the seat cannot rule (e.g. countersign finds owner-intent conflict; inspector finds a security issue outside scope). Route to the next tier (owner, `coding-judge`, or strong-tier re-review).

`coding-doctor` emits a **diagnosis report** (prose) plus an optional health verdict (`healthy` / `needs-care` / `critical`). It is NOT a verdict seat and does not approve/deny specific changes.

`coding-diarist` keeps ak-faithful 2-state output (`completed` / `escalate`); the ak soul itself defines only two states for this role.

### D4. Tier assignments

| Role | Tier | Alias |
|------|------|-------|
| `coding-countersign` (new) | strong | `opus-thinking-medium` |
| `coding-inspector` (new) | strong | `opus-thinking-high` |
| `coding-doctor` (new) | balanced | `deepseek-verifiable` |
| `coding-diarist` (upgrade) | balanced ↑ from cheap | `deepseek-verifiable` |
| `coding-objector` (renamed) | strong | `gpt-judgment-high` (unchanged) |

`coding-countersign` does not need `opus-thinking-high` because the judgment is mechanical-pattern-based (apply the 5-step audit), not exploratory; medium effort suffices. `coding-inspector` is `opus-thinking-high` because it reasons about test design and architectural complexity.

### D5. Three new souls

- `souls/countersign-law.md` — adapted from ak's 给事中 soul. Defines the 5-step audit + 5-question rubric; preserves "署/封驳/上呈" verdict semantics in English. Inherits `audit-law.md`.
- `souls/inspector-law.md` — adapted from ak's 台院 soul. Defines correctness/complexity/test-quality dimensions. Inherits `audit-law.md` + `quality-law.md` (the latter does not exist in pi-rolecast yet; see D6).
- `souls/doctor-law.md` — adapted from ak's 太医署 soul. Defines factory-diagnosis posture (observe, do not judge; recommend deletion-first). Inherits `audit-law.md`.

All three follow the existing frontmatter pattern (`soul: ../../souls/audit-law.md`) so the soul-prepend machinery in `sync_settings.ts:354` works without code changes.

### D6. Inherit `quality-law.md` from ak

`coding-inspector` needs ak's `quality-law.md` (covers complexity budgets, test-quality standards, test-duration budgets). Port it as `souls/quality-law.md` and have `coding-inspector` reference it. ak's `quality-law.md` is ~5.8 KB and contains the dimension definitions + reviewer discipline that `inspector-law.md` extends.

`coding-profiler` should also reference `quality-law.md` since profiler's complexity analysis is governed by the same budgets. This is a small new frontmatter entry; behavior unchanged.

### D7. `coding-diarist` tightening

- Remove the "write README / user-facing copy / visual assets" framing — that's docs work and overlaps with the deprecated `coding-docs` (which `coding-diarist` already replaced at the binding level, but the description hasn't been tightened).
- Tighten to ak-faithful scope: records decisions into the project's 起居录 (decision log); cites sources; flags uncertainty; does not author strategy.
- Tier upgrade cheap → balanced per user choice (diarist reasoning about cross-session decision coherence benefits from higher-tier reasoning).
- Add `soul: ../../souls/audit-law.md` (inherited via the soul-prepend machinery; the inherited soul reinforces the "don't invent, cite" stance which is the heart of diarist's job).
- Output stays 2-state `completed` / `escalate` per ak-faithful soul; the existing output prose is reframed around decision recording.

### D8. Authoring guide refresh

Rewrite the tier table in `references/role-authoring.md` to cover all 17 shipping roles. For each: tier, model_recommendation alias, one-line scope. Add a section on three-state output for judgment roles (mirrors ak). Add the new three souls to the "shared souls" list.

---

## 6. Per-role specifications

### 6.1 `coding-countersign` (new)

**File:** `role-packs/coding/coding-countersign.md`

**Frontmatter:**
```yaml
name: coding-countersign
category: coding
description: "Pre-work approval (ak 给事中). Reads the ticket/plan BEFORE work begins; approves, returns for rework, or escalates to owner/judge."
model: claude-opus-5-5
thinking: medium
model_tier: strong
model_recommendation: opus-thinking-medium
requires:
  reasoning_tier: high
  context_window: 64000
  features: [thinking, tool_use]
allowed_tools: [read, grep, find, ls]
soul: ../../souls/audit-law.md
souls_extra: [../../souls/countersign-law.md]
forbidden_bash_patterns:
  - "rm -rf"
  - "git reset --hard"
  - "git clean"
  - "git checkout --"
phase_inputs: [ticket]
```

**Body (overview; full body in implementation phase):**
- Identity: 给事中 (Remonstrance Official). Gates the work, doesn't do it.
- 5-step audit: 立法 → 符合陛下意图 → 相抵 → 缺失 → 擅加.
- Read-only; no edit, no write, no bash.
- Output: 3-state `converged`/`continue`/`escalate` + structured findings.

### 6.2 `coding-inspector` (new)

**File:** `role-packs/coding/coding-inspector.md`

**Frontmatter:**
```yaml
name: coding-inspector
category: coding
description: "Post-implementation code quality gate (ak 台院). Inspects correctness, complexity, test quality, test duration BEFORE merge."
model: claude-opus-5-5
thinking: high
model_tier: strong
model_recommendation: opus-thinking-high
requires:
  reasoning_tier: high
  context_window: 96000
  features: [thinking, tool_use]
allowed_tools: [read, grep, find, ls, bash]
soul: ../../souls/audit-law.md
souls_extra: [../../souls/inspector-law.md, ../../souls/quality-law.md]
forbidden_bash_patterns:
  - "rm -rf"
  - "git reset --hard"
  - "git clean"
  - "git checkout --"
phase_inputs: [post-impl]
```

**Body:** Identity 台院 (Censorate). Inspects after `coder.apply` completes, before the merge step. Bash is allowed for running tests + measuring cyclomatic complexity + capturing timing, but seatbelt applies. Output: 3-state `converged`/`continue`/`escalate` + structured findings citing file:line.

### 6.3 `coding-doctor` (new)

**File:** `role-packs/coding/coding-doctor.md`

**Frontmatter:**
```yaml
name: coding-doctor
category: coding
description: "Factory health diagnostic (ak 太医署). Diagnoses build/lint/dependency hygiene/complexity drift/security smells across the project. NOT a verdict seat."
model: deepseek-v4.1-flash
thinking: medium
model_tier: balanced
model_recommendation: deepseek-verifiable
requires:
  reasoning_tier: medium
  context_window: 64000
  features: [thinking, tool_use]
allowed_tools: [read, grep, find, ls, bash]
soul: ../../souls/audit-law.md
souls_extra: [../../souls/doctor-law.md]
forbidden_bash_patterns:
  - "rm -rf"
  - "git reset --hard"
  - "git clean"
  - "git checkout --"
phase_inputs: [health-check]
```

**Body:** Identity 太医署 (Imperial Medical Office). Read + bash (for diagnostics: `tsc --noEmit`, `npm ls`, etc.) but no edit. Output: diagnosis report (prose) + health verdict (`healthy` / `needs-care` / `critical`). Recommends deletion or simplification FIRST, then patches, then new mechanisms LAST.

### 6.4 `coding-diarist` (upgrade)

**File:** `role-packs/coding/coding-diarist.md` (edit in place)

**Changes:**
- `model_tier: cheap` → `balanced`
- `model_recommendation: minimax-medium` → `deepseek-verifiable`
- `thinking: medium` → `high`
- `requires.reasoning_tier: low` → `medium`
- Add `soul: ../../souls/audit-law.md`
- Description: tighten to ak-faithful recorder scope (drop README/visual-asset/user-facing-copy framing)
- Output format: keep 2-state (`completed` / `escalate`)

### 6.5 `coding-countersign` → `coding-objector` (rename)

**Files:** rename `role-packs/coding/coding-countersign.md` → `role-packs/coding/coding-objector.md`

**Changes:**
- `name: coding-countersign` → `name: coding-objector`
- Description: change "Adversarial second pair of eyes" → "Judge adversary. Refutes coding-judge verdicts."
- Trigger phrases: change "countersign", "adversarial review" → "object", "challenge the verdict", "adversarial review"
- All other content unchanged
- Update `.pi/rolecast.yaml` binding key `coding-countersign` → `coding-objector`

---

## 7. Cross-cutting changes

### 7.1 Soul-path fix (6 files)

For each of `coding-coder.md`, `coding-countersign.md` (becomes `coding-objector.md` after rename), `coding-fixer.md`, `coding-judge.md`, `coding-notary.md`, `coding-secretariat.md`:

Change `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md`.

This is a 6-line mechanical edit (one frontmatter line per file) that makes the soul preload actually fire.

### 7.2 New souls (3 files)

Create:
- `souls/countersign-law.md` — adapted from ak's `souls/countersign.md`. Strip Tang/Song court ceremony; keep 5-step audit + 5-question rubric. Inherit-stance: "`../../souls/audit-law.md` is the base layer; this law extends it."
- `souls/inspector-law.md` — adapted from ak's `souls/inspector.md`. Strip ceremony; define the four inspection dimensions.
- `souls/doctor-law.md` — adapted from ak's `souls/doctor.md`. Strip ceremony; preserve the "delete-first" stance.

Create:
- `souls/quality-law.md` — port ak's `souls/quality-law.md` (~5.8 KB). Defines complexity budgets + test-quality standards + test-duration budgets.

These four new files are independent of the role files; the role files reference them via `souls_extra:` (a new optional frontmatter field; see 7.3).

### 7.3 `souls_extra:` frontmatter field (optional, additive)

Current roles only support a single `soul:` path. The new roles need to inherit multiple souls (`audit-law` + their role-specific law + `quality-law` for inspector). Add an optional `souls_extra: []` field that lists additional soul paths to prepend after the primary `soul:`.

**Implementation:** one-line change in `sync_settings.ts:354` to also iterate `souls_extra` and prepend each.

### 7.4 Authoring guide refresh

Rewrite the tier table in `references/role-authoring.md`. Cover all 17 shipping roles. Add a "Three-state output for judgment roles" section explaining the ak pattern. Add the four new souls to the shared-souls list.

---

## 8. Profile binding changes

`./.pi/rolecast.yaml` (or whatever profile the user uses; default is the in-repo one).

**Additions:**
```yaml
bindings:
  # ... existing bindings ...
  coding-countersign:
    alias: opus-thinking-medium
    channels: [official]
  coding-inspector:
    alias: opus-thinking-high
    channels: [official]
  coding-doctor:
    alias: deepseek-verifiable
    channels: [official]
  coding-diarist:
    alias: deepseek-verifiable   # tier upgrade from minimax-medium
    channels: [official]
```

**Rename:**
```yaml
# before
coding-countersign:
  alias: gpt-judgment-high
  channels: [official, relay-default]
# after
coding-objector:
  alias: gpt-judgment-high
  channels: [official, relay-default]
```

No changes to `workflow.role_groups` (new roles are auto-included from `role-packs/coding/`).

---

## 9. Migration & compatibility

### 9.1 Breaking: `coding-countersign` rename

Profiles referring to the old `coding-countersign` will fail to resolve. Mitigation: add a one-release shim — `LEGACY_ROLE_ALIASES` entry in `src/profile_loader.ts` that rewrites `coding-countersign` → `coding-objector`. Follow the same pattern as the v0.6.0 removal of `coding-implementer`/`coding-reviewer`/`coding-docs` (see `LEGACY_ROLE_ALIASES` in `src/profile_loader.ts`).

After one release, the alias entry can be removed (CHANGELOG entry documents the deprecation).

### 9.2 Non-breaking: soul-path fix

The path `../../souls/audit-law.md` resolves to the same file the broken path was intended to point at. No user-visible change except that the soul preload now actually fires.

### 9.3 Non-breaking: 4 new roles

New bindings are additive. Profiles that don't reference the new roles are unaffected. The default profile (`.pi/rolecast.yaml`) gains 4 new bindings.

### 9.4 Non-breaking: `coding-diarist` tier upgrade

Bound profile changes alias; users who bind `coding-diarist` to a specific alias in their profile will see that binding honored (overriding the default). The default-tier change increases cost per diarist call but doesn't break dispatch.

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `souls_extra` field requires sync_settings.ts change; may break tests | Low | The change is additive and parallel to the existing `soul:` handling. E2e fixture roles can be verified against the new pattern. |
| ak soul ports lose nuance when translated to English | Medium | The 5-step audit / 5-question rubric are the structural core; preserve those. The court metaphor (起居录/票面/陛下) is dropped in favor of neutral project terms (decision log / ticket / owner). Cross-reference the ak source so future maintainers can re-trace. |
| Tier upgrade for `coding-diarist` increases workflow cost | Low | diarist is opt-in; profiles that don't bind it see no cost change. Bound profiles pay more per diarist call but the upgrade is justified by the role's actual reasoning needs. |
| Naming rename breaks user bindings silently | Medium | `LEGACY_ROLE_ALIASES` shim handles one release. CHANGELOG entry makes the change explicit. |
| Three souls in one role inflate role body size (audit-law + role-law + quality-law) | Low | Each soul is < 6 KB; total per role is < 20 KB. Within model context budgets. |

---

## 11. Open questions

None at design freeze. All four scope decisions (role picks, three-state, tier strategy, naming) resolved via `ask_user_question` before this spec was written.

---

## 12. Implementation order (handoff to writing-plans)

For the writing-plans skill:
1. Soul-path fix (mechanical, 6-line edit; do first so audit-law inheritance works for all later work).
2. `souls_extra:` frontmatter + sync_settings.ts change.
3. New souls (countersign-law, inspector-law, doctor-law, quality-law).
4. Rename `coding-countersign` → `coding-objector` (with `LEGACY_ROLE_ALIASES` shim).
5. New role files (`coding-countersign`, `coding-inspector`, `coding-doctor`).
6. `coding-diarist` upgrade.
7. Profile binding updates.
8. Authoring guide refresh.
9. E2e fixture role files updated to mirror the new frontmatter (if they reference old patterns).
10. CHANGELOG entry.

Each step independently verifiable via `scaffolder_validate` (where applicable) and the existing test suite.
