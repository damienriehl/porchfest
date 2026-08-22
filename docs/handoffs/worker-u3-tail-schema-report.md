# U3 tail schema-drift report

Date: 2026-08-22  
Branch: `feat/u3-schema`  
Commit status: intentionally uncommitted for orchestrator verification and commit

## Outcome

- `packages/core/src/storage/schema.ts` now exports `schemaTableNames` and
  `schemaTableDefinitions`. Both are derived from the Drizzle table objects; there is no
  second hand-written table-name or column-name list.
- `packages/core/test/schema.test.ts` and
  `packages/core/test/connection.test.ts` consume the canonical names. The schema test
  also discovers every exported `SQLiteTable` and fails if the canonical registry omits
  one, and it checks each migrated table's exact sorted column set.
- `scripts/container-smoke.sh` imports the same schema metadata inside the runtime image
  and checks both table presence and exact column sets. It also derives the empty-database
  expected error from `schemaTableNames`, removing the third pasted list.
- The smoke image contains the package TypeScript sources and the production `tsx`
  runtime, so the probe can use `node --import tsx` to import
  `packages/core/src/storage/schema.ts` directly. A generated-file fallback was not
  necessary.
- The smoke test now includes a permanent malformed-schema negative case. It copies the
  migrated database, replaces `acts` with an `acts(id)` table, requires the probe to fail
  with `Malformed migrated table acts:`, restores the copy, and compares `sha256sum`
  values.

The asserted stale-list and presence-only semantics matched the code. Line numbers moved
as the new checks were added. No KTD7/CAS code was touched, and none of the concurrent
worker-owned files were edited by this work.

## Mutation observations

| Guard | Temporary mutation | Named check that failed for the intended reason | Restoration proof |
|---|---|---|---|
| Canonical registry completeness | Removed the `annotations` table object from the private `schemaTables` registry while leaving the exported table intact | `core schema migration > includes every exported schema table in canonical metadata` failed with expected `annotations` but received no `annotations` | `packages/core/src/storage/schema.ts` SHA-256 before/after: `ad064f67e134de3fa3c5901ad6d1b23eb27a08a14e3b5fc2e3f7437119de90b4` |
| Smoke wrong-shape rejection | Neutralized `if (malformed.length > 0)` as `if (false && malformed.length > 0)` | Container smoke malformed-database negative check failed with `ERROR: schema readiness probe accepted a malformed database` | `scripts/container-smoke.sh` SHA-256 before/after: `93ea145e8098e257947b9df2eb7d535f0eb618a7b7f5e30beeb97749ae4838c3` |
| Real malformed table shape | On a copied migrated database, renamed the real `acts` table and created `acts (id integer)` | Intact probe failed with `Malformed migrated table acts: expected columns canonical_act_id, created_at, description, genre, id, links, name, placeholder, reach_via_contact_id, season_id, updated_at, version; actual columns id` | Copied database SHA-256 before/after restore: `4656f4c1ff78dd8ea9a1686ad7b2864864dab63efe0f2e89493c5d295f48b200` |

One earlier attempt to run the neutralized smoke guard stopped during the Docker build
because the concurrent worker's in-progress type widening temporarily did not typecheck.
The smoke script was immediately restored to its recorded hash; after the combined tree
became buildable, the mutation was repeated and reached the intended named failure shown
above.

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | Passed: 13 files, 155 tests; boundary and clean-room self-tests passed |
| `bash scripts/container-smoke.sh` | Passed end to end, including empty-database rejection, malformed-column rejection, byte-identical fixture restoration, image scan, clean-room scan, and TLS health |
| `bash -n scripts/container-smoke.sh` | Passed |
| `npx vitest run packages/core/test/schema.test.ts packages/core/test/connection.test.ts` | Passed: 2 files, 7 tests |

The suite count is 155 rather than the starting 152 because the concurrent worker added
tests in its owned files during this run. Final verification used the combined working
tree.

## Files changed by this work

- `packages/core/src/storage/schema.ts`
- `packages/core/test/schema.test.ts`
- `packages/core/test/connection.test.ts`
- `scripts/container-smoke.sh`
- `docs/handoffs/worker-u3-tail-schema-report.md` (the explicitly required report)

No commit was created, pushed, or merged.
