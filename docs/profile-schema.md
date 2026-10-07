# pi-rolecast v0.6.0 Profile Schema Reference

This document is the canonical reference for the schema that the
pi-rolecast v0.6.0 framework reads from `.pi/rolecast.yaml` and from
role-pack files under `role-packs/<group>/<role>.md`.

For usage and worked examples, see `README.md`. For runtime behaviour
that the schema shapes, see `src/extension.ts` and `src/gate_runner.ts`.

The schema is intentionally YAML-flavoured: every field has a default
or is optional, so the smallest valid profile is small. The reference
below is exhaustive; the section **Required minimum** at the end
documents what you actually need to ship.

---

## 1. Profile top-level fields

All fields except `framework_version`, `name`, `description`, `bindings`,
`gates`, `non_negotiables`, `escalation`, and `workflow` are optional.

| Field             | Required | Type / shape                               | Notes                                  |
|------------------|-----------|-------------------------------------------|----------------------------------------|
| `framework_version` | yes   | string                                    | `"0.2.0"` for the current schema.      |
| `name`           | yes       | string                                    | Used in logs and the gate summary.     |
| `description`    | yes       | string \| multiline `\|` block           | Free-form.                             |
| `bindings`       | yes       | `Record<role, Binding>`                   | See §2.                                |
| `gates`          | yes       | `Record<phaseName, GateDef>`              | See §6.                                |
| `non_negotiables`| yes       | `NonNegotiables`                          | See §7.                                |
| `escalation`     | yes       | `Escalation`                              | See §8.                                |
| `workflow`       | yes       | `WorkflowConfig`                          | `role_groups: string[]` — typically `[coding]`. |
| `trigger_overrides` | no     | `Record<role, string[]>`                  | Adds `@prompt` dispatch hooks.         |
| `custom_roles`   | no        | `CustomRole[]`                            | See §9.                                |
| `contracts`      | no        | `Record<role, JSONSchema>`                | v0.6.0 (A1). See §3.                  |

### 1.1 `load_warnings` (read-only)

After `loadProfile()` runs, the returned `Profile` object also carries
`load_warnings: string[]`. These are produced during legacy-name
rewriting (§5) and contract validation (§3). They are not user-written;
the schema validator (`scaffolder validate`) surfaces them in its
output and exits non-zero when any is a hard error.

---

## 2. `bindings` — per-role role → model → channel

Each key is a role name from an enabled role-group (see §10). The
value is a `Binding`:

```yaml
bindings:
  coding-architect:
    alias: opus-thinking-medium       # required
    channels: [official]              # required, ordered preference
    fallback_chain: []                  # optional, vendor/model alternates
    role_group: coding                # optional, inferred from key
    role_name: coding-architect       # optional, inferred from key
```

| Field           | Type                | Required | Notes                                 |
|-----------------|---------------------|----------|---------------------------------------|
| `alias`         | string              | yes                    | Must be in the model registry.       |
| `channels`      | string[]           | yes                    | Ordered trust preference.            |
| `fallback_chain`| `string[]`         | no                     | Vendor/model alternates when the primary cannot satisfy `requires`. |
| `role_group`    | string              | no                     | Inferred from the key's `<group>-` prefix. |
| `role_name`     | string              | no                     | Inferred from the key.               |

The framework's `resolved_bindings` field (computed, not user-written)
carries the final `model_id` / `channel_id` / `trust` plus a
`via_fallback` flag and an optional `warning` string for each role.

---

## 3. `contracts` — v0.6.0 per-role output schemas

Optional. A `Record<role, JSONSchema>` that documents and validates
each role's structured output. The validator (`scaffolder validate`)
calls `validateAllContracts` (§11) and rejects profiles whose
contracts are malformed.

```yaml
contracts:
  coding-judge:
    type: object
    required: [verdict, rationale]
    properties:
      verdict:
        type: string
        enum: [pass, fail, abstain]
      rationale:
        type: string
        minLength: 16
      evidence:
        type: array
        items:
          type: string
      confidence:
        type: number
        minimum: 0
        maximum: 1
```

v0.6.0 enforces **structural** validation only. Dispatch-time
adherence (whether the LLM actually returned a payload matching the
schema) is the caller's responsibility.

`checkContractPayload(role, payload)` is exported from
`src/contracts.ts` so external tooling (e.g. workflow runners that
post-process role outputs) can validate at runtime if they wish.

### 3.1 Recognised JSON-Schema keywords

`type`, `required`, `properties`, `additionalProperties`, `enum`,
`items`, `description`, `title`, `default`. Anything else is
rejected with a hint to file an issue.

---

## 4. Role-pack frontmatter — `role-packs/<group>/<role>.md`

Each role file begins with a YAML frontmatter block. v0.6.0 adds three
new optional fields; existing fields are unchanged.

