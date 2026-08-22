# U3 tail core: transaction seam and confirmed P2 fixes

Date: 2026-08-22  
Branch: `feat/u3-schema`  
Status: implemented and verified; intentionally uncommitted

## Outcome

- Added shared `CoreTransaction` and `CoreExecutor` types beside `CoreDatabase`. `createRecordRepository` now accepts `CoreExecutor`; the records/season module boundary and call graph are unchanged.
- Wrapped all eight season-governed record writes (`updateAct`, `updateVenue`, `updateContact`, both placeholder promotions, and all three supersessions) in one outer transaction containing both legality checks and the transaction-bound record-repository call.
- All eight outer write transactions use Drizzle's `{ behavior: "immediate" }` configuration.
- Replaced the per-assignment `records.resolveAct` queries in `assignSlot` and `correctAssignment` with one season-act query, a `Map`, and in-memory canonical-chain resolution.
- Re-pointed act annotations from the submitted act to the promoted placeholder with both polymorphic predicates (`recordType = "act"` and the submitted `recordId`).
- Left every entity-specific compare-and-swap predicate inside its original `UPDATE`, kept verdicts on `result.changes !== 1`, did not consolidate CAS functions, and did not introduce `.returning()` verdicts.

## Transaction and type verification

The installed Drizzle version exports `BetterSQLiteTransaction`, not the proposed `BetterSQLite3Transaction`. Its declaration has the expected two generic parameters, so the shared type is:

```ts
BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
```

This is the only code/spec naming disagreement found. `ExtractTablesWithRelations` is publicly exported by `drizzle-orm`.

The installed runtime at `node_modules/drizzle-orm/better-sqlite3/session.js` was checked directly. A database transaction delegates to better-sqlite3 with the requested behavior (`immediate` here). A nested `BetterSQLiteTransaction.transaction()` explicitly issues `SAVEPOINT`, `RELEASE SAVEPOINT`, and, on failure, `ROLLBACK TO SAVEPOINT`. Season-level promotion tests also passed through the real outer-transaction/nested-record-transaction path.

## Proof-first and characterization evidence

| Behavior                                           | Pre-implementation observation                                                                                                                                                     | Passing observation                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Atomic legality check and delegated write          | `rolls back season state changed during a failed delegated record write` failed because the season remained `archived` instead of rolling back to `setup`                          | Named test passed after the eight wrappers were transaction-bound |
| Annotation promotion                               | `promotes a placeholder act without losing assignment, email, or annotation history` failed because the target annotation retained submitted act id `2` instead of promoted id `1` | Named test passed after annotation re-pointing                    |
| Canonical-chain cycle behavior during N+1 refactor | `refuses assignment through a supersession cycle without changing the slot` passed as a pre-change characterization                                                                | Named test passed with the Map-based resolver                     |

## Mutation verification

Each mutation below was applied alone to the final formatted source, the named test was observed failing, the mutation was restored, and `sha256sum` matched the pre-mutation baseline before the next mutation.

Final/restored SHA-256 values:

- `packages/core/src/season.ts`: `e51cc9ae48706a00de10270c1943d3fc1cb1bacce5b3451196873b4180924b03`
- `packages/core/src/records.ts`: `de4d96d8fedd673f65c32247f3d803be1759a7360687940e46bee7484408ff41`

| Guard neutralized                                        | Named failure observed                                                                                                                          | Restoration                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Canonical-chain cycle guard returned instead of throwing | `refuses assignment through a supersession cycle without changing the slot` failed because assignment did not throw                             | `season.ts` SHA matched `e51cc9…b03`  |
| Canonical-family already-assigned verdict forced false   | `excludes and refuses a canonical act already assigned under a superseded identity` failed because assignment did not throw                     | `season.ts` SHA matched `e51cc9…b03`  |
| Annotation `recordType = "act"` predicate removed        | `promotes a placeholder act without losing assignment, email, or annotation history` failed because the same-id venue annotation was re-pointed | `records.ts` SHA matched `de4d96…f41` |
| Annotation submitted-`recordId` predicate removed        | `promotes a placeholder act without losing assignment, email, or annotation history` failed because the unrelated act annotation was re-pointed | `records.ts` SHA matched `de4d96…f41` |

Post-restoration focused run: `npx vitest run packages/core/test/season.test.ts packages/core/test/records.test.ts` passed 46/46.

## Required gates

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed outside the filesystem sandbox: 13 test files, 155 tests, all passing; core-boundary, route-boundary, and clean-room self-tests all passed.
- The first sandboxed `npm test` attempt completed Vitest (155/155) and both boundary checks, then the clean-room self-test could not spawn `git init` (`EPERM`). The identical rerun with temporary-directory permission passed in full.
- `git diff --check`: passed.

## Scope and handoff state

Files changed by this worker:

- `packages/core/src/season.ts`
- `packages/core/src/records.ts`
- `packages/core/src/storage/repository-errors.ts`
- `packages/core/test/season.test.ts`
- `packages/core/test/records.test.ts`
- `docs/handoffs/worker-u3-tail-core-report.md` (the task's explicit report exception to the general docs exclusion)

Concurrent changes appeared in `packages/core/src/storage/schema.ts`, `packages/core/test/schema.test.ts`, `packages/core/test/connection.test.ts`, and `scripts/container-smoke.sh` while this work was in progress. They belong to the other worker and were not edited, staged, reverted, or included in this report's implementation scope.

No commit, push, merge, branch change, or staging operation was performed. All work is left uncommitted for the orchestrator.
