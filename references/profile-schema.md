# Profile schema reference (pi-rolecast v0.7.0)

Full schema lives at `references/v0.6.0-optimization-roadmap.md`,
`references/v0.7.0-optimization-roadmap.md`, and the live validator at
`src/profile_loader.ts` (TypeScript). For Python integration tests, the
historical schema lives at `scripts/profile_loader.py`.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `framework_version` | string | yes | Must match the installed framework version (e.g. `0.7.0`). |
| `name` | string | yes | Human-readable profile name. |
| `description` | string | yes | One-paragraph summary. |
| `workflow` | mapping | yes (v0.2.0+) | Holds `role_groups`. |
| `workflow.role_groups` | list[string] | yes | Which role groups are enabled. Empty list = no roles enabled. |
| `gates` | mapping | yes | Phase name → `{commands, timeout}`. May be empty. |
| `bindings` | mapping | yes | Full role name (`<group>-<role>` or custom name) → `{alias, channels, fallback_chain}`. May be empty. |
| `contracts` | mapping (v0.6.0+) | no | Full role name → JSON Schema for the role's structured output. Validated structurally by `scaffolder validate`. |
| `non_negotiables` | mapping | no | `forbidden_patterns`, `scope_constraints`, `required_gates`. |
| `escalation` | mapping | no | Numeric caps + failure policy. See [Escalation](#escalation). |
| `trigger_overrides` | mapping | no | Phrase → `{role}`. |
| `custom_roles` | list | no | User-defined roles. |

## Escalation

`profile.escalation` configures the gate-runner's retry behavior, the
audit workflow's cap on rejected-audit resubmits, and the failure
policy. All four numeric knobs accept either a non-negative integer or
`null` (the literal null means *unbounded*). Negative or fractional
values are rejected at load time by `parseNonNegIntOrNull`.

```yaml
escalation:
  max_attempts:                  2    # gate retry cap (existing)
  gate_max_attempts:            6    # session-level cap (v0.7.0 NEW)
  audit_max_resubmits:          2    # audit rejected-and-resubmit cap (v0.6.0)
  non_negotiable_max_retries:   1    # cap on non-negotiable violations (v0.7.0 NEW)
  on_permanent_failure:      stop   # stop | continue
  preserve_logs:            true    # boolean
```

| Field | Type | Default | Semantics |
|---|---|---|---|
| `max_attempts` | int ≥ 0 or null | `null` (unbounded) | Per-phase retry cap inside the gate-runner. |
| `gate_max_attempts` | int ≥ 0 or null | `null` (unbounded) | Session-level gate cap, summed across all phases. |
| `audit_max_resubmits` | int ≥ 0 or null | `null` (unbounded) | Cap on how many times the audit triad can reject work and have it re-routed to the coder/fixer. v0.6.0 introduced the field; v0.7.0 added runtime helpers in `src/audit_workflow.ts`. |
| `non_negotiable_max_retries` | int ≥ 0 or null | `null` (unbounded) | Cap on retries triggered by non-negotiable violations. |
| `on_permanent_failure` | `"stop"` or `"continue"` | `"stop"` | What the gate-runner does when a phase exhausts its cap. |
| `preserve_logs` | boolean | `true` | Whether the gate-runner should keep the log directory after failure. |

The gate-runner prints a compact one-line summary of all six knobs
after `validateProfile`:

```
escalation: max_attempts=2, gate_max_attempts=6, audit_max_resubmits=2,
            non_negotiable_max_retries=1, on_permanent_failure=stop,
            preserve_logs=true
```

## Bindings

```yaml
bindings:
  <group>-<role>:
    alias:          model-id-from-cost-expectations-or-frontend-id
    channels:       [official, relay-default]
    fallback_chain:  # optional (v0.3.0+)
      - provider/model-id
      - provider/model-id
```

`alias` must resolve to a model exposed by your cost-expectations
configuration (or fall through to the parent session model). At
dispatch time, the gate-runner picks the first candidate in
`fallback_chain` whose model exposes at least one channel listed in
`channels`, and whose `requires` from the role-pack are satisfied.

### v0.7.0: legacy role-name migration

`LEGACY_ROLE_ALIASES` was removed in v0.7.0. Profiles that still
reference v0.6.0-era binding names — `coding-implementer`,
`coding-reviewer`, `coding-docs`, `coding-orchestrator` — fail at
load time with a `ProfileError` that names the new role (or
"REMOVED" for `coding-orchestrator`):

```
profile.bindings: bindings key 'coding-implementer' is not in any
enabled role group and is not declared in custom_roles
(hint: 'coding-implementer' was renamed to 'coding-coder' in v0.6.0.
Update your .pi/rolecast.yaml bindings to use the new name.
See references/v0.6.0-optimization-roadmap.md.)
```

The same hint fires at dispatch time when an `@coding-implementer`
at-handle reaches the extension's `tool_call` hook.

Migration table:

| v0.6.0-era name | v0.7.0-era name | Notes |
|---|---|---|
| `coding-implementer` | `coding-coder` | ADR-0034 worker split |
| `coding-reviewer` | `coding-judge` | ADR-0034 audit triad |
| `coding-docs` | `coding-diarist` | ak semantics |
| `coding-orchestrator` | *(removed)* | ADR-0010 — caller dispatches directly |

The four legacy role-pack markdown files are preserved on disk with
`deprecated_redirect` in frontmatter and skipped at discovery time.
v0.8.x will delete them outright.

## Contracts (v0.6.0+)

```yaml
contracts:
  <group>-<role>:
    type: object
    properties:
      verdict:
        type: string
        enum: [approve, reject, request_changes]
      reasons:
        type: array
        items:
          type: string
    required: [verdict]
```

`profile.contracts` declares a JSON Schema that the role's structured
output should satisfy. The schema is validated *structurally* by
`scaffolder validate` (see `src/contracts.ts`) — not enforced at
dispatch. This is the destination contract, not the runtime check.
Workflow orchestrators can call `checkContractPayload` (from
`src/contracts.ts`) if they want a non-fatal verdict on an
already-produced payload.

`validateAllContracts` checks each contract declaration against a
small subset of JSON Schema keywords: `type`, `required`, `properties`,
`additionalProperties`, `enum`, `items`, `description`, `title`,
`default`. Other keywords are rejected with a "File an issue" hint so
the framework's structural validator doesn't silently drift from the
declared vocabulary.

## Audit counter (v0.7.0+)

The runtime counterpart to `escalation.audit_max_resubmits` is a
counter at `<logDir>/counters/audit-counter.json` holding
`{ "audit_attempt": number }`. The framework exposes pure helpers in
`src/audit_workflow.ts`:

```typescript
import {
    readAuditCounter,
    incrementAuditCounter,
    canResubmit,
    resetAuditCounter,
} from "pi-rolecast/dist/audit_workflow.js";

const allowed = canResubmit(profile.escalation, logDir);
if (!allowed.allowed) {
    throw new Error(
        `audit cap exhausted after ${allowed.attempt} of `
        + `${profile.escalation.audit_max_resubmits}`,
    );
}
incrementAuditCounter(logDir);
// dispatch the coder/fixer...
```

`canResubmit` returns `{ allowed, attempt, max, remaining }`. It does
not mutate state — the caller increments after deciding to resubmit.
Atomic counter writes (tmp file + rename) prevent concurrent readers
from observing a partial JSON document.

## Role-pack frontmatter

Each role lives at `role-packs/<group>/<role>.md`. Frontmatter
keys consumed by `discoverRolePacks`:

| Key | Type | Notes |
|---|---|---|
| `name` | string | Full role name (`<group>-<role>`). Defaults to filename. |
| `description` | string | One-paragraph summary. |
| `model` | string | Default model id; used when no binding is declared. |
| `thinking` | string | `low` / `medium` / `high`. |
| `model_tier` | string | `cheap` / `balanced` / `strong`. |
| `model_recommendation` | string | Suggested model id from your cost-expectations. |
| `requires` | mapping | Capability requirements (e.g. `reasoning_tier: high`, `context_window: 64000`, `features: [thinking, tool_use]`). |
| `preferences` | mapping | Soft preferences (best-effort, not enforced). |
| `allowed_tools` | list[string] (v0.6.0+) | Tools the role is allowed to call. Documented in the role-pack `.md` (declarative, not enforced at dispatch — see `src/extension.ts` `enforceRoleNarrowing` for the runtime enforcement surface). |
| `soul` | string (v0.6.0+) | Relative path from this role file to a shared soul markdown. |
| `forbidden_bash_patterns` | list[string] (v0.6.0+) | Literal substrings; documented as bash seatbelt in the role-pack `.md`. |
| `deprecated_redirect` | string or null (v0.7.0+) | When present, the file is skipped at discovery time. The value points at the successor role (or `null` for fully removed). |

## Migration guide (v0.6.0 → v0.7.0)

1. Open your `.pi/rolecast.yaml` bindings and rename:
   * `coding-implementer` → `coding-coder`
   * `coding-reviewer` → `coding-judge`
   * `coding-docs` → `coding-diarist`
   * `coding-orchestrator` — *remove the line entirely*
2. Same for `contracts:` declarations.
3. Add `escalation.gate_max_attempts` and
   `escalation.non_negotiable_max_retries` if you want explicit caps;
   leave unset (null) for unbounded.
4. If you wrote a workflow orchestrator that retries on audit
   rejection, import the helpers from `pi-rolecast/dist/audit_workflow.js`
   and call `canResubmit` + `incrementAuditCounter` instead of
   rolling your own counter.

After updating, run `npx pi-rolecast rolecast-validate` and verify
the escalation summary line shows your six fields.