```markdown
---
full_name: Architecture (review boundaries, contracts, error strategy)
group: coding
role: architect
description: |
  <one-line summary>
triggers:
  - @architect
requires: {}
deprecated_redirect: null        # optional; see §5
allowed_tools: [read, grep, find, ls, bash]   # optional; see §4.1
soul: ../souls/coding/_common.md             # optional; see §4.2
forbidden_bash_patterns:        # optional; see §4.3
  - "rm -rf"
  - "git reset --hard"
phase_inputs:                   # optional; see §4.4
  plan: |
    <structured plan input>
  apply: |
    <structured apply input>
---

<role body markdown>
```

### 4.1 `allowed_tools` (A2)

Optional. `string[]` or omitted. When present, the sync_settings
generator writes a `Tool restrictions` block into the generated
agent file body listing the allowed tools.

This is **declarative**, not enforced by the framework. The runtime
hook (`enforceRoleNarrowing` in `src/extension.ts`) does honour it
when `allowed_tools` is set on the role — see §4.5 below. A `null`
value means "explicitly no restriction documented"; missing field
means "no restriction documented" (the two are indistinguishable
post-load).

### 4.2 `soul` (A3)

Optional. Single string. Relative path from this role file to a
shared "soul" markdown file (typically `../souls/<group>/_common.md`).
The generator prepends the soul content to the role body after the
frontmatter, bracketed by HTML-comment markers `<!-- soul-do-not-edit:start -->` and `<!-- soul-do-not-edit:end -->`.

This implements the ADR-0005 "soul layering" pattern: the soul file
is the generic-law layer; the role body is the host overlay.

### 4.3 `forbidden_bash_patterns` (A5)

Optional. `string[]`. Each entry is a **literal substring**, not a
glob or regex. The generator writes a `Bash seatbelt` block listing
these patterns at the end of the role body, with the caveat
*防呆不防坏* — "guards against accidents, not malice".

Like `allowed_tools`, this is declarative. The runtime hook honours
it when the role is active: see §4.5.

### 4.4 `phase_inputs` (B2)

Optional. A `Record<phase, string>` where phase is typically `plan`
or `apply`. Documents the structured input the role expects for that
phase. Has no runtime effect today; it is documentation that the
workflow orchestrator (caller) is expected to assemble.

### 4.5 Runtime enforcement

`src/extension.ts` exports `enforceRoleNarrowing(event, bindings,
currentRole)`, a pure decision helper used by the `tool_call` hook.
When a role is dispatched (via `Agent`), `currentRole` is set to the
role's name; subsequent non-`Agent` tool calls are checked:

- If the role's `allowed_tools` is an array, the tool name must be in
  the list. Otherwise the call is blocked.
- If the tool is `bash` and the role's `forbidden_bash_patterns` is
  non-empty, the command payload is scanned (keys `command`, `cmd`,
  `script` in that order) for any forbidden substring. A hit blocks.

This is the v0.6.0 mechanism for A2 / A5 enforcement; it does not
exist in earlier versions. See `tests/unit/test_runtime_hook.ts`
for the 11-test contract.

---

## 5. Legacy role-name aliases — `LEGACY_ROLE_ALIASES`

When a profile declares a binding, contract, or trigger for an old
role name, the loader rewrites it to the current name and emits a
warning. The mapping lives in `src/profile_loader.ts`:

| Old name               | New target                          | Loader behaviour                    |
|------------------------|-------------------------------------|-------------------------------------|
| `coding-reviewer`      | `coding-judge`                      | DEPRECATED warning, silent rewrite. |
| `coding-implementer`   | `coding-coder`                      | DEPRECATED warning, silent rewrite. |
| `coding-docs`          | `coding-diarist`                    | DEPRECATED warning, silent rewrite. |
| `coding-orchestrator`  | `null` (removed)                    | REMOVED warning, binding key dropped. |

The forward-reference guard in `parseBindingsWithLegacyRewrite`
checks the role-packs directory first: if the new target role does
not yet exist on disk, the old name is preserved and a DEFERRED
warning is emitted instead. This makes the alias table safe to ship
ahead of its targets (e.g. during a partial upgrade).

When the profile explicitly declares a binding for the new name in
addition to the old one, the explicit new entry wins and the old
binding is silently dropped (clobber protection).

v0.7.0 removes the alias table; profiles must use the current names.

### 5.1 Per-role `deprecated_redirect`

For non-binding contexts (e.g. `@reviewer` triggers), a role file
can carry:

```yaml
deprecated_redirect: coding-judge
```

When that role is referenced and its target exists, the loader
rewrites. When `deprecated_redirect: null`, the role is treated as
removed. Anything else is a parse error.

---

## 6. `gates` — phases run by `gate_runner`

Each key is a phase name; the value is a `GateDef`:

```yaml
gates:
  compile:
    commands:
      - npm run build
    timeout: 300
  audit:
    commands:
      - echo "audit ran"
    timeout: 60
    audit_roles:
      - coding-judge
      - coding-notary
```

