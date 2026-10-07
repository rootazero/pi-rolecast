# Quality Law (complexity + test budgets)

## Complexity is cost

Before the work begins, check the ticket and the task for illegal /
unauthorized scope. If the facts do not hold or the design needs
authorization that is missing, refuse with verifiable evidence; do
not guess.

What can be solved by deleting, merging, or modifying an existing
mechanism must not be solved by adding a new one. A single business
rule must have only one authoritative implementation; the code, tests,
and compatibility paths it replaces are removed with the change.

Before adding a new one, answer the three questions: how probable, how
severe the failure, whether downstream already detects or recovers.
If you cannot answer, or downstream recovery is already sufficient,
do not add. When the same spot only grows and never shrinks, stop
patching; investigate the root cause.

Priority order: passes tests → shows intent → no duplication →
fewest elements.

Don't reinvent what's already in reach. The project itself, the
language standard library, and the package ecosystem all have
existing pieces — writing your own when one exists is a complexity
defect. New general-purpose implementations (serialization, retry,
locks, diff, path handling, etc.) must answer what was searched in
each of these three places and why none is used; failing to answer
blocks the change.

## Don't reinvent; search first (owner 2026-09-20)

> Direct quote: "When you're thinking about how to implement
> something — search the internet more, think about simpler ways,
> don't just keep adding things, adding a pile of bad mechanisms,
> and then burning my tokens to delete them!"
> Source pointer: project-local conversation log; record the
> relevant tool call id / message ref in your rationale.

Before drafting one, search the internet — confirm this is a known
problem and whether there is an existing solution in the ecosystem
(official docs first). Then ask what the simplest approach is —
including "change the prior choice" instead of "patch the prior
choice".

Self-authored mechanisms are the last resort. When the same spot only
grows and never shrinks, investigate the root cause; do not
recover by stacking another layer.

## Tests are responsible to behavior

Tests guarantee **only** the shortest deterministic case that
"the right input produces the right output": enter through the real
entry, assert on the externally visible structured result, complete
in seconds. Behavior that touches real host systems, real LLMs, real
concurrency, real networks — do not write tests; rely on real runs
as evidence.

The proof of a fix is **mutation real-run**: install the old logic
back, real entry reports red in seconds; restore, reports green.
The command + result goes into the receipt: pointer (runId /
toolCallId) or quoted conclusion, both qualify; what matters is the
reader can check. Do not write a test just to prove the fix; tests that
were torn down for proof must not be reshaped and recreated.

Tests serve the spec; do not compromise tests to serve the
implementation: do not loosen assertions, delete failure paths, or mock
the behavior under test to make tests green.

Never lock on generated artifacts: do not build mechanical
dependencies on free-form text, LLM outputs, image pixels, or any
generated output — locking wording, locking sentence form, locking
templates, counting tokens, embedding sentinels, comparing pixels,
all count. Contract assertions land only on structured fields;
generated artifacts can be observed as characteristics, cannot be
constrained.

When an existing test already expresses real behavior, modify or
reuse it; do not create a parallel test. Tests that only lock
internal structure, non-contract text, repeated conclusions, dead
behavior, or mere coverage should be deleted.

Both production code and test code count toward complexity. Any new
test must demonstrate that it provides necessary value the existing
suite does not.

## Test sizing

Size by size, not by nominal category. Small: single process,
single module, no external resources, seconds. Medium: within a
single host, may cross processes, may touch host resources. Large:
full system real link. Behavioral proof lives at the smallest size
that suffices; large is only kept for behavior medium / small cannot
prove.

Name and reality must match: a test taking the small name but
consuming large resources is treated as a category-mismatch defect.
Heavy-list entries are listed separately, scheduled serially, each
entry admitted with a reason.

Daily work only runs focused-range tests in the touched area; full
suite green only runs once at the **final merge-ready state** of a
family or batch — per-leg delivery on the family lane is not
finishing, must not be used to demand full suite; subsequent fixes
re-run the full suite at the new final state.

There is only one **final merge-ready state**: the HEAD after all
rounds of this ticket or family end, in order after the judge's
`converged` and the PR is opened, just before merging into the
target branch; CI passing on it once is the full suite. After that,
if more fix commits come, the new HEAD is the new final state.
Internal monitors / fix-trackers' every (including in-gate resubmit),
slice rounds, fix rounds, and inspector intermediate rounds are
not final states — inspector must not demand full suite on them,
nor may a ticket put "host full suite" into the acceptance of those
rounds.

## Unfinished delivery

`unfinished` admits only two causes:
- **Missing prerequisite** — the work as of now lacks a declared
  prerequisite artifact, decision, or response, and that missing
  thing makes the remaining dispatch currently un-executable in
  law.
- **Unconstitutional constraint** — continuing the work would
  violate authority or already-ruled law.

Reasons outside these two (execution window, time, workload,
difficulty, etc.) are not grounds for `unfinished`; inspector
returns `continue` against any of them.

Honest two-cause delivery is not itself a violation, but does not
auto-`converged`; the claimed block must be independently
re-checkable from the dossier; the claim + citation itself does not
prove missing or causation.

## Warning reference lines

Trigger lines for the inspector, judged by the inspector themselves,
not mechanical gates. Over the line is not automatically a fault,
but requires dedicated review + a from-the-party explanation:

- Full test suite wall-clock reference: 120 seconds (host has its
  own explicit ceiling if documented); single-file time over 10%
  of full suite, same requires review.
- Unit tests run fast; what runs slow is not a unit test — a unit
  test over 0.1 seconds counts as slow. Build + test, this
  project's lane: 180 seconds (industry legacy lanes of ten
  minutes are for big projects) — every minute shaved is a minute
  saved on every delivery, every leg. Imbalanced test-time ratio
  means ask-three-questions before running: should it run? is
  the duration reasonable? is non-full-suite enough?
- Single-delivery change of 200-400 lines is recommended (production
  + test; pure deletion + mechanical rename do not count) — defect
  detection sweet-spot is here; over 400 drops sharply. Exceeding
  must each prove necessary value, or explain why it cannot be
  split.
- Same spot in the codebase repeatedly revised in the short term;
  rework ratio consistently over ~1/4: system-illness, investigate
  the root cause.

> Standalone law; no parent inheritance.
