porchfest U3 season-legality report

Fix 1
- Added season-domain wrappers for all eight authoritative record mutators (three updates, two placeholder promotions, and three supersessions). Each wrapper resolves the source record's season, applies correction legality, and only then delegates. The wrappers are exposed from the frozen season repository object. packages/core/src/season.ts:182 and packages/core/src/season.ts:661
- Added archived-season rejection coverage for a correction, promotion, and supersession. packages/core/test/season.test.ts:366
- The wrappers are not atomic with their legality read. createRecordRepository is bound to CoreDatabase, while db.transaction supplies a BetterSQLite3Transaction that is not assignable to CoreDatabase (notably it does not expose the database-only client shape). Making a transaction-bound record repository would require changing the records/database abstraction in files outside this task's ownership. I did not cast around that boundary or restructure records.ts.

Fix 2
- Wrapped holdSlot, releaseSlotHold, and correctAssignment in database transactions and routed their season precondition reads and guarded writes through tx. The pinned version predicates and affected-row verdicts remain intact. packages/core/src/season.ts:315, packages/core/src/season.ts:398, and packages/core/src/season.ts:508

Fix 3
- Canonicalized assigned act identities through the records resolver before filtering assignment suggestions. packages/core/src/season.ts:597
- Added canonical-family duplicate checks inside assignSlot and correctAssignment transactions; failures are SeasonLifecycleError messages naming the canonical act and season, and the guarded mutation rolls back. packages/core/src/season.ts:186, packages/core/src/season.ts:499, and packages/core/src/season.ts:574
- Added coverage proving a superseded assigned act suppresses its canonical suggestion, direct assignment is refused without changing the slot, and correction cannot create the same duplicate. packages/core/test/season.test.ts:413 and packages/core/test/season.test.ts:451

Fix 4
- Added stale-version tests for hold and release that assert SeasonConflictError metadata and re-read unchanged rows. packages/core/test/season.test.ts:201 and packages/core/test/season.test.ts:244
- Hold mutation observation: with eq(slots.version, expectedVersion) temporarily removed from holdSlot, the stale-hold test failed because no SeasonConflictError was thrown; with the predicate restored, the focused season suite passed 14/14.
- Release mutation observation: with eq(slots.version, expectedVersion) temporarily removed from releaseSlotHold, the stale-release test failed because no SeasonConflictError was thrown; with the predicate restored, the focused season suite passed 14/14.

Fix 5
- Recorded the owner-settled 2026-08-22 decision that prior-contact lookup deliberately reaches past the immediately preceding season. No behavior changed. packages/core/src/season.ts:642

Additional coverage and gates
- Added a direct assertion over all 24 season-state/action policy pairs. packages/core/test/season.test.ts:99
- npm run typecheck: passed.
- npm run lint: passed.
- npm test: passed, 135/135 tests across 12 files; both boundary self-tests and the clean-room scan also passed.

Contradictions
- The current records repository's authoritative mutator list matched the requested three update, two promotion, and three supersession wrappers. Existing records.ts and records.test.ts changes were read and left untouched.
- Independent review found one additional ordering that Fix 3's requested guards do not cover: assign canonical act A, assign separate act B, then supersede B into A. seasonRepository.supersedeAct currently delegates without an assignment-family collision check, so both assignments remain and resolve to A. packages/core/src/season.ts:260
- A robust atomic guard belongs inside records.supersedeAct's existing transaction. That file is explicitly outside this task's ownership, and the task asks for design review rather than restructuring across this boundary, so I did not force a non-atomic season.ts workaround. This remains a P1 design follow-up.
- An AFTER UPDATE trigger is not a faithful post-fix concurrency test for Fix 2 because SQLite executes the trigger inside the same transaction; the requested transaction prevents a competing connection from landing between the legality read and guarded write, but it cannot prevent same-transaction trigger logic from changing the season.
