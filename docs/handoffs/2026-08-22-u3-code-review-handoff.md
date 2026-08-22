# U3 is implemented and verified; the code-review gate is the only thing left

Written 2026-08-22. The work is done and committed. What remains is one command.

## Run this first

    cd ~/Coding\ Projects/porchfest
    # then invoke the skill:
    ce-code-review mode:agent base:7d40d23 \
      plan:2026-08-20-0830-feat-porchfest-platform-plan.md  # porchfest platform plan in its own worktree

Pass this structure pin into the invocation, because a reviewer optimizing for
tidiness will propose exactly the change that breaks the guarantee:

> The compare-and-swap guard must stay INSIDE the UPDATE statement with its verdict
> taken from the affected-row count. KTD7 records that a SELECT-compare-write version
> of this guard passed a 234-test suite twice while being wrong. Treat a finding that
> would restructure it as out of scope — but report a genuine defect IN the guard at
> full strength.

The previous session stopped here on context budget, not on a problem. The review
was never started, so there is no partial state to reconcile.

## State

Branch `feat/u3-schema` in `~/Coding Projects/porchfest`, four commits on `7d40d23`:

- `fac9152` season-scoped schema, 7 tables, committed migration, CHECK constraints
- `f1c283c` record lifecycle: CAS, placeholder promotion, supersession, email_log
- `2cd5b5d` season state machine, slot holds, season scoping
- `a4a5a6d` simplify pass: shared errors, test-db helper, drift test, two indexes

Gates green at `a4a5a6d`: `npm run typecheck`, `npm run lint`, `npm test`
(18 tests in packages/core, all against real SQLite files). The ce-work controller
recorded `RUN_VERIFIED` for run `u3-7d40d23`.

## Two residuals to carry into the review, not re-litigate

Both were raised by the simplify reviewers and REFUSED deliberately, because each
would restructure the pinned version guard:

1. Consolidating the per-entity CAS/CRUD functions (updateAct/updateVenue/
   updateContact, the supersede trio, the resolve trio) into a generic
   table-parameterized helper. Two reviewers flagged it at low confidence and both
   called it a deliberate follow-up rather than a drive-by change.
2. Swapping `.changes` for `.returning()` on the guarded UPDATEs. The proposer
   explicitly said it needed a second look before being applied.

If code review raises either again, that is corroboration worth weighing — but it
is a deliberate follow-up, not an oversight.

## Judgment calls made during U3 that a reviewer should check

- **A scaffold defect was fixed in passing.** `.gitignore` had `drizzle/` with no
  leading slash, matching at any depth, so it swallowed `packages/core/drizzle/` —
  the plan's own migration path — and the Dockerfile runs no generate step. The
  migration could never have shipped. Narrowed to `/drizzle/`, and drizzle-kit now
  writes to `packages/core/drizzle`. Verify that is the right home for migrations.
- **`email_log` was added beyond U3's stated files.** AE7 ("promotion preserves
  email history") is a U3 acceptance example and Definition of Done requires every
  AE to have a passing test, but email tables belong to U7. The minimal table makes
  AE7 provable instead of aspirational. Confirm the shape suits U7.
- **Policy pairs the plan left open** are documented at the top of `season.ts`:
  assignment also legal in signups_closed and assigning; holds legal setup through
  assigning; correction and hold release legal in every non-archived state;
  transitions forward-only. Two independent workers chose the same set. The plan
  fixes only three pairs; these are the invented ones and deserve a look.

## After the review

Findings followup, then the residual gate, then shipping. Nothing has been pushed.
`main` is at `7d40d23`.