| Field           | Type        | Required | Notes                                              |
|-----------------|-------------|----------|----------------------------------------------------|
| `commands`      | string[]    | no       | Shell commands, run sequentially. `null`/empty = phase vacuously passes. |
| `timeout`       | number      | no       | Per-attempt timeout. Default `300`.                 |
| `audit_roles`   | string[]    | no       | v0.6.0 (D2). See §6.1.                             |

### 6.1 `audit_roles` (D2)

Optional. Names the roles expected to verify the phase. The gate
runner validates that each role resolves against `profile.
resolved_bindings` (typo safety) and records the resolved /
unresolved lists on the phase result.

- Empty list or missing field: backward compatible, no audit
  metadata is recorded.
- All roles resolve: phase may pass when commands pass.
- Any role unresolved: phase **fails** with `audit_unresolved`
  populated, even if the shell commands succeeded. This catches
  stale role references at config-validation time.

**Real LLM-driven audit invocation remains the profile author's
responsibility** — invoke audit roles from your `commands:` block
(e.g. via `pi agent run --role coding-judge`). The framework cannot
dispatch sub-agents from the gate runner itself; the `audit_roles`
field is a declarative + typo-safety surface only.

---

## 7. `non_negotiables`

```yaml
non_negotiables:
  forbidden_patterns: []
  scope_constraints: {}
  required_gates: [compile, test]
```

The framework does not enforce non-negotiables at runtime — that
is the reviewer's job (see `docs/governance.md` or the project's
`SKILL.md`). The schema is consumed by reviewers and CI checks
external to the framework.

`forbidden_patterns: ForbiddenPattern[]` — each entry has
`pattern`, `message`, and a compiled `RegExp`.

---

## 8. `escalation`

```yaml
escalation:
  max_attempts: 3
  on_permanent_failure: stop   # "stop" | "continue"
  preserve_logs: true
  audit_max_resubmits: null    # v0.6.0; see §8.1
```

### 8.1 `audit_max_resubmits` (v0.6.0, A1)

Number, or `null`. The cap on audit-phase resubmissions. `null`
(default) means **unbounded** — per ADR-0007, audit rejections
should not be auto-retried. A finite number aborts the audit gate
after that many rejected resubmissions.

The validator (`scaffolder validate`) prints the value (or
"unbounded") in its summary.

---

## 9. `custom_roles`

Optional. `CustomRole[]` declares project-specific roles that do
not live in any framework-shipped role-pack.

```yaml
custom_roles:
  - name: reviewer-arbiter
    description: Adjudicate reviewer disagreements.
    agent_file: .pi/agents/coding-reviewer-arbiter.md
    default_alias: opus-thinking-medium
    default_channels: [official]
    triggers: ["@arbiter"]
```

The validator checks each `agent_file` resolves to a file that
exists.

---

## 10. `workflow` and role-groups

```yaml
workflow:
  role_groups: [coding]
```

Role-packs are organised into groups: `role-packs/<group>/*.md`.
The `role_groups` list tells the loader which groups are enabled.
A `bindings` key referencing a role in a disabled group is a
configuration error.

The framework ships the `coding` group. Additional groups are added
by dropping a directory under `role-packs/` and listing it here.

---

## 11. `validateAllContracts` — what gets checked

`src/contracts.ts` exposes three functions:

- `validateContractSchema(name, schema)` — throws `ContractError`
  on malformed schemas.
- `validateAllContracts(contracts, roleNames)` — returns a
  `string[]` of warnings; never throws.
- `checkContractPayload(role, payload)` — returns
  `{ ok: true }` or `{ ok: false, reason }`; never throws.

The scaffold validator runs `validateAllContracts` over the profile
and surfaces each warning. It also checks every key in `contracts`
is the name of a known role (from an enabled role-pack or from
`custom_roles`).

`checkContractPayload` is the structural check that downstream
tooling (workflow runners, audit post-processors) can use to verify
a role's output without re-implementing schema validation.

---

## 12. Required minimum

A profile that loads and runs the gate phase looks like this:

```yaml
framework_version: 0.2.0
name: minimal
description: |
  Smallest profile the loader accepts.

workflow:
  role_groups: [coding]

gates:
  smoke:
    commands: ["true"]
    timeout: 10

bindings:
  coding-architect:
    alias: opus-thinking-medium
    channels: [official]

non_negotiables:
  forbidden_patterns: []
  required_gates: []

escalation:
  max_attempts: 1
  on_permanent_failure: stop
  preserve_logs: false
```

That's it. `contracts`, `custom_roles`, `trigger_overrides`, and
every v0.6.0 frontmatter field (`allowed_tools`, `soul`,
`forbidden_bash_patterns`, `phase_inputs`, `deprecated_redirect`)
are optional.

---

## 13. Versioning

The `framework_version` field pins the schema. v0.6.0 accepts
`"0.2.0"` and is **additive** on top of it (new optional fields).
Removing an optional field would require a new framework_version
string; the loader rejects profiles whose `framework_version` it
does not understand.

The roadmap document is `references/v0.6.0-optimization-roadmap.md`
and the changelog lives in `CHANGELOG.md` (Keep-a-Changelog
format).