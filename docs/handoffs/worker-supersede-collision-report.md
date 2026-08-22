# Supersession collision fix report

## Fix

- `packages/core/src/records.ts:592` reads the season's act supersession graph and assignments inside the existing `supersedeAct` transaction.
- `packages/core/src/records.ts:605` resolves each assigned act against both the current graph and the graph produced by the proposed source-to-target supersession.
- `packages/core/src/records.ts:634` refuses only when the proposed supersession increases the target canonical family to more than one assignment. It throws the same `SeasonLifecycleError` and `canonical act <id> is already assigned in season <id>` message shape used by `assignSlot`.
- `packages/core/src/records.ts:642` retains the existing KTD7 compare-and-swap UPDATE unchanged: expected `version` stays in the UPDATE predicate, the version increments in that statement, and `result.changes !== 1` remains the verdict.

## Entity reasoning

- **Act:** the invariant applies. A canonical act family represents one logical performer, so merging two assigned families would leave that performer assigned to multiple slots. The exact collision and rollback assertions are covered at `packages/core/test/records.test.ts:778`.
- **Venue:** no equivalent invariant applies. A canonical venue may legally host multiple slots. No supersession guard was added. The legal case where both source and target venues host slots and supersession still succeeds is covered at `packages/core/test/records.test.ts:733`.
- **Contact:** no equivalent invariant applies. Multiple acts and venues may legally refer to one canonical contact. No supersession guard was added. The legal case where both contacts are referenced by records and supersession still succeeds is covered at `packages/core/test/records.test.ts:944`.

## Legal act case

`packages/core/test/records.test.ts:874` assigns the canonical act, leaves the source act unassigned, supersedes the source into the canonical family, and verifies that the family retains exactly the original single assignment. The test passes.

## Verification

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed, 138/138 tests across 12 files; both boundary self-tests and the clean-room scan also passed.
- The first sandboxed `npm test` attempt reached 138/138 Vitest tests but the clean-room scan could not spawn `git init` (`EPERM`). The required full gate was rerun outside that sandbox and exited successfully.

## Spec discrepancies

None. The current code matched the described transaction shape and missing assignment check. Existing changes in `records.ts`, `season.ts`, and the tests were preserved.

No commit, push, or branch operation was performed.
