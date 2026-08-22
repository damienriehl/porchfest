---
module: packages/core
date: 2026-08-22
problem_type: convention
component: testing_framework
severity: high
related_components:
  - data_model
  - database
tags:
  - mutation-testing
  - optimistic-concurrency
  - silent-failure
  - test-coverage-gap
  - compare-and-swap
  - acceptance-criteria
applies_when: "Writing or reviewing tests for a guard whose failure mode is silent -- it returns success (or a no-op) instead of raising when the precondition it exists to protect is violated (e.g. CAS version predicates in UPDATE ... WHERE clauses)."
related:
  - "woodshed: docs/solutions/logic-errors/timestamp-cas-needs-millisecond-tokens-and-sql-enforcement.md"
---

# A green suite is not evidence that a silent-failure guard is tested

## Context

The porchfest platform's KTD7 records how optimistic concurrency must be built: the
compare-and-swap guard lives *inside* the UPDATE statement, the same statement
increments `version`, and the verdict comes from the affected-row count. KTD7 carries
its own warning, quoted in `docs/handoffs/2026-08-22-u3-code-review-handoff.md:15-19`:

> The compare-and-swap guard must stay INSIDE the UPDATE statement with its verdict
> taken from the affected-row count. KTD7 records that a SELECT-compare-write version
> of this guard passed a 234-test suite twice while being wrong.

