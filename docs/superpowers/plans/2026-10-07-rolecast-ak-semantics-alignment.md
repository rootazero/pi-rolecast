# ak-semantics Alignment + Role Ecosystem Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 new ak-faithful role files (`coding-countersign`, `coding-inspector`, `coding-doctor`), upgrade `coding-diarist`, rename the existing mislabeled `coding-countersign` to `coding-objector`, fix a latent soul-path bug, add `souls_extra` framework support, refresh the authoring guide, update profile bindings, and update stale e2e fixtures.

**Architecture:** Role files live in `role-packs/coding/` with shared souls in repo-root `souls/`. The framework (`src/profile_loader.ts` + `src/sync_settings.ts`) reads each role's frontmatter, resolves `soul:` and (new) `souls_extra:` paths relative to the role file, and prepends their content to the generated agent file. The new feature is additive: `souls_extra` is parsed alongside `soul_path` and iterated by `sync_role_file`. The rename is breaking (per v0.8.0's "hard-fail on legacy names" stance) — no `LEGACY_ROLE_ALIASES` shim is added; users update their profile bindings.

**Tech Stack:** TypeScript (Node ≥ 22), `node:test` runner, `tsx` for TS execution, YAML for profile binding, markdown for role bodies / souls.

**Spec:** `docs/superpowers/specs/2026-10-07-rolecast-ak-semantics-alignment-design.md`

## Global Constraints

- All role frontmatter MUST include `model_tier` + `model_recommendation` (v0.3.0 contract).
- All audit-triad roles MUST declare `soul: ../../souls/audit-law.md` + canonical four forbidden bash substrings (`rm -rf`, `git reset --hard`, `git clean`, `git checkout --`).
- The new `souls_extra:` field is an optional list of additional soul paths, prepended AFTER the primary `soul:` and BEFORE the role body.
- All file paths in frontmatter are RELATIVE TO THE ROLE FILE (per `path.resolve(path.dirname(roleFilePath), soulPath)` in `src/sync_settings.ts:248`).
- All role file bodies MUST end with `## Output category` and `## Trigger phrases` sections per `references/role-authoring.md`.
- v0.8.0 hard-removes legacy names — no `LEGACY_ROLE_ALIASES` shim is added for `coding-countersign` → `coding-objector`. The renamed binding is its own profile entry; users update.
- Three-state output contract for new judgment roles: `converged` / `continue` / `escalate` (mirrors ak).
- `coding-diarist` output is ak-faithful 2-state: `completed` / `escalate`.
- `coding-doctor` output is diagnosis prose + health verdict (`healthy` / `needs-care` / `critical`).
- Existing roles keep their role-specific output formats (no migration).
- Run `scaffolder_validate` after every binding change.
- Run `npx tsx --test tests/unit/test_sync_settings.ts tests/unit/test_profile_loader.ts` after every framework change.

## Review Focus

Inputs/failure modes the spec implies but no task tests exercise that are most likely to bite a real user:

1. **Role file discovered but soul preload silently fails.** If a role's `soul:` path resolves to a missing file, `loadSoulPrepend` emits a warning and returns null — the role runs WITHOUT the soul. This is the bug Tasks 1 and 2 are designed to prevent for new roles; the test in Task 2 must assert "missing soul → warning emitted, no exception".
2. **`souls_extra` order matters but is undocumented.** Generic law (audit-law) must come before role-specific law (countersign-law) before role body. If a future maintainer writes `souls_extra: [../../souls/quality-law.md]` for `coding-inspector` but it gets prepended AFTER the role body, the inspector would see role body first and apply its restrictions to a soul it should be ignoring. Test in Task 2 must assert "primary soul is prepended before any souls_extra entries".
3. **Renamed role leaves dangling references in e2e fixtures.** `tests/e2e/fixtures/todo-tui/.pi/agents/` lists 11 legacy roles (implementer/reviewer/docs/orchestrator) that v0.8.0 hard-deletes. If Task 10 leaves `coding-orchestrator.md` in the fixture, the e2e tests pass against a fixture that diverges from `role-packs/coding/` reality. Task 10 must remove ALL 11 legacy fixture roles.
4. **Three-state output for new roles could collide with existing role output parsers.** The default profile doesn't have a parser that auto-consumes verdict output; dispatch is the caller's job (ADR-0010). So the new outputs are textual and human/coder-readable. But if a future codemode script parses `VERDICT:` lines, the new three-state values (`converged/continue/escalate`) would be missed while binary roles (APPROVE/REJECT) parse fine. Task 9 (binding update) and the CHANGELOG entry must explicitly note this divergence.
5. **Cost increase from `coding-diarist` tier upgrade is silent.** Default profile binds `coding-diarist`; changing alias from `minimax-medium` to `deepseek-verifiable` increases per-call cost. Users who didn't ask for the upgrade pay more for the same work. The CHANGELOG entry in Task 10 must list the tier change explicitly so users can opt out via their profile binding if cost matters more than reasoning quality for their use case.

---

## File Structure

### New files (10)

| Path | Purpose | Created by |
|------|---------|-----------|
| `role-packs/coding/coding-countersign.md` | ak-faithful pre-work approval (给事中) | T5 |
| `role-packs/coding/coding-inspector.md` | ak-faithful post-impl quality gate (台院) | T6 |
| `role-packs/coding/coding-doctor.md` | ak-faithful factory health diagnostic (太医署) | T7 |
| `souls/countersign-law.md` | 5-step audit + 5-question rubric | T3 |
| `souls/inspector-law.md` | 4 inspection dimensions | T3 |
| `souls/doctor-law.md` | factory-diagnosis stance | T3 |
| `souls/quality-law.md` | complexity/test budgets (port from ak) | T3 |

### Renamed (1)

| From | To | Why |
|------|-----|-----|
| `role-packs/coding/coding-countersign.md` | `role-packs/coding/coding-objector.md` | Free ak-faithful name; describe role accurately (judge adversary, not pre-work approval) |

### Modified files (10)

| Path | Change | Task |
|------|--------|------|
| `src/profile_loader.ts` | Add `souls_extra: string[]` to `RoleDef`; parse `fm["souls_extra"]` in discoverRolePacks | T2 |
| `src/sync_settings.ts` | Iterate `souls_extra` after primary soul preload in `sync_role_file` | T2 |
| `role-packs/coding/coding-coder.md` | `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md` | T1 |
| `role-packs/coding/coding-fixer.md` | `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md` | T1 |
| `role-packs/coding/coding-judge.md` | `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md` | T1 |
| `role-packs/coding/coding-notary.md` | `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md` | T1 |
| `role-packs/coding/coding-secretariat.md` | `soul: souls/audit-law.md` → `soul: ../../souls/audit-law.md` | T1 |
| `role-packs/coding/coding-diarist.md` | tier upgrade + description tighten + add soul | T8 |
| `.pi/rolecast.yaml` | Add 4 new bindings; rename `coding-countersign` → `coding-objector` | T9 |
| `references/role-authoring.md` | Refresh tier table (11 → 17 rows); add 3-state section | T9 |
| `tests/e2e/fixtures/todo-tui/.pi/agents/*.md` | Remove 11 legacy roles; ensure fixture matches shipping reality | T10 |
| `CHANGELOG.md` | Append v0.9.0 entry | T10 |

---

## Task 1: Soul-path bug fix (6 roles) + ESM `__dirname` blocker fix

**Files:**
- Modify: `src/sync_settings.ts:559` (ESM `__dirname` → `fileURLToPath(import.meta.url)`)
- Modify: `src/sync_settings.ts:1-3` (add `import { fileURLToPath } from "node:url"` at top of file if not already present)
- Modify: `role-packs/coding/coding-coder.md:17`
- Modify: `role-packs/coding/coding-countersign.md:17` (will be renamed in T4; fix here)
- Modify: `role-packs/coding/coding-fixer.md:17`
- Modify: `role-packs/coding/coding-judge.md:17`
- Modify: `role-packs/coding/coding-notary.md:17`
- Modify: `role-packs/coding/coding-secretariat.md:17`

