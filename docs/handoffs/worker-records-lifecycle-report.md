porchfest U3 records lifecycle report

Changes

- Fix 1: promotion now rejects an already-superseded placeholder or submission for acts and venues before any promotion writes (`packages/core/src/records.ts:204`, `packages/core/src/records.ts:321`). Coverage is in `packages/core/test/records.test.ts:328`, `packages/core/test/records.test.ts:357`, `packages/core/test/records.test.ts:620`, and `packages/core/test/records.test.ts:651`.
- Fix 2: act promotion detects assignment collisions, moves submission assignments to the placeholder with an in-statement version increment and `updatedAt`, and re-points act email history (`packages/core/src/records.ts:214`, `packages/core/src/records.ts:247`). Venue promotion detects schedule collisions, moves both primary and fallback slot references with one in-statement version increment per affected slot, and re-points venue email history (`packages/core/src/records.ts:331`, `packages/core/src/records.ts:379`). The rewritten dependent-row fixtures and collision coverage are in `packages/core/test/records.test.ts:139`, `packages/core/test/records.test.ts:386`, `packages/core/test/records.test.ts:437`, and `packages/core/test/records.test.ts:682`.
- Fix 3: nullable act and venue submission fields now fall back to organizer-entered placeholder values while submitted names/titles still win (`packages/core/src/records.ts:228`, `packages/core/src/records.ts:355`). Coverage, including preservation of both venue email recipients, is in `packages/core/test/records.test.ts:247` and `packages/core/test/records.test.ts:560`.
- Fix 4: `supersedeAct`, `supersedeVenue`, and `supersedeContact` now perform the source/target reads, canonical-chain resolution, immediate canonical-target recheck, guarded CAS update, and final read inside one transaction (`packages/core/src/records.ts:547`, `packages/core/src/records.ts:608`, `packages/core/src/records.ts:680`). The per-entity CAS guards remain in each UPDATE statement and still use affected-row counts. New venue success-path coverage is at `packages/core/test/records.test.ts:721`.
- Added stale-version coverage for `updateVenue` and `updateContact` at `packages/core/test/records.test.ts:69` and `packages/core/test/records.test.ts:102`.

Required proof observations

- AE7 fixture: after rewriting the act assignment/email and venue slot/email fixtures to reference the submissions, and after Fix 1 but before Fix 2, the focused suite failed directly on the re-read dependent rows: the act assignment remained on submission act 2 at version 1 instead of placeholder act 1 at version 2, and the venue slot remained on submission venue 2 at version 1 instead of placeholder venue 1 at version 2. After Fix 2, the focused suite passed 14/14.
- `updateVenue` mutation: temporarily replacing the guarded WHERE with an id-only WHERE made the new stale-venue test fail because the stale write did not throw. Restoring `eq(venues.version, expectedVersion)` returned the focused suite to 16/16.
- `updateContact` mutation: temporarily replacing the guarded WHERE with an id-only WHERE made the new stale-contact test fail because the stale write did not throw. Restoring `eq(contacts.version, expectedVersion)` returned the focused suite to 16/16.

Final gates

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed, 128/128 tests across 11 files, followed by passing core-boundary, route-boundary, and clean-room checks.

Contradictions

- None found. The schema matched the task description: assignments and slots have mutable version/timestamp columns, while email_log has no version column.