Unit U3 took that seriously. Its tests open real SQLite files
(`packages/core/test/support/db.ts`), pin the clock so a winning and a losing write
stamp the identical timestamp (`packages/core/test/records.test.ts` — `pinnedNow` injected as the repository's `now`), and assert observable behaviour rather
than scanning source for the right SQL. The suite was green.

A code review then found four compare-and-swap guards with **zero effective coverage**:

- `updateVenue` — `packages/core/src/records.ts:135-152`
- `updateContact` — `packages/core/src/records.ts:154-171`
- `holdSlot` — `packages/core/src/season.ts`
- `releaseSlotHold` — `packages/core/src/season.ts`

Deleting the version predicate from any one of their WHERE clauses left the entire
suite passing. Each guard could be silently removed and nothing would notice.

The lesson is not "we forgot a test." It is that the rule KTD7 gave us — *test
behaviour against a real database, do not scan source* — was **necessary but not
sufficient**. It was followed exactly, and four guards were still unwatched.

### How it was missed (session history)

Reconstructing the build sessions explains the shape of the gap, and it is not
carelessness — it is a rule that propagated without its test.

- U3 was built as sequential packets. The packet that introduced the first guard
  (`records.ts`) got a genuine red-then-green verification: the test was written first
  and observed failing before the guard existed. That guard is `updateAct` — the one
  that turned out to be covered. (session history)
- The next packet, which added `season.ts`, carried an explicit instruction: *reuse the
  first packet's CAS guard, do not write a second concurrency mechanism.* The
  **implementation** pattern was deliberately propagated. Nothing said to propagate the
  **test** alongside it. (session history)
- The closing check across the whole unit was a source-pattern scan -- confirming that
  every guarded UPDATE still incremented in-statement and that none had switched to
  `.returning()`. That is the "scan source" mode KTD7 was written to distrust, applied
  at the exact point where it mattered most: after a refactor, across multiple entities.
  (session history)
- No mutation check was attempted or discussed at any point during the build. (session
  history)
- Most striking: the simplify-pass reviewers **refused** to consolidate the CAS trio
  into a generic helper, on the stated grounds that it was "the single change most
  likely to quietly restructure the version guard while every test stays green." The
  fragility of a guard under a green suite was understood. That understanding was never
  turned inward to ask whether each guard had a test that could go red at all. (session
  history)

So the rule to draw is narrower and more actionable than "write more tests": **when you
propagate a guard pattern to a new call site, propagate its mutation-verified test in the
same change.** A pattern is not a unit of coverage. Each guard is its own mutation target.


## Guidance

**For any guard whose failure mode is silent, the acceptance criterion is a mutation
test, not a green suite.** Before you call a guard covered: break it, watch a
*specific named test* fail, restore it, watch that test pass. If no named test fails,
the guard is not tested — regardless of how many behavioural tests exercise the code
path around it.

The guard shape in this repo (`packages/core/src/records.ts:135-152`) is:

```ts
function updateVenue(id: number, expectedVersion: number, changes: VenueChanges): Venue {
  const fields = Object.keys(changes);
  const result = db
    .update(venues)
    .set({ ...changes, version: sql`${venues.version} + 1`, updatedAt: now() })
    .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))  // <- the guard
    .run();
  if (result.changes !== 1) conflict("venue", id, fields);              // <- the verdict
  return getVenue(id);
}
```

The matching stale-version test (`packages/core/test/records.test.ts:69-104`) does one
successful write, then a second write against the now-stale version, and asserts three
things — the error type, the *named* conflicting field, and the stored row:

```ts
const winner = records.updateVenue(venue.id, venue.version, { notes: "Winner notes" });
expect(winner.version).toBe(venue.version + 1);

expect(() => records.updateVenue(venue.id, venue.version, { notes: "Stale notes" }))
  .toThrowError(RecordConflictError);
expect(() => records.updateVenue(venue.id, venue.version, { notes: "Stale notes" }))
  .toThrowError(`venue ${venue.id} conflict: notes`);

expect(sqlite.prepare("select notes, version, updated_at from venues where id = ?").get(venue.id))
  .toEqual({ notes: "Winner notes", version: venue.version + 1,
             updated_at: Math.floor(pinnedNow.getTime() / 1000) });
```

Three details are load-bearing:

1. **Assert on the conflicting *field name*, not just the error class.**
   `RepositoryConflictError` defaults `conflictingFields` to `["version"]` when the
   caller passes none (`packages/core/src/storage/repository-errors.ts:16`), so a test
   that only checks the class will still pass if the field plumbing rots.
2. **Re-read the row afterward.** The losing write must leave the winner's value and
   `version + 1` intact. Without this, a guard that throws *and* writes still passes.
3. **Pin the clock.** Both writes stamp the same `updatedAt`, so a timestamp difference
   can never be what makes the test pass.

The season tests use a second, equally valid shape — simulate the concurrent writer
directly instead of racing through the API
(`packages/core/test/season.test.ts`, the two stale-slot-version cases):

```ts
sqlite.prepare("update slots set version = version + 1 where id = ?").run(slot.id);
const before = sqlite.prepare("select state, held_decide_by, held_for_name, " +
  "fallback_venue_id, version from slots where id = ?").get(slot.id);

let thrown: unknown;
try { seasonRepository.holdSlot(slot.id, slot.version, { /* stale version */ }); }
catch (error) { thrown = error; }

expect(thrown).toBeInstanceOf(SeasonConflictError);
expect(thrown).toMatchObject({ recordType: "slot", recordId: slot.id,
  conflictingFields: ["state", "heldDecideBy", "heldForName", "fallbackVenueId"] });
expect(sqlite.prepare(/* same select */).get(slot.id)).toEqual(before);
```

The `before`/`after` snapshot equality is the strongest form of the third assertion:
for a guard inside a transaction, it proves the whole transaction rolled back, not just
that an error escaped.

## Why This Matters

A behavioural test proves the happy path works. It says *nothing* about whether a guard
is load-bearing — and for one specific class of guard, that gap is total rather than
partial.

The mechanism: a guard divides inputs into ones it permits and ones it rejects. A
happy-path test only ever supplies permitted inputs. On those inputs, a present guard
and an absent guard produce **byte-identical observable behaviour** — same return value,
same row, same error (none). So every happy-path assertion passes with the guard deleted.

That would be harmless if the guard's absence announced itself on the rejected inputs.
For a *loud* guard it does: delete a `NOT NULL` constraint or a type check and the
rejected input blows up somewhere downstream, so some unrelated test usually catches it.
A **silent-failure** guard is different. Delete `eq(venues.version, expectedVersion)`
and the stale write does not error — it *succeeds*. `result.changes` is 1, the verdict
at `records.ts:151` reads "no conflict," and the caller is told its write landed. The
only trace is that the winning write's data is gone. Nothing throws, nothing logs,
nothing is null. Lost-update corruption is exactly this: success reported for a write
that destroyed another.

So the suite being green carries no information about a silent-failure guard, and
"117 tests, all behavioural, against a real database" is not evidence. The only evidence
is a test that fails when the guard is removed. Mutation is not extra rigor here — it is
the *definition* of coverage for this class.

## When to Apply

Apply this whenever a guard's failure mode is **silent success** — the code returns
normally, with a plausible value, on the inputs the guard was supposed to reject. Ask:
*if I deleted this line, what would a rejected input do?* If the answer is "succeed," the
guard needs a mutation-verified test before you call it covered.

Concretely, in this codebase and its likely future:

- **Compare-and-swap version predicates** — every `eq(<table>.version, expectedVersion)`
  in a WHERE clause. There are more than the four fixed here: `records.ts` also guards
  inside `promotePlaceholderAct` and `promotePlaceholderVenue`, and `season.ts` guards
  season transitions and assignment corrections. Each guard is its own mutation target;
  proving one is watched proves nothing about its siblings, which is precisely how these
  four were missed.
- **Authorization and ownership checks** — an organizer-scoping predicate that,
  removed, returns another season's rows just as cheerfully as its own.
- **Fail-closed verdicts** — an anti-bot or rate-limit check that, removed, admits the
  request rather than erroring. The tell is that the safe behaviour is a *rejection*,
  which the happy path never exercises.
- **Idempotence predicates** — `AND sent_at IS NULL` on an email send, `AND state = 'open'`
  on a claim. Removed, the second call sends twice and reports success both times. (The
  repository has an `emailLog` table and slot-state machinery; this pattern is where such
  guards will land.)

Do **not** spend the effort on guards that fail loudly — a type check, a `NOT NULL`, a
lifecycle assertion that throws on the happy path when broken. Those tend to be caught
incidentally. The cost of the discipline is one mutate/run/restore cycle per guard, a
minute or two each; spend it where absence is invisible.

A useful default when a guard is *added*: add its stale/rejected-input test in the same
change, and record the mutation observation in the commit or PR body. The observation is
the artifact — it is what a later reader can trust without re-deriving it.

## Examples

All observations below were re-run on branch `feat/u3-schema` on 2026-08-22 against the
current tree, restoring the source after each mutation.

**Baseline.** `npx vitest run packages/core/test/records.test.ts packages/core/test/season.test.ts`
→ `Tests 30 passed (30)`. Full suite: `Tests 135 passed (135)` across 12 files.

**Before the fix — the failure this documents.** With no stale-version test for
`updateVenue`, `updateContact`, `holdSlot`, or `releaseSlotHold`, deleting any one of
their version predicates left the suite fully green. The guards were invisible.

**The mutation procedure.** For `updateVenue`, replace the guard at
`packages/core/src/records.ts:148`:

```ts
// before
.where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
// mutated
.where(eq(venues.id, id))
```

**After the fix — every guard now has a named killer.** Same mutation applied to each
guard in turn; each run reported `Tests 1 failed | 29 passed (30)` with exactly one
named failure:

| Guard | Mutation | Test that failed |
|---|---|---|
| `records.ts:148` `updateVenue` | drop `eq(venues.version, …)` | *refuses a stale venue write inside the update even when both writes share a timestamp* |
| `records.ts:167` `updateContact` | drop `eq(contacts.version, …)` | *refuses a stale contact write inside the update even when both writes share a timestamp* |
| `season.ts` `holdSlot` | drop `eq(slots.version, …)` | *refuses a stale slot version when placing a hold and leaves the row unchanged* |
| `season.ts` `releaseSlotHold` | drop `eq(slots.version, …)` | *refuses a stale slot version when releasing a hold and leaves the row unchanged* |

Restoring each predicate returned the suite to `Tests 30 passed (30)`.

**The control — why this is conclusive, not suggestive.** The same mutation on
`updateAct` (`records.ts:129`, whose stale-version test at
`packages/core/test/records.test.ts:33` predates this branch) produced
`Tests 1 failed | 29 passed (30)`, failing on *"refuses a stale write inside the update
even when both writes share a timestamp"*.

That control is the point. It rules out the alternative explanation — that the harness
cannot see this class of change at all, that SQLite or Drizzle or the pinned clock is
swallowing the difference. The harness works. Those four guards were simply unwatched,
and the green suite said nothing about it either way.

**Cross-check on the fix.** `git diff` on this branch shows the four stale-version tests
as *added* lines in `packages/core/test/records.test.ts` and
`packages/core/test/season.test.ts`, while the `updateAct` test is not in the added set —
confirming from the tree, independently of anyone's memory, which guard was the control
and which four were the gap.