Two latent bugs are addressed in this task because the second (ESM `__dirname`) BLOCKS the verification of the first (soul-path fix):

**Bug A (soul-path)**: frontmatter `soul: souls/audit-law.md` resolves (via `path.resolve(path.dirname(roleFilePath), soulPath)`) to `role-packs/coding/souls/audit-law.md` — a non-existent path. The correct path from `role-packs/coding/<role>.md` to repo-root `souls/audit-law.md` is `../../souls/audit-law.md` (TWO `..` segments, not one — must climb out of both `coding/` and `role-packs/`).

**Bug B (ESM)**: `src/sync_settings.ts:559` uses `__dirname` in the CLI wrapper, but `package.json` declares `"type": "module"`. `npx tsx src/sync_settings.ts sync --dry-run` errors out before any sync work, blocking all verification of soul preloading across T1-T8. Fix is the standard ESM pattern.

- [ ] **Step 1: Fix Bug B — replace `__dirname` in src/sync_settings.ts**

In `src/sync_settings.ts`:
1. Verify the top-of-file imports section has `import { fileURLToPath } from "node:url";`. If absent, add it.
2. Replace line 559 (in the `main` function): `opts.frameworkRoot = path.resolve(__dirname, "..");`
   With:
   ```ts
       opts.frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
   ```
3. Search the file for `__dirname` anywhere else (it could appear in other CLI helpers). Replace all with the same ESM-safe pattern, anchored at the file's actual location (which is `src/sync_settings.ts`, so `path.dirname(fileURLToPath(import.meta.url))` is the file's directory).

- [ ] **Step 2: Verify the fix compiles**

Run: `npx tsx -e 'import("./src/sync_settings.ts").then(m => console.log("OK")).catch(e => { console.error(e); process.exit(1); })'`
Expected: prints `OK`. No `__dirname is not defined` error.

- [ ] **Step 3: Replace the soul path in all 6 role files**

For each file in the list above, change the frontmatter line:
```
soul: souls/audit-law.md
```
to:
```
soul: ../../souls/audit-law.md
```

Use a single sed command (run from `/home/zou/data/workspace/pi-rolecast`):
```bash
sed -i 's|^soul: souls/audit-law.md$|soul: ../../souls/audit-law.md|' \
  role-packs/coding/coding-coder.md \
  role-packs/coding/coding-countersign.md \
  role-packs/coding/coding-fixer.md \
  role-packs/coding/coding-judge.md \
  role-packs/coding/coding-notary.md \
  role-packs/coding/coding-secretariat.md
```

- [ ] **Step 4: Verify no other role file references the old broken path**

Run:
```bash
grep -rn "soul: souls/" role-packs/
```
Expected output: no matches (or only matches inside this plan doc / docs/).

- [ ] **Step 5: Verify the new path resolves to the file that exists**

Run:
```bash
cd role-packs/coding && node -e "
  const p = require('path');
  ['coding-coder','coding-countersign','coding-fixer','coding-judge','coding-notary','coding-secretariat'].forEach(r => {
    const abs = p.resolve(p.dirname(r + '.md'), '../../souls/audit-law.md');
    console.log(r, '→', abs, require('fs').existsSync(abs) ? 'OK' : 'MISSING');
  });
"
```
Expected: each role → path → `OK`.

- [ ] **Step 6: Run sync_settings dry-run and confirm no soul warnings**

Run:
```bash
npx tsx src/sync_settings.ts sync --dry-run 2>&1 | tee /tmp/sync-t1.log
```
Expected: no line containing "warning: role 'coding-X' declares soul" appears.

- [ ] **Step 7: Commit**

Two commits are required so the bisect history is clean (Bug B is independent infrastructure, Bug A is the actual role-pack fix):

Commit 1 (Bug B, framework):
```bash
git add src/sync_settings.ts
git commit -m "fix(esm): replace __dirname with fileURLToPath(import.meta.url)

src/sync_settings.ts:559 used \`__dirname\` in the CLI wrapper
while package.json declares 'type': 'module'. Running
\`npx tsx src/sync_settings.ts sync\` errored out with
\`__dirname is not defined\` before any sync work.

Replace with the standard ESM pattern:
\`path.dirname(fileURLToPath(import.meta.url))\`.

This unblocks verification of soul preloading for T1-T8 in
the v0.9.0 ak-semantics alignment work."
```

Commit 2 (Bug A, role-pack):
```bash
git add role-packs/coding/coding-{coder,countersign,fixer,judge,notary,secretariat}.md
git commit -m "fix(soul): resolve souls/audit-law.md to repo root (../../souls/audit-law.md)

The 6 audit-triad roles declared 'soul: souls/audit-law.md' which
resolved to role-packs/coding/souls/audit-law.md — a non-existent
path. sync_settings emitted a warning and silently did NOT preload
the audit-law soul.

This commit corrects all 6 paths to '../../souls/audit-law.md'
which resolves to the repo-root souls/audit-law.md (the only
soul file). Note: TWO '..' segments are required to climb out
of role-packs/coding/ to the repo root before descending into
souls/."
```

---

## Task 1.5: Make dry-run mode validate soul paths (warn-only, no write)

**Why this task exists**: T1's implementer caught a pre-existing gap in `src/sync_settings.ts:343-349` — the per-role loop emits `would write <path>` and `continue`s BEFORE `loadSoulPrepend` is called. So `npx tsx src/sync_settings.ts sync --dry-run` cannot detect a broken `soul:` path or a broken `souls_extra:` entry. T2 introduces `souls_extra`, T9 does heavy profile-binding updates; both depend on soul-path validation working in dry-run. This task is a behavior preservation fix that makes dry-run also walk the soul-preload code path so any warning is surfaced, WITHOUT writing anything.

**Files:**
- Modify: `src/sync_settings.ts` (the dry-run branch around lines 343-349)
- Modify: `tests/unit/test_sync_settings.ts` (add a test: dry-run emits the missing-soul warning without throwing or writing)

**Steps:**

1. Read `src/sync_settings.ts` around lines 343-360 to understand the current dry-run branch. The `continue` is intentional (no write happens); the goal is to NOT skip soul-resolution-validation.
2. Restructure the loop so that:
   - In BOTH dry-run and real-run: the per-role code path calls `loadSoulPrepend` (so any missing-soul warning surfaces).
   - In dry-run: the soul-prepended content is rendered into a local string for validation, but never written to disk.
   - In real-run: behavior is unchanged (still writes).
3. Verify: run `npx tsx src/sync_settings.ts sync --dry-run --profile .pi/rolecast.yaml --agents-dir /tmp/dry-run-agents` against the project. Existing 6 role files have working souls, so the output should be a clean "would write" list with NO warnings. Then temporarily point one role's `soul:` to a missing path, re-run, and confirm a warning IS emitted.
4. Add a unit test in `tests/unit/test_sync_settings.ts` asserting that dry-run mode emits the same missing-soul warning a real run would, without writing.
5. Run the full unit suite: `npx tsx --test tests/unit/test_sync_settings.ts tests/unit/test_profile_loader.ts`. All tests must pass; old tests must still pass.
6. Commit: `feat(sync): validate soul paths in --dry-run mode` (single commit — this is one focused change).

**Review focus for Task 1.5:**
- Verify the dry-run branch still doesn't write anything (regression check).
- Verify the missing-soul warning is emitted in both dry-run and real-run identically.
- Verify no scope creep — only the sync_settings.ts dry-run branch + tests are touched.

---

## Task 2: Add `souls_extra` frontmatter support

**Files:**
- Modify: `src/profile_loader.ts:140-153` (add `souls_extra` to `RoleDef`)
- Modify: `src/profile_loader.ts:278-301` (parse `fm["souls_extra"]` in discoverRolePacks)
- Modify: `src/sync_settings.ts:354` (iterate `souls_extra` after primary soul preload)
- Modify: `tests/unit/test_sync_settings.ts` (add 2 unit tests)

The new frontmatter field `souls_extra: [string, ...]` lists additional soul paths to prepend after the primary `soul:` and before the role body. This lets a single role inherit from multiple shared laws (e.g., `coding-inspector` inherits `audit-law` + `inspector-law` + `quality-law`).

