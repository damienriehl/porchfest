# Core P1 fixes: records and season lifecycle

Date: 2026-08-22  
Branch: `feat/u3-schema`  
Status: implemented and verified; intentionally uncommitted

## Outcome

- Removed the `records.ts` -> `season.ts` import, eliminating the new module cycle.
- Moved the act-family assignment collision invariant from `records.supersedeAct` to the `season.supersedeAct` wrapper while preserving the `SeasonLifecycleError` message shape.
- Put promotion's assignment collision invariant in the season wrapper and changed it to count canonical act families in memory with the proposed `submission -> placeholder` merge applied.
- Added season checks for non-null `updateAct.reachViaContactId`, `updateVenue.hostContactId`, and `updateVenue.reachViaContactId` contact links.
- Left every compare-and-swap predicate inside its `UPDATE` and left every verdict on `result.changes !== 1`. No CAS function was consolidated and no `.returning()` verdict was introduced.

## Venue conclusion

I did not mirror the canonical-family assignment count into `promotePlaceholderVenue`. Act families must have at most one assignment, but a venue may legitimately host multiple slots, so a post-merge slot count greater than one is not itself a collision. The existing literal venue-promotion slot behavior was left unchanged.

## Tests

Added named coverage for:

- placeholder-family collision routed through a superseded child;
- submission-family collision routed through a superseded child;
- legal promotion with one assigned superseded placeholder-family child;
- descendant-family supersession collision at the season wrapper boundary;
- cross-season act reach-via contact correction;
- cross-season venue host contact correction;
- cross-season venue reach-via contact correction.

The existing literal act-promotion collision test now calls the season repository, matching the lifecycle boundary.

Proof-first observation before production changes:

`npx vitest run packages/core/test/season.test.ts packages/core/test/records.test.ts`
reported exactly 5 named failures and 35 passes. The failures were the two canonical-family promotion reproductions and the three cross-season contact-link tests. The legal promotion and supersession-boundary characterization tests passed.

After implementation, the same focused command reported 40/40 passing.

## Mutation verification

Baseline and every restored `packages/core/src/season.ts` SHA-256:

`5405801efd38666b9d00bdfc87c7ca0a3c3c8c381fcba018ed83dc713739569b`

Each mutation was applied alone, its named test was run, the mutation was restored, and `sha256sum` matched the baseline before the next mutation:

| Mutated guard | Named failure observed |
| --- | --- |
| Neutralized promotion wrapper entry into the act-family check | Both `refuses act promotion when an assigned superseded child...` tests failed (2 failed, 19 skipped) |
| Neutralized supersession wrapper entry into the act-family check | `keeps descendant-family supersession collisions in the season wrapper` failed (1 failed, 20 skipped) |
| Neutralized the shared projected-family count verdict | Both promotion reproductions and the descendant-family supersession test failed (3 failed, 18 skipped) |
| Neutralized `updateAct` contact-season comparison | `refuses an act correction that links a reach-via contact from another season` failed (1 failed, 20 skipped) |
| Neutralized `updateVenue` host-contact season comparison | `refuses a venue correction that links a host contact from another season` failed (1 failed, 20 skipped) |
| Neutralized `updateVenue` reach-via-contact season comparison | `refuses a venue correction that links a reach-via contact from another season` failed (1 failed, 20 skipped) |

Final post-restoration focused run: 40/40 passing.

## Required gates

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed outside the filesystem sandbox: 13 files, 148 tests, all passing; core-boundary, route-boundary, and clean-room self-tests all passed.

The first sandboxed `npm test` attempt completed Vitest (148/148) and both boundary checks, then the clean-room test could not spawn `git init` (`EPERM`). The required rerun with the needed temporary-directory permission passed in full.

The current shared working tree also contains concurrent edits in files owned by other workers. I did not touch, stage, commit, or revert them. No commit, push, or branch operation was performed.
