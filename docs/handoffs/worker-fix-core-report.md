# Core P1 fixes: records and season lifecycle

Date: 2026-08-22  
Branch: `feat/u3-schema`  
Status: implemented and verified; final follow-up intentionally uncommitted

## Outcome

- Removed the `records.ts` -> `season.ts` import, eliminating the new module cycle.
- Moved the act-family assignment collision invariant from `records.supersedeAct` to the `season.supersedeAct` wrapper while preserving the `SeasonLifecycleError` message shape.
- Put promotion's assignment collision invariant in the season wrapper and changed it to count canonical act families in memory with the proposed `submission -> placeholder` merge applied.
- Kept each family snapshot, collision verdict, and records-layer mutation in one immediate database transaction so another connection cannot change assignments between the verdict and write.
- Added season checks for non-null `updateAct.reachViaContactId`, `updateVenue.hostContactId`, and `updateVenue.reachViaContactId` contact links.
- Left every compare-and-swap predicate inside its `UPDATE` and left every verdict on `result.changes !== 1`. No CAS function was consolidated and no `.returning()` verdict was introduced.

## Venue conclusion

I did not mirror the canonical-family assignment count into `promotePlaceholderVenue`. Act families must have at most one assignment, but a venue may legitimately host multiple slots, so a post-merge slot count greater than one is not itself a collision. The existing literal venue-promotion slot behavior was left unchanged.

## Tests

Added named coverage for:

- placeholder-family collision routed through a superseded child;
- submission-family collision routed through a superseded child;
- legal promotion with one assigned superseded placeholder-family child;
- legal promotion when the merge changes the target-family count from zero to one;
- legal promotion when the target family already has two assignments and the merge does not increase that count;
- descendant-family supersession collision at the season wrapper boundary;
- supersession collision when the requested target is itself an alias of the assigned canonical target;
- cross-season act reach-via contact correction;
- cross-season venue host contact correction;
- cross-season venue reach-via contact correction;
- legal same-season act and venue contact links, including clearing each link with `null`.

The existing literal act-promotion collision test now calls the season repository, matching the lifecycle boundary.

Proof-first observation before production changes:

`npx vitest run packages/core/test/season.test.ts packages/core/test/records.test.ts`
reported exactly 5 named failures and 35 passes. The failures were the two canonical-family promotion reproductions and the three cross-season contact-link tests. The legal promotion and supersession-boundary characterization tests passed.

After implementation and review follow-up, the same focused command reported 44/44 passing.

## Mutation verification

Baseline and every restored `packages/core/src/season.ts` SHA-256:

`5405801efd38666b9d00bdfc87c7ca0a3c3c8c381fcba018ed83dc713739569b`

That baseline covers the initial guard mutations. After moving the snapshot and mutation into one immediate transaction and adding the verdict-boundary tests, the new baseline and both restored SHA-256 observations were:

`5a66ad01cfbc5d2b94e7e1a440c70b3b9e21526dcf59a828bd36a9f7c707ecc5`

Each mutation was applied alone, its named test was run, the mutation was restored, and `sha256sum` matched the baseline before the next mutation:

| Mutated guard                                                         | Named failure observed                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neutralized promotion wrapper entry into the act-family check         | Both `refuses act promotion when an assigned superseded child...` tests failed (2 failed, 19 skipped)                                                                                                             |
| Neutralized supersession wrapper entry into the act-family check      | `keeps descendant-family supersession collisions in the season wrapper` failed (1 failed, 20 skipped)                                                                                                             |
| Neutralized the shared projected-family count verdict                 | Both promotion reproductions and the descendant-family supersession test failed (3 failed, 18 skipped)                                                                                                            |
| Neutralized `updateAct` contact-season comparison                     | `refuses an act correction that links a reach-via contact from another season` failed (1 failed, 20 skipped)                                                                                                      |
| Neutralized `updateVenue` host-contact season comparison              | `refuses a venue correction that links a host contact from another season` failed (1 failed, 20 skipped)                                                                                                          |
| Neutralized `updateVenue` reach-via-contact season comparison         | `refuses a venue correction that links a reach-via contact from another season` failed (1 failed, 20 skipped)                                                                                                     |
| Neutralized `mergedTargetAssignments > 1` only                        | `allows act promotion when only the submission family is assigned` failed with `act promotion would merge assignments` (1 failed, 24 skipped); restoration matched the new baseline byte-for-byte                 |
| Neutralized `mergedTargetAssignments > currentTargetAssignments` only | `allows act promotion when it does not worsen an existing duplicate target family` failed with `act promotion would merge assignments` (1 failed, 24 skipped); restoration matched the new baseline byte-for-byte |

Final post-restoration focused run: 44/44 passing.

## Review follow-up

An adversarial code review found one P1 after the first green gate: the family snapshot was taken before entering the records mutation transaction, allowing another database connection to change assignments between the check and write. Both the promotion and supersession wrappers now open an immediate transaction, perform the family check through that transaction, and call a transaction-scoped records repository. The pinned entity-specific CAS statements remain unchanged inside their original `UPDATE`s and still use `result.changes !== 1`.

The review's softer coverage gaps were also closed by the target-alias, same-season/null-contact, and two independent verdict-conjunct tests above. No actionable review findings remain.

## Required gates

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed outside the filesystem sandbox: 13 files, 152 tests, all passing; core-boundary, route-boundary, and clean-room self-tests all passed.

The first sandboxed `npm test` attempt completed Vitest (148/148) and both boundary checks, then the clean-room test could not spawn `git init` (`EPERM`). The required rerun with the needed temporary-directory permission passed in full.

The shared branch moved forward through commits made by concurrent workers while this task was in progress; commit `ccd7223` included the initial core changes and report from the shared tree. I did not touch, stage, commit, or revert their owned files. This worker performed no commit, push, or branch operation; its final review follow-up changes are intentionally left unstaged and uncommitted.