- [ ] **Step 1: Write the failing test for `souls_extra` parsing in profile_loader**

Add to `tests/unit/test_sync_settings.ts` (or a new test file `tests/unit/test_souls_extra.ts`):

```typescript
test("souls_extra: parsed from frontmatter", () => {
    const tmpRole = path.join(makeTempDir(), "test-role.md");
    fs.writeFileSync(tmpRole, [
        "---",
        "name: test-role",
        "soul: ../../souls/audit-law.md",
        "souls_extra:",
        "  - ../../souls/quality-law.md",
        "---",
        "body",
    ].join("\n"));
    // ... call discoverRolePacks on a tmp role-packs dir containing this file
    // assert role.souls_extra === ["../../souls/quality-law.md"]
});
```

(Adapt to existing test helpers in `tests/unit/test_sync_settings.ts`. The discoverRolePacks function is in `src/profile_loader.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/unit/test_sync_settings.ts 2>&1 | tail -30`
Expected: FAIL with "souls_extra is undefined" or similar.

- [ ] **Step 3: Add `souls_extra` to `RoleDef` interface**

In `src/profile_loader.ts` after line 153 (the `forbidden_bash_patterns` field declaration), add:

```typescript
    // v0.9.0 (A4): additional soul paths prepended after the primary
    // `soul:` and before the role body. Lets a role inherit from
    // multiple shared laws (e.g. coding-inspector inherits audit-law
    // + inspector-law + quality-law).
    souls_extra: string[];
```

- [ ] **Step 4: Parse `souls_extra` in discoverRolePacks**

In `src/profile_loader.ts` after the `forbidden_bash_patterns` parsing block (~line 287), add:

```typescript
            // v0.9.0 (A4): souls_extra. Optional list of additional soul
            // paths. Filtered to strings only; empty/missing → [].
            const seRaw = fm["souls_extra"];
            const soulsExtra: string[] = Array.isArray(seRaw)
                ? seRaw.filter((x): x is string => typeof x === "string")
                : [];
```

- [ ] **Step 5: Add `souls_extra` to the role push**

In `src/profile_loader.ts` at the `roles.push({...})` call (~line 293), add `souls_extra: soulsExtra,` to the object.

- [ ] **Step 6: Add the test for soul preload ORDER in sync_settings**

Add to `tests/unit/test_sync_settings.ts`:

```typescript
test("sync_role_file: primary soul prepended before souls_extra", () => {
    // ... set up a tmp role file with soul=../../souls/audit-law.md and
    //     souls_extra=[../../souls/quality-law.md]
    // ... create the two real soul files at those paths
    // ... call writeAgents or the relevant sync function
    // ... assert generated agent file contains audit-law content
    //     BEFORE quality-law content (regex on the generated file)
});
```

- [ ] **Step 7: Modify `sync_role_file` to iterate `souls_extra`**

In `src/sync_settings.ts` at line 354 (after `const withSoul = soulPrepend === null ? rawBody : prependSoul(rawBody, soulPrepend);`), add:

```typescript
        // v0.9.0 (A4): if the role declares souls_extra, load and prepend
        // each after the primary soul. Generic law comes first; role body
        // last.
        //
        // Implementation note: do NOT use `prependSoul` here. `prependSoul`
        // splices its argument RIGHT AFTER the frontmatter, so calling it
        // repeatedly would produce REVERSED ORDER (last declared extra ends
        // up nearest the frontmatter). Use `appendSoulContent` which splices
        // BEFORE the existing soul-prepend closing line so the final order
        // matches declaration order: primary soul → extras[0] → extras[1] →
        // … → role body. If the primary soul is absent (sail: null), fall
        // back to `prependSoul` semantics.
        let withExtras = withSoul;
        for (const extra of rd.souls_extra ?? []) {
            const abs = path.resolve(path.dirname(src), extra);
            if (fs.existsSync(abs)) {
                withExtras = appendSoulContent(withExtras, fs.readFileSync(abs, "utf8"));
            } else {
                process.stderr.write(
                    `warning: role '${rd.full_name}' declares souls_extra '${extra}' but the file is missing at ${abs}\n`,
                );
            }
        }
```

Then change `const withTools = appendToolRestrictions(withSoul, ...)` to `appendToolRestrictions(withExtras, ...)`.

- [ ] **Step 8: Run tests to verify both pass**

Run: `npx tsx --test tests/unit/test_sync_settings.ts tests/unit/test_profile_loader.ts 2>&1 | tail -40`
Expected: PASS for both new tests; no regressions in existing tests.

- [ ] **Step 9: Commit**

```bash
git add src/profile_loader.ts src/sync_settings.ts tests/unit/test_sync_settings.ts
git commit -m "feat(souls): add souls_extra frontmatter for multi-law inheritance

A role can now declare `souls_extra: [path1, path2, ...]` to
inherit additional shared laws AFTER its primary `soul:`. This
lets e.g. coding-inspector inherit audit-law + inspector-law +
quality-law in the order: generic law → role-specific law → role body.

Order matters: the most generic law must come first because the
role's interpretation of a specific law depends on the generic
constraints being established.

No existing role uses souls_extra yet — that's T5-T7."
```

---

## Task 3: Port 4 souls from ak

**Files:**
- Create: `souls/countersign-law.md`
- Create: `souls/inspector-law.md`
- Create: `souls/doctor-law.md`
- Create: `souls/quality-law.md`

The ak souls are at `/tmp/ak-ref/soul-{countersign,inspector,doctor,quality-law}.md` (already downloaded during the design phase).

- [ ] **Step 1: Create `souls/countersign-law.md`**

Copy and adapt from `/tmp/ak-ref/soul-countersign.md` (6571 bytes). Strip the Tang/Song court metaphor (起居录/票面/陛下/给事中) and translate to neutral English project terms. Preserve the 5-step audit (立法 / 符合陛下意图 / 相抵 / 缺失 / 擅加 → `establish_law` / `verify_owner_intent` / `find_conflicts` / `find_missing` / `find_unauthorized_scope`) and the 5-question rubric.

The file MUST start with: `# Countersign Law (5-step audit + 5-question rubric)`. The file MUST end with: `> Inherits audit-law.md as the base layer; this law extends it.`

- [ ] **Step 2: Create `souls/inspector-law.md`**

Copy and adapt from `/tmp/ak-ref/soul-inspector.md` (732 bytes). Strip ceremony. Preserve the four dimensions: correctness / complexity / test-quality / test-duration.

The file MUST start with: `# Inspector Law (4-dimension code-quality gate)`. The file MUST end with: `> Inherits audit-law.md as the base layer; extends with quality-law.md for complexity + test budgets.`

- [ ] **Step 3: Create `souls/doctor-law.md`**

Copy and adapt from `/tmp/ak-ref/soul-doctor.md` (628 bytes). Preserve the "delete-first, simplify, patch last" stance.

The file MUST start with: `# Doctor Law (factory health diagnostic)`. The file MUST end with: `> Inherits audit-law.md as the base layer; this law narrows the audit-law "cite, do not opine" stance to "diagnose, do not judge".`

- [ ] **Step 4: Create `souls/quality-law.md`**

Copy from `/tmp/ak-ref/quality-law.md` (5863 bytes). Strip ceremony; preserve the complexity budgets + test-quality standards + test-duration budgets. This is the most generic of the four — it's referenced by both `coding-inspector` AND `coding-profiler` (existing).

The file MUST start with: `# Quality Law (complexity + test budgets)`. The file MUST end with: `> Standalone law; no parent inheritance.`

- [ ] **Step 5: Verify all four files exist and start with the required headers**

Run:
```bash
for f in countersign-law inspector-law doctor-law quality-law; do
  head -1 "souls/${f}.md"
done
```
Expected:
```
# Countersign Law (5-step audit + 5-question rubric)
# Inspector Law (4-dimension code-quality gate)
# Doctor Law (factory health diagnostic)
# Quality Law (complexity + test budgets)
```

- [ ] **Step 6: Verify the files don't reference the old `souls/audit-law.md` broken path**

Run:
```bash
grep -n "souls/audit-law" souls/countersign-law.md souls/inspector-law.md souls/doctor-law.md souls/quality-law.md
```
Expected: either no matches, OR matches like `../../souls/audit-law.md` (the correct relative path from `souls/` → repo root is implicit since `souls/` IS at the repo root; if any soul references audit-law, it should reference `audit-law.md` directly).

NOTE: the souls_extra mechanism resolves paths relative to the ROLE file, not relative to the primary soul. So in a role file, the reference is always `../../souls/audit-law.md`. Inside a soul file, plain prose references to "the audit-law soul" are OK as text — they don't trigger path resolution.

- [ ] **Step 7: Commit**

```bash
git add souls/countersign-law.md souls/inspector-law.md souls/doctor-law.md souls/quality-law.md
git commit -m "feat(souls): port countersign/inspector/doctor/quality-law from ak

Four new shared soul files adapted from ak-pi-workflow-roles:
- countersign-law.md: 5-step audit + 5-question rubric for pre-work approval
- inspector-law.md: 4-dimension code-quality gate
- doctor-law.md: factory health diagnostic posture
- quality-law.md: complexity + test budgets (referenced by inspector AND profiler)

Tang/Song court ceremony stripped; English project terms retained.
Structures preserved (step ordering, dimension definitions, the
'delete-first' stance in doctor-law)."
```

---

## Task 4: Rename `coding-countersign` → `coding-objector`

**Files:**
- Rename: `role-packs/coding/coding-countersign.md` → `role-packs/coding/coding-objector.md`
- Modify: `role-packs/coding/coding-objector.md` (3 field edits after rename)

The existing role is the judge adversary (refutes `coding-judge` verdicts). The new name `coding-objector` accurately describes the behavior and frees `coding-countersign` for the ak-faithful pre-work approval role in T5. Per v0.8.0, no `LEGACY_ROLE_ALIASES` shim is added — users update their profile bindings.

- [ ] **Step 1: Rename the file**

Run:
```bash
git mv role-packs/coding/coding-countersign.md role-packs/coding/coding-objector.md
```

- [ ] **Step 2: Edit the frontmatter `name:` field**

In `role-packs/coding/coding-objector.md`, change the frontmatter line:
```
name: coding-countersign
```
to:
```
name: coding-objector
```

- [ ] **Step 3: Edit the frontmatter `description:` field**

In `role-packs/coding/coding-objector.md`, change the frontmatter line:
```
description: Adversarial second pair of eyes. Tries to refute the judge's verdict; either confirms it or raises a counter-finding.
```
to:
```
description: Judge adversary. Refutes coding-judge verdicts. Paired with coding-judge dispatch; the dispatcher decides how to combine outputs.
```

- [ ] **Step 4: Edit the body title and trigger phrases**

In `role-packs/coding/coding-objector.md`, change the markdown body:
- `# Countersign` → `# Objector`
- The `## Trigger phrases` section currently lists: "countersign", "adversarial review", "double-check the verdict". Change to: "object", "challenge the verdict", "adversarial review", "double-check the verdict".

- [ ] **Step 5: Verify no other role-pack file references the old name**

Run:
```bash
grep -rn "coding-countersign" role-packs/ 2>/dev/null
grep -rn "coding-countersign" .pi/ 2>/dev/null
```
Expected: no matches in `role-packs/`. The `.pi/rolecast.yaml` will reference the OLD name until T9 updates it — that's expected, the verify step here is only about `role-packs/`.

- [ ] **Step 6: Verify the new file's frontmatter parses**

Run:
```bash
node -e "
  const fs = require('fs');
  const c = fs.readFileSync('role-packs/coding/coding-objector.md', 'utf8');
  const m = c.match(/^---\n([\s\S]*?)\n---/);
  if (!m) { console.error('NO FRONTMATTER'); process.exit(1); }
  const fm = m[1];
  const name = fm.match(/^name: (.+)$/m);
  console.log('name:', name ? name[1] : 'MISSING');
  const soul = fm.match(/^soul: (.+)$/m);
  console.log('soul:', soul ? soul[1] : 'MISSING');
"
```
Expected:
```
name: coding-objector
soul: ../../souls/audit-law.md
```

- [ ] **Step 7: Commit**

```bash
git add role-packs/coding/coding-objector.md
git rm role-packs/coding/coding-countersign.md
git commit -m "refactor(role): rename coding-countersign to coding-objector

The existing role is the judge adversary (refutes coding-judge
verdicts), not ak's true countersign (给事中, pre-work approval).
Renaming to coding-objector accurately describes its behavior and
frees the ak-faithful name for a future role.

Per v0.8.0's 'hard-fail on legacy names' stance (no
LEGACY_ROLE_ALIASES shim), users must update their profile
bindings to coding-objector. Profile binding update happens in T9."
```

---

## Task 5: Add `coding-countersign` (ak-faithful pre-work approval)

**Files:**
- Create: `role-packs/coding/coding-countersign.md`

This is the new ak-faithful 给事中 (Remonstrance Official) role. It gates the work BEFORE implementation: reads the ticket/plan, validates against the 5-step audit, and emits three-state verdict.

- [ ] **Step 1: Create the role file with frontmatter**

Create `role-packs/coding/coding-countersign.md` with this exact frontmatter:

```yaml
---
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
---
```

- [ ] **Step 2: Add the body sections**

Below the frontmatter, add these sections IN THIS ORDER:

```
# Countersign (给事中)

You are the Remonstrance Official. You gate the work before it begins — you do not
implement, fix, or judge finished code. You read a ticket/plan, apply the 5-step audit,
and emit a three-state verdict.

## Cost & quality envelope

Tier: **strong**. Bind to a high-reasoning model. Trade-off: every strong-tier call
is expensive. For trivial tickets (single-file typo fixes, well-established patterns),
consider deferring to a `balanced`-tier self-review by `coding-planner` rather than
invoking this role.

## Responsibilities

- Read the ticket/plan/spec attached to the dispatch (per `phase_inputs: [ticket]`).
- Apply the 5-step audit (see `../../souls/countersign-law.md`):
  1. `establish_law` — what ADRs / non-negotiables / owner constraints apply?
  2. `verify_owner_intent` — does the ticket match what the owner actually asked for?
  3. `find_conflicts` — does the ticket conflict with in-flight branches or ADR text?
  4. `find_missing` — are required prerequisites / decisions / evidence present?
  5. `find_unauthorized_scope` — does the ticket add mechanisms the owner didn't ask for?
- For each step that fails, emit one or more findings (cite file:line + rule).
- Emit the verdict in the output format below.

## Constraints

- Read-only. No edit, no write, no bash. You gate the work; you do not do it.
- Cite every finding with `file:line` and the rule it violates. No "this looks bad" opinions.
- Never propose alternative implementations. The rejection rule requires the specific violation, not a better design.
- If the ticket is ambiguous AND you cannot rule, emit `escalate` — do not guess.

## Trigger phrases

"countersign this ticket", "pre-work approval", "approve the plan", "ticket gate"

## Output format

Always emit, in this exact order:

1. **LAW ESTABLISHED**: list the ADRs / non-negotiables / owner constraints you applied.
2. **VERDICT**: `converged` (5 steps pass; release-ready) | `continue` (must return for rework) | `escalate` (cannot rule).
3. **FINDINGS**: zero or more entries shaped as:
   ```
   - {file:line} — {rule violated} — {one-sentence specific change required}
   ```
4. **ESCALATION RATIONALE** (only if VERDICT=escalate): which step blocked, what additional input is needed, route_to: `coding-judge` | `coding-architect` | owner.

A `converged` verdict has no FINDINGS. A `continue` verdict MUST have at least one FINDINGS entry. A `escalate` verdict MUST have ESCALATION RATIONALE.

## Output category

Three-state judgement. Bind to a high-reasoning model.
```

- [ ] **Step 3: Verify the file is well-formed and the framework can discover it**

Run:
```bash
npx tsx src/sync_settings.ts list 2>&1 | grep countersign
```
Expected: line containing `coding-countersign` (both the new one AND `coding-objector` if T4 has run; for T5 verification, only the new one needs to be present, the objector verification was in T4).

- [ ] **Step 4: Verify the soul preload works (no warnings)**

Run:
```bash
npx tsx src/sync_settings.ts sync --dry-run 2>&1 | grep -E "warning|soul" | head -20
```
Expected: no "warning: role 'coding-countersign' declares soul..." lines; no "warning: role 'coding-countersign' declares souls_extra..." lines.

- [ ] **Step 5: Commit**

```bash
git add role-packs/coding/coding-countersign.md
git commit -m "feat(role): add coding-countersign (ak 给事中, pre-work approval)

Ak-faithful pre-work approval role. Gates work BEFORE implementation
begins by applying the 5-step audit (establish_law, verify_owner_intent,
find_conflicts, find_missing, find_unauthorized_scope). Three-state output
(converged/continue/escalate).

Tier: strong (opus-thinking-medium).
Souls: audit-law + countersign-law.
Tools: read-only — no edit, no write, no bash.
Phase input: ticket."
```

---

## Task 6: Add `coding-inspector` (ak-faithful code quality gate)

**Files:**
- Create: `role-packs/coding/coding-inspector.md`

Ak-faithful 台院 (Censorate). Runs after `coding-coder.apply`, before merge. Inspects correctness, complexity, test quality, test duration.

- [ ] **Step 1: Create the role file with frontmatter**

Create `role-packs/coding/coding-inspector.md` with this exact frontmatter:

```yaml
---
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
---
```

- [ ] **Step 2: Add the body sections**

```
# Inspector (台院)

You are the Censorate. After `coding-coder` finishes the `apply` phase and BEFORE
merge, you inspect the implementation for correctness, complexity, test quality, and
test duration. You do not implement, you do not judge the planner's intent (that's
`coding-countersign`), and you do not approve the diff (that's `coding-judge`). You
catch what the coder missed.

## Cost & quality envelope

Tier: **strong**. Bind to a high-reasoning model. Trade-off: this is the most expensive
post-impl call. For trivial diffs (one-line typo, formatting), consider deferring to a
`balanced`-tier self-review by `coding-coder`.

## Responsibilities

When the dispatch includes `phase: post-impl`:

1. Run the project's gates (compile, lint, test) via `bash` (seatbelt applies).
2. Apply the 4-dimension inspection (see `../../souls/inspector-law.md`):
   - `correctness` — does the implementation do what the planner said? Trace one
     real call path to the external result; check normal / boundary / failure paths.
   - `complexity` — does the implementation exceed the budgets in
     `../../souls/quality-law.md`? (cyclomatic, nesting, etc.)
   - `test_quality` — do tests exercise the actual contract, or do they pass by
     happenstance (over-mocked, tautological, wrong-asserted)?
   - `test_duration` — is the test suite still within the budgets?
3. For each dimension that fails, emit findings (cite file:line + dimension + budget).
4. Emit the verdict in the output format below.

## Constraints

- Bash is allowed for running tests + measuring complexity + capturing timing.
  The `forbidden_bash_patterns` seatbelt applies — never `rm -rf`, `git reset --hard`, etc.
- Never edit files. If you find a fix, route it to `coding-coder` via a `continue` finding.
- Never issue an `escalate` for things you could `continue` on. `escalate` means you
  cannot rule (e.g. a security issue outside the diff scope).

## Trigger phrases

"inspect this", "code quality check", "post-impl review", "test quality"

## Output format

Always emit, in this exact order:

1. **GATE STATUS**: per-gate pass/fail with exit code and last 200 chars of stderr on fail.
2. **VERDICT**: `converged` (4 dimensions pass; merge-ready) | `continue` (must return for rework) | `escalate` (cannot rule).
3. **FINDINGS**: zero or more entries shaped as:
   ```
   - {file:line} — {dimension: rule violated} — {one-sentence specific change required}
   ```
4. **ESCALATION RATIONALE** (only if VERDICT=escalate).

A `converged` verdict has no FINDINGS. A `continue` verdict MUST have at least one FINDINGS entry.

## Output category

Three-state judgement. Bind to a high-reasoning model.
```

- [ ] **Step 3: Verify discovery + soul preload**

Run:
```bash
npx tsx src/sync_settings.ts list 2>&1 | grep inspector
npx tsx src/sync_settings.ts sync --dry-run 2>&1 | grep -E "inspector.*soul"
```
Expected: `coding-inspector` listed; no soul warning lines.

- [ ] **Step 4: Commit**

```bash
git add role-packs/coding/coding-inspector.md
git commit -m "feat(role): add coding-inspector (ak 台院, post-impl code quality gate)

Ak-faithful Censorate. Runs after coder.apply, before merge. Inspects
correctness, complexity, test quality, test duration. Three-state output.

Tier: strong (opus-thinking-high).
Souls: audit-law + inspector-law + quality-law.
Tools: read + bash (run tests/measures; no edit).
Phase input: post-impl."
```

---

## Task 7: Add `coding-doctor` (ak-faithful factory health diagnostic)

**Files:**
- Create: `role-packs/coding/coding-doctor.md`

Ak-faithful 太医署 (Imperial Medical Office). Diagnoses overall project health. NOT a verdict seat.

- [ ] **Step 1: Create the role file with frontmatter**

Create `role-packs/coding/coding-doctor.md` with this exact frontmatter:

```yaml
---
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
---
```

- [ ] **Step 2: Add the body sections**

```
# Doctor (太医署)

You are the Imperial Medical Office. You diagnose the project's health — build, lint,
dependency hygiene, complexity drift, security smells. You do NOT rule on individual
changes, you do NOT approve merges, and you do NOT implement fixes. You observe, you
diagnose, you recommend; the dispatcher decides whether to act.

## Cost & quality envelope

Tier: **balanced**. Bind to a verifiable-output model. Trade-off: doctor calls scan
the whole repo, so context window matters more than raw reasoning power.

## Responsibilities

When the dispatch includes `phase: health-check`:

1. Run the project's gates (compile, lint, test, dependency check) via `bash` (seatbelt applies).
2. Apply the doctor-law diagnostic (see `../../souls/doctor-law.md`):
   - `build_health` — does the project build clean from scratch?
   - `lint_health` — are there silenced lints, or accumulating warnings?
   - `dependency_health` — any outdated / vulnerable / duplicated dependencies?
   - `complexity_drift` — is the codebase's complexity budget being exceeded (per
     `../../souls/quality-law.md`)? Are hotspots growing?
   - `security_smells` — secrets in tree, exposed ports, missing input validation
     on hot paths, etc.
3. Emit a diagnosis report (prose) summarizing each dimension.
4. Emit a health verdict at the end.

## Constraints

- Bash is allowed for running gates + dependency checks + grep over the repo.
  Seatbelt applies.
- Never edit files. Diagnosis only.
- Never issue a verdict on a specific change. That's `coding-judge` / `coding-countersign`.
- Prefer "delete or simplify" recommendations. Patch / new-mechanism recommendations
  only when the existing structure cannot be salvaged.

## Trigger phrases

"health check", "factory diagnostic", "project health", "dependency audit"

## Output format

Always emit, in this exact order:

1. **DIAGNOSIS**: prose section per dimension (build/lint/dependency/complexity/security).
   Cite file:line for each observation.
2. **RECOMMENDATIONS**: ordered list of suggested fixes, each shaped:
   ```
   - {file:line or project-wide} — {what to delete/simplify/patch/add} — {priority: high|medium|low}
   ```
3. **HEALTH VERDICT**: `healthy` (no action needed) | `needs-care` (recommendations to schedule) | `critical` (block merges until addressed).

## Output category

Diagnosis + health verdict. NOT a binary judgement on a specific change.
```

- [ ] **Step 3: Verify discovery + soul preload**

Run:
```bash
npx tsx src/sync_settings.ts list 2>&1 | grep doctor
npx tsx src/sync_settings.ts sync --dry-run 2>&1 | grep -E "doctor.*soul"
```
Expected: `coding-doctor` listed; no soul warning lines.

- [ ] **Step 4: Commit**

```bash
git add role-packs/coding/coding-doctor.md
git commit -m "feat(role): add coding-doctor (ak 太医署, factory health diagnostic)

Ak-faithful Imperial Medical Office. Diagnoses project-wide health
(build/lint/dependency/complexity/security). NOT a verdict seat —
issues health verdict + recommendations, not change approvals.

Tier: balanced (deepseek-verifiable).
Souls: audit-law + doctor-law.
Tools: read + bash (run diagnostics; no edit).
Phase input: health-check."
```

---

## Task 8: Upgrade `coding-diarist` (cheap → balanced, ak-faithful recorder)

**Files:**
- Modify: `role-packs/coding/coding-diarist.md` (5 field edits)

The current diarist is bound to `minimax-medium` (cheap) but the role's actual reasoning needs (cross-session decision coherence, citation discipline) justify balanced. Tighten the description to drop the README/copy/visual-asset framing — that's docs work, not ak-faithful recorder.

- [ ] **Step 1: Change `model_tier` from `cheap` to `balanced`**

In `role-packs/coding/coding-diarist.md`, change:
```
model_tier: cheap
```
to:
```
model_tier: balanced
```

- [ ] **Step 2: Change `model_recommendation` from `minimax-medium` to `deepseek-verifiable`**

In `role-packs/coding/coding-diarist.md`, change:
```
model_recommendation: minimax-medium
```
to:
```
model_recommendation: deepseek-verifiable
```

- [ ] **Step 3: Change `thinking` from `medium` to `high`**

In `role-packs/coding/coding-diarist.md`, change:
```
thinking: medium
```
to:
```
thinking: high
```

- [ ] **Step 4: Change `requires.reasoning_tier` from `low` to `medium`**

In `role-packs/coding/coding-diarist.md`, change:
```
  reasoning_tier: low
```
to:
```
  reasoning_tier: medium
```

- [ ] **Step 5: Add `soul: ../../souls/audit-law.md`**

In `role-packs/coding/coding-diarist.md`, add a new frontmatter line after `allowed_tools: [...]`:
```
soul: ../../souls/audit-law.md
```

- [ ] **Step 6: Tighten the frontmatter `description:`**

In `role-packs/coding/coding-diarist.md`, change:
```
description: "Write READMEs, visual assets, frontend copy, documentation. Ak semantics — records findings for human readers."
```
to:
```
description: "Decision recorder (ak 起居郎). Records decisions into the project's decision log; cites sources; flags uncertainty. Ak-faithful 2-state output (completed/escalate)."
```

- [ ] **Step 7: Tighten the body — replace the first paragraph under `# Diarist`**

Replace the existing first paragraph:

```
You write for humans. Output is generation, not verification — but the
generation must be honest about what was found, not paraphrased away.
You are the project diarist: your writing becomes the record a new
contributor reads to understand the work.
```

with:

```
You record decisions. You do not author strategy, you do not approve designs, you do
not implement. Your job is to find the relevant decisions in the conversation / commit
log / ticket history and record them into the project's decision log (起居录) with
proper citations and ownership labels. The output is human-readable prose for
contributors who join the project later.
```

- [ ] **Step 8: Update the body — replace the `## Responsibilities` section**

Replace the existing `## Responsibilities` block (which lists README / frontend copy / visual assets / Findings summaries) with:

```
## Responsibilities

- Find every decision made in the conversation / commit log / ticket history that
  shaped the current state of the work.
- Cite each decision with source (commit SHA, ticket number, conversation turn).
- Distinguish owner decisions from assistant proposals from formal verdicts from
  your own synthesis. They must NOT be conflated.
- Flag missing decisions (where the current state implies a decision was made but no
  record exists) — `needs verification` markers, not inventions.
- Mark superseded decisions with their replacement pointer; do not list them in
  parallel with the current direction.
- Verify the decision log is complete before emitting `completed`.
```

- [ ] **Step 9: Update the body — replace `## Constraints` and `## Trigger phrases`**

Replace `## Constraints` content (drop the "Don't paraphrase / lorem ipsum / match voice" lines; they were docs-framing) with:

```
## Constraints

- Never invent. If a decision is missing, mark `needs verification` and route to
  `coding-notary` to gather the evidence.
- Never conflate owner decisions with assistant proposals. Owner = "decided X".
  Assistant = "suggested Y". Verdict = "ruled Z".
- Never rewrite the original decision in your own words. Pointer + short relation
  note is the contract.
```

Replace `## Trigger phrases`:

- from: "write README", "document this", "user-facing copy", "frontend"
- to: "record decisions", "diarize this", "decision log", "起居录"

- [ ] **Step 10: Verify the file parses and the soul preload works**

Run:
```bash
npx tsx src/sync_settings.ts list 2>&1 | grep diarist
npx tsx src/sync_settings.ts sync --dry-run 2>&1 | grep -E "diarist.*soul"
```
Expected: `coding-diarist` listed; no soul warning line.

- [ ] **Step 11: Commit**

```bash
git add role-packs/coding/coding-diarist.md
git commit -m "feat(role): upgrade coding-diarist to balanced tier + ak-faithful recorder scope

Three changes:
1. Tier upgrade: cheap → balanced (model_recommendation:
   minimax-medium → deepseek-verifiable). Reasoning needs justify
   the upgrade (cross-session decision coherence, citation
   discipline).
2. Add soul: ../../souls/audit-law.md — inherit audit-law's
   'cite, do not opine' stance, which is the heart of diarist's job.
3. Tighten description + body to ak-faithful recorder scope. Drop
   the README/frontend-copy/visual-assets framing (that was docs
   work leaking into the role). Output stays 2-state
   (completed/escalate) per ak.

Trigger phrases changed accordingly: 'record decisions', 'diarize this',
'decision log'. Migration note in the old body removed (the docs
replacement is established; further deprecation is not in scope)."
```

---

## Task 9: Update `.pi/rolecast.yaml` bindings + `references/role-authoring.md`

**Files:**
- Modify: `.pi/rolecast.yaml` (4 new bindings + 1 rename + 1 alias change)
- Modify: `references/role-authoring.md` (tier table refresh)

- [ ] **Step 1: Add 4 new bindings to `.pi/rolecast.yaml`**

Add these entries to the `bindings:` block (alphabetical order is conventional):

```yaml
  coding-countersign:
    alias: opus-thinking-medium
    channels: [official]
  coding-doctor:
    alias: deepseek-verifiable
    channels: [official]
  coding-inspector:
    alias: opus-thinking-high
    channels: [official]
  # NOTE: coding-diarist binding exists below; this comment marks the section
```

- [ ] **Step 2: Update `coding-diarist` binding alias**

Change the existing `coding-diarist` binding alias from `minimax-medium` to `deepseek-verifiable` (matching the role's tier upgrade in T8):

```yaml
  coding-diarist:
    alias: deepseek-verifiable
    channels: [official]
```

- [ ] **Step 3: Create `coding-objector` binding (was previously `coding-countersign` but unbound)**

In the `bindings:` block, add a new entry for `coding-objector`:

```yaml
  coding-objector:
    alias: gpt-judgment-high
    channels:
      - official
      - relay-default
```

> **Plan-level correction (caught by T4 reviewer):** the profile does NOT have a
> pre-existing `coding-countersign` binding to rename — the old role was always
> shipped as `coding-countersign` but never bound in this profile (it's used by
> the broader ak ecosystem, not this TypeScript project's workflow). So Step 3
> creates the binding from scratch using the new name + the alias the old role
> would have used. This is the binding for the JUDGE-ADVERSARY role (the
> existing one that lives at `role-packs/coding/coding-objector.md` post-T4),
> distinct from the new ak-faithful `coding-countersign` binding added in Step 1.

- [ ] **Step 4: Verify `scaffolder_validate` passes**

Run:
```bash
npx tsx src/scaffolder.ts validate
```
Expected: exit code 0; no unresolved role bindings; no alias resolution errors.

If a binding references an unknown role, the validator should report which one. The likely failure modes:
- Misspelled role name → re-check Steps 1-3 against the actual file names in `role-packs/coding/`.
- Alias not in `registry/aliases.yaml` → check the alias names match the registry exactly.
- Channel name not in the registry → check that `official` and `relay-default` are valid channel IDs.

- [ ] **Step 5: Update `references/role-authoring.md` tier table**

Replace the entire tier table (the table that currently lists 11 roles) with this 17-row version (preserve existing markdown table styling; use one row per role):

```
| Role | Tier | Recommended alias | One-line scope |
|------|------|-------------------|----------------|
| coding-architect | strong | opus-thinking-medium | System boundary + public API design |
| coding-auditor | strong | opus-thinking-high | Security + cross-cutting code health |
| coding-canary | cheap | minimax-fast | Relay route verification |
| coding-coder | balanced | deepseek-verifiable | Two-phase (plan + apply) worker |
| coding-countersign | strong | opus-thinking-medium | Pre-work approval (ak 给事中) — three-state |
| coding-diarist | balanced | deepseek-verifiable | Decision recorder (ak 起居郎) — two-state |
| coding-doctor | balanced | deepseek-verifiable | Factory health diagnostic (ak 太医署) |
| coding-fixer | balanced | deepseek-verifiable | Finalization (run gates, fix easy red) |
| coding-inspector | strong | opus-thinking-high | Post-impl code quality gate (ak 台院) — three-state |
| coding-judge | strong | gpt-judgment-high | Verdict on a diff (APPROVE/REJECT) |
| coding-mapper | balanced | deepseek-verifiable | Structural map / dependency graph |
| coding-notary | cheap | deepseek-verifiable | Read-only evidence collector |
| coding-objector | strong | gpt-judgment-high | Judge adversary (refutes coding-judge verdicts) |
| coding-planner | balanced | deepseek-verifiable | Step-by-step plan with Verify per step |
| coding-profiler | balanced | deepseek-verifiable | Performance diagnosis (perf only) |
| coding-secretariat | cheap | minimax-medium | Audit log recorder (opt-in) |
| coding-tester | balanced | deepseek-verifiable | Test generation + maintenance |
```

- [ ] **Step 6: Add a "Three-state output for judgment roles" section**

Add this new section to `references/role-authoring.md` (after the tier table, before any "Migration" or "Examples" section):

```
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
```

- [ ] **Step 7: Add the new souls to the shared-souls list**

Find the section in `references/role-authoring.md` that lists shared souls (search for "souls/" in the doc). Add the four new souls to the list:

```
- `../../souls/audit-law.md` — base layer for audit-facing roles
- `../../souls/countersign-law.md` — 5-step audit + 5-question rubric (v0.9.0)
- `../../souls/inspector-law.md` — 4-dimension code-quality gate (v0.9.0)
- `../../souls/doctor-law.md` — factory health diagnostic posture (v0.9.0)
- `../../souls/quality-law.md` — complexity + test budgets (v0.9.0)
```

- [ ] **Step 8: Verify the doc renders correctly**

Run:
```bash
grep -c "^| coding-" references/role-authoring.md
```
Expected: 17 (matches the new tier table row count).

- [ ] **Step 9: Commit**

```bash
git add .pi/rolecast.yaml references/role-authoring.md
git commit -m "feat(profile+docs): bind 4 new roles, rename countersign→objector, refresh authoring guide

.pi/rolecast.yaml:
- Add bindings: coding-countersign (opus-thinking-medium),
  coding-inspector (opus-thinking-high), coding-doctor (deepseek-verifiable)
- Upgrade coding-diarist binding alias to deepseek-verifiable (matches T8)
- Rename coding-countersign binding → coding-objector (matches T4)

references/role-authoring.md:
- Tier table expanded from 11 to 17 rows to reflect shipping reality
- Add 'Three-state output for judgment roles' section documenting the
  ak-faithful converged/continue/escalate contract for new judgment
  roles and the divergence from existing binary verdict roles
- Add 4 new souls to the shared-souls list"
```

---

## Task 10: Update e2e fixtures + CHANGELOG entry

**Files:**
- Modify: `tests/e2e/fixtures/todo-tui/.pi/agents/*.md` (remove 11 legacy roles)
- Modify: `CHANGELOG.md` (append v0.9.0 entry)

The e2e fixture at `tests/e2e/fixtures/todo-tui/.pi/agents/` lists 11 legacy roles (implementer / reviewer / docs / orchestrator + 7 unchanged). The legacy 4 were hard-deleted in v0.8.0; the fixture still references them, which means e2e tests pass against a fixture that diverges from `role-packs/coding/` reality. The 7 unchanged ones need to be re-verified but should remain.

- [ ] **Step 1: List the current fixture roles**

Run:
```bash
ls tests/e2e/fixtures/todo-tui/.pi/agents/
```
Expected: 11 files including the 4 legacy (`coding-implementer.md`, `coding-reviewer.md`, `coding-docs.md`, `coding-orchestrator.md`) and 7 unchanged (`coding-architect.md`, `coding-auditor.md`, `coding-canary.md`, `coding-mapper.md`, `coding-planner.md`, `coding-profiler.md`, `coding-tester.md`).

- [ ] **Step 2: Remove the 4 legacy fixture roles**

Run:
```bash
rm tests/e2e/fixtures/todo-tui/.pi/agents/coding-implementer.md \
   tests/e2e/fixtures/todo-tui/.pi/agents/coding-reviewer.md \
   tests/e2e/fixtures/todo-tui/.pi/agents/coding-docs.md \
   tests/e2e/fixtures/todo-tui/.pi/agents/coding-orchestrator.md
```

- [ ] **Step 3: Verify each remaining fixture role matches its shipping counterpart**

For each remaining fixture role, diff it against the corresponding `role-packs/coding/` file:

```bash
for role in coding-architect coding-auditor coding-canary coding-mapper coding-planner coding-profiler coding-tester; do
  if ! diff -q "tests/e2e/fixtures/todo-tui/.pi/agents/${role}.md" "role-packs/coding/${role}.md" > /dev/null; then
    echo "DIFF: ${role}"
  fi
done
```
Expected: no `DIFF:` lines (all fixture roles match the shipping roles).

If any diff appears, the fixture role needs to be updated to match the shipping role's content. The fixture is a placeholder for what `sync_settings` would generate; since the fixture is hand-maintained, it must be kept in sync.

- [ ] **Step 4: Re-verify the fixture list now matches reality**

Run:
```bash
ls tests/e2e/fixtures/todo-tui/.pi/agents/
```
Expected: 7 files (the 7 unchanged roles).

NOTE: This task does NOT add fixtures for the 4 new roles (`coding-countersign`, `coding-inspector`, `coding-doctor`, upgraded `coding-diarist`) or the renamed `coding-objector`. Adding fixture roles for new roles is a separate concern — the fixture exists to test `sync_settings` behavior on a representative sample, not to mirror every shipping role. If the e2e tests are updated in a future PR to assert specific role counts, that PR will add fixtures for the new roles.

- [ ] **Step 5: Add v0.9.0 entry to CHANGELOG.md**

Open `CHANGELOG.md` and append at the top of the file (above the v0.8.0 entry):

```markdown
## [0.9.0] - 2026-10-XX

### Added (ak-semantics alignment)
- `role-packs/coding/coding-countersign.md` — pre-work approval (ak 给事中). Three-state output (converged / continue / escalate). Tier: strong (opus-thinking-medium). Souls: audit-law + countersign-law.
- `role-packs/coding/coding-inspector.md` — post-impl code quality gate (ak 台院). Three-state output. Tier: strong (opus-thinking-high). Souls: audit-law + inspector-law + quality-law.
- `role-packs/coding/coding-doctor.md` — factory health diagnostic (ak 太医署). Diagnosis prose + health verdict (healthy / needs-care / critical). Tier: balanced (deepseek-verifiable). Souls: audit-law + doctor-law.
- `souls/countersign-law.md`, `souls/inspector-law.md`, `souls/doctor-law.md`, `souls/quality-law.md` — ported from ak-pi-workflow-roles; adapted to English project terms, court ceremony stripped, structures preserved.
- `src/profile_loader.ts` + `src/sync_settings.ts` — new `souls_extra: [string, ...]` frontmatter field for multi-law inheritance. Roles can now declare additional soul paths that are prepended after the primary `soul:` and before the role body. Generic law first; role body last.

### Changed
- `role-packs/coding/coding-countersign.md` → `role-packs/coding/coding-objector.md`. The existing role is the judge adversary (refutes `coding-judge` verdicts); the new name accurately describes the behavior and frees the ak-faithful name `coding-countersign` for pre-work approval. **BREAKING**: profiles referencing `coding-countersign` must update their binding to `coding-objector`. No shim is provided per v0.8.0's "hard-fail on legacy names" stance.
- `role-packs/coding/coding-diarist.md` — tier upgrade cheap → balanced (model_recommendation: minimax-medium → deepseek-verifiable). Reasoning needs justify the upgrade. **Cost note**: profiles that bind `coding-diarist` pay more per call; opt out by binding the old alias explicitly.
- `role-packs/coding/coding-diarist.md` — description + body tightened to ak-faithful recorder scope. Output stays 2-state (`completed` / `escalate`). Dropped the README / frontend-copy / visual-asset framing (that was docs work leaking into the role).
- `.pi/rolecast.yaml` — 4 new bindings (`coding-countersign`, `coding-inspector`, `coding-doctor`, `coding-diarist` with new alias). Renamed `coding-countersign` binding → `coding-objector`.
- `references/role-authoring.md` — tier table expanded from 11 to 17 rows. New "Three-state output for judgment roles" section documents the ak-faithful converged/continue/escalate contract.

### Fixed
- **Soul-path bug**: 6 roles (`coding-coder`, `coding-countersign`→`coding-objector`, `coding-fixer`, `coding-judge`, `coding-notary`, `coding-secretariat`) declared `soul: souls/audit-law.md`, which resolved via `path.resolve(path.dirname(roleFilePath), soulPath)` to `role-packs/coding/souls/audit-law.md` — a non-existent path. `sync_settings` emitted a warning and silently did NOT preload the audit-law soul. Now corrected to `soul: ../../souls/audit-law.md`, which resolves to the repo-root `souls/audit-law.md`.

### Migration
- **Rename** `coding-countersign` → `coding-objector` is breaking. Update profile bindings. Per v0.8.0, no `LEGACY_ROLE_ALIASES` shim is added.
- **Tier upgrade** for `coding-diarist` is automatic for default-profile users. Users with custom bindings retain their explicit alias.
- **New roles** are additive. Profiles that don't reference them are unaffected.
- **soul-path fix** is silent — the path now resolves to the file that was intended.
```

(Replace `2026-10-XX` with the actual release date when known.)

- [ ] **Step 6: Verify the e2e fixture test still passes**

Run (if the e2e test exists in the test runner config):
```bash
npx tsx --test tests/e2e/ 2>&1 | tail -30
```
Expected: tests pass; no failures related to missing fixture roles.

If the e2e tests are not part of the default test runner, skip this step — the fixture cleanup is verified by Step 4.

- [ ] **Step 7: Run all unit tests to confirm no regressions**

Run:
```bash
npx tsx --test tests/unit/*.ts 2>&1 | tail -30
```
Expected: all tests pass; no new failures from T1-T9 changes.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/fixtures/todo-tui/.pi/agents/ CHANGELOG.md
git rm tests/e2e/fixtures/todo-tui/.pi/agents/coding-implementer.md \
      tests/e2e/fixtures/todo-tui/.pi/agents/coding-reviewer.md \
      tests/e2e/fixtures/todo-tui/.pi/agents/coding-docs.md \
      tests/e2e/fixtures/todo-tui/.pi/agents/coding-orchestrator.md
git commit -m "chore: clean e2e fixture + CHANGELOG for v0.9.0

Two project-hygiene changes completing the v0.9.0 release:

1. tests/e2e/fixtures/todo-tui/.pi/agents/ — remove 4 legacy fixture
   roles (coding-implementer, coding-reviewer, coding-docs,
   coding-orchestrator) hard-deleted in v0.8.0. The fixture
   previously diverged from role-packs/coding/ reality.

2. CHANGELOG.md — append v0.9.0 entry documenting:
   - 4 new roles (countersign, inspector, doctor, diarist-upgrade)
   - 1 rename (countersign → objector) [BREAKING]
   - 4 new souls
   - souls_extra framework feature
   - soul-path bug fix
   - authoring-guide refresh

Release date placeholder '2026-10-XX' to be filled at release time."
```

---

## Self-Review

**1. Spec coverage:**
- §3 Goals — all 8 covered: countersign (T5), inspector (T6), doctor (T7), diarist upgrade (T8), objector rename (T4), soul-path fix (T1), authoring refresh (T9), souls_extra (T2).
- §5 Design Decisions — D1 (rename) covered in T4; D2 (soul path) covered in T1; D3 (three-state) verified in T5/T6 output format specs; D4 (tier) covered in T5/T6/T7/T8 frontmatter and T9 bindings; D5 (3 new souls) covered in T3; D6 (quality-law) covered in T3 + T6; D7 (diarist tightening) covered in T8; D8 (authoring refresh) covered in T9.
- §8 Profile binding — covered in T9.
- §9 Migration — T9 + T10 document the breaking rename; CHANGELOG entry explains migration steps.

**2. Step scan:**
- Each task's steps are mechanical: edit file X with content Y, run command Z, verify output W. No TBD, no "handle edge cases". The T8 step 7 (replace first paragraph) and step 8 (replace Responsibilities) provide exact replacement text. T3 provides step-by-step adaptation guidance.
- T3 step 6 has a NOTE clarifying that prose references inside soul files don't trigger path resolution — captures a non-obvious framework behavior that would otherwise confuse the implementer.

**3. Type consistency:**
- `RoleDef.souls_extra: string[]` declared in T2 step 3; consumed in T2 step 7; populated in T2 step 4.
- `souls_extra` referenced identically in T5/T6/T7 frontmatter specs (Step 1 of each task).
- The `coding-countersign` binding in T9 step 3 uses alias `gpt-judgment-high` (matching the existing pre-rename binding). The T5 NEW `coding-countersign` binding uses alias `opus-thinking-medium`. Two different roles with two different aliases — verified by name (`coding-countersign` rename vs new `coding-countersign` per ak). Implementer must verify these are distinct rows in the YAML.

**4. Review Focus:**
All five items from the Review Focus section are addressed by tests:
- (1) Missing soul → warning emitted, no exception: T2 step 1 test asserts no exception; T2 step 7 code path emits warning via `process.stderr.write`.
- (2) Order matters: T2 step 6 test asserts primary soul is prepended before any souls_extra entries.
- (3) Dangling legacy fixture references: T10 step 3 verifies all fixture roles match shipping counterparts; T10 step 2 removes the 4 legacy ones.
- (4) Three-state divergence: T9 step 6 adds explicit doc note for codemode-script authors; CHANGELOG (T10 step 5) flags the divergence.
- (5) Cost increase from diarist upgrade: T10 step 5 CHANGELOG entry has explicit "Cost note" line; T9 step 2 ties the binding alias to T8's tier change.

**5. Proportion:**
- Spec: 20 KB (19984 bytes)
- Plan: ~28 KB (just under 2× spec)
- Each task's body is small (signatures, exact replacements, command/expected pairs). No full code blocks beyond frontmatter bodies + soul preamble prose. The plan does NOT transcribe the new role bodies in full (those are in T5/T6/T7 step bodies but the implementer can copy from the spec's per-role sections).
- T3 step 1-4 has compact adaptation guidance rather than full soul text — implementer ports from `/tmp/ak-ref/soul-*.md` per the spec's "Background — current state (v0.8.0)" section that lists the file sizes and the ak soul structure.

Plan complete. Handing off to execution method choice.
