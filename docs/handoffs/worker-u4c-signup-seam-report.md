# U4c R1 field model and transactional signup seam report

Date: 2026-08-22  
Branch: `feat/u4-signup-forms`  
Status: implemented and verified; intentionally uncommitted

## Outcome

Core now exposes `createHostSignup` and `createPerformerSignup` through
`createSeasonRepository` / `CoreRuntime.seasons`. Each wrapper opens one immediate SQLite
transaction, reads the season and applies the shared `signup` legality action inside that
transaction, binds `createRecordRepository` to the same transaction, and creates the contact,
venue or act, and normalized child rows atomically.

`signups_open` and `assigning` accept the new `signup` action. The plan's state table says Matching
continues to accept public forms because the 2026 season matched on a rolling basis; all other
states refuse creation. Successful contact and venue/act rows are already returned by
`listActivityQueue`, so no parallel activity mechanism was added.

No dependency was added. No adapter package is imported by core. The existing KTD7 CAS functions
were not restructured, consolidated, changed from affected-row verdicts, or changed to
`.returning()`.

## Field-model decision

Scalar fields are typed columns on their owning record:

- venue: `space_description` (text), `has_power` (nullable boolean), `rain_backup` (nullable
  boolean);
- act: `duration_minutes` (integer), `requires_amplification` (nullable boolean),
  `house_preference` (text), `can_lend_gear` (nullable boolean).

The booleans are nullable in storage so existing rows and placeholders can mean “not answered”
without being silently treated as “no.” Public signup inputs require actual booleans. Promotion
therefore preserves an organizer's placeholder value when a legacy/submission row omitted one.

Venue gear, drinks, and amenities are normalized into `venue_gear`, `venue_drinks`, and
`venue_amenities`. Each row is season-scoped, mutable (`version`, `created_at`, `updated_at`),
foreign-keyed to its venue, unique per venue/value, and uses an enum-constrained `value` column.
This makes matching comparisons queryable (R8), keeps every rendered value traceable to one row
(R10), and permits per-value self-serve edits later (R14).

Performer slot availability is normalized into `act_availabilities` with typed `starts_at` /
`ends_at` windows. It is not forced into a fixed enum: R34 makes a season's slots configurable,
and actual time windows can be compared directly with venue slots for deterministic availability
matching. Duplicate windows are refused and `ends_at` must be later than `starts_at`. The existing
venue-bound `slots` table was not reused because a performer submits availability before a venue
assignment exists.

Placeholder promotion copies missing child values/windows onto the promoted canonical record and
leaves the submitted child rows attached to the superseded submission. Existing placeholder-only
values survive, duplicates collapse on the canonical record, and the original submission remains
intact for R6 traceability. New scalar values participate in the existing
submission-over-placeholder fallback rules.

The migration was generated with `npm run db:generate` as
`packages/core/drizzle/0003_awesome_krista_starr.sql`; its snapshot and journal entry are included.
An initial schema draft put a new CHECK on the existing self-referential `acts` table. Drizzle-kit
then generated an invalid table rebuild that selected the new columns from the old table. That
draft migration was discarded before use; duration remains a typed integer, while the generated
final migration is purely additive for existing tables and creates the four normalized tables
with their required checks.

## Files changed

- `packages/core/src/storage/schema.ts`
- `packages/core/drizzle/0003_awesome_krista_starr.sql` (new, generated)
- `packages/core/drizzle/meta/0003_snapshot.json` (new, generated)
- `packages/core/drizzle/meta/_journal.json` (generated journal update)
- `packages/core/src/records.ts`
- `packages/core/src/season.ts`
- `packages/core/src/index.ts`
- `packages/core/test/schema.test.ts`
- `packages/core/test/connection.test.ts`
- `packages/core/test/records.test.ts`
- `packages/core/test/season.test.ts`
- `docs/handoffs/worker-u4c-signup-seam-report.md` (this report)

The pre-existing untracked `docs/handoffs/worker-u4b-signup-report.md` was read for context and was
not edited.

## Proof-first red observations

Before production changes, this command was run:

`npx vitest run packages/core/test/schema.test.ts packages/core/test/season.test.ts`

It reported 6 failed and 33 passed tests. The intended failures were:

| Test                                                                       | Witnessed red                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `stores R1 signup fields in typed columns and normalized child rows`       | SQLite: `table venues has no column named space_description`                       |
| `matches the documented legality policy for every season state and action` | `signup` had no legality entry (`undefined.includes`)                              |
| `creates a complete host signup and exposes it in the activity queue`      | `createHostSignup is not a function`                                               |
| `creates a complete performer signup and exposes it in the activity queue` | `createPerformerSignup is not a function`                                          |
| `refuses signup creation outside signups-open and persists nothing`        | received missing-method error instead of the required season refusal               |
| `rolls back a signup when a delegated child-row write fails`               | received missing-method error instead of the delegated failure / rollback behavior |

The required review then exposed two contract gaps. Tests were strengthened before each fix:

| Test change                                                              | Witnessed red                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| allow both signup kinds during `assigning`                               | legality matrix returned `false`; creation threw `season state assigning refuses action signup`      |
| preserve and union normalized child rows during placeholder promotion    | submitted availability/set rows were re-parented and version-incremented instead of remaining intact |
| export runtime signup option vocabularies through the core package entry | `venueGearValues` was `undefined` when imported from `src/index.ts`                                  |

After the fixes, the focused connection, schema, record, and season suites passed 64/64.

## Mutation observations

Each mutation was applied alone, the named test was observed failing, the source was restored, the
test passed again, and `sha256sum` confirmed byte-identical restoration.

| Guard                                | Neutralizing mutation                                                                              | Named test observed failing                                                        | Restored SHA-256                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| signup state policy                  | accept every season state instead of only `signups_open` and `assigning`                           | `refuses host and performer signup creation in closed states and persists nothing` | `season.ts`: `0e196985801ea89e203b110e211a9550893e0a49afac695e3dc49f0b454f4fac` |
| performer signup legality            | remove only the performer wrapper's `assertLegal` call                                             | same host-and-performer closed-state refusal test                                  | same `season.ts` hash                                                           |
| host all-or-nothing transaction      | call the database-bound record repository without `db.transaction(..., { behavior: "immediate" })` | `rolls back a signup when a delegated child-row write fails`                       | same `season.ts` hash                                                           |
| performer all-or-nothing transaction | call the database-bound record repository without `db.transaction(..., { behavior: "immediate" })` | `rolls back a performer signup when a delegated availability write fails`          | same `season.ts` hash                                                           |
| venue gear enum                      | replace migration CHECK with `CHECK(1)`                                                            | `rejects unsupported signup set values and invalid availability windows`           | migration: `6855d431aeb4a0ea7f718415aff44295b46f4b7df30b78ce3ee514077b93fd5a`   |
| venue drinks enum                    | replace migration CHECK with `CHECK(1)`                                                            | same unsupported-values test                                                       | same migration hash                                                             |
| venue amenities enum                 | replace migration CHECK with `CHECK(1)`                                                            | same unsupported-values test                                                       | same migration hash                                                             |
| availability window                  | replace `ends_at > starts_at` CHECK with `CHECK(1)`                                                | same unsupported-values/window test                                                | same migration hash                                                             |
| venue gear set uniqueness            | change its unique index to a non-unique index                                                      | `rejects duplicate values in normalized signup sets`                               | same migration hash                                                             |
| venue drinks set uniqueness          | change its unique index to a non-unique index                                                      | same duplicate-values test                                                         | same migration hash                                                             |
| venue amenities set uniqueness       | change its unique index to a non-unique index                                                      | same duplicate-values test                                                         | same migration hash                                                             |
| availability-window uniqueness       | change its unique index to a non-unique index                                                      | same duplicate-values test                                                         | same migration hash                                                             |

The shared `/tmp` filesystem reached an environment quota during mutation work. A first attempted
test did not load and was not counted as evidence. The affected mutation was rerun successfully
with ephemeral task scratch space; only actual named-test failures appear above.

## Review and simplification

The required three-lens simplification pass produced one applied cleanup: the duplicated migration
CHECK parser in `schema.test.ts` is now a shared helper. Suggested raw-SQL/set-based promotion
rewrites and removal of the availability prefix index were not applied because the form sets are
bounded and those changes trade typed clarity/read behavior for small write-count savings.

The diff-scoped review found and resolved:

- `assigning` must accept rolling host and performer signups per the authoritative state table;
- promotion must copy normalized values to the canonical placeholder without removing the original
  submission's rows;
- the closed-state proof must exercise both public creation wrappers;
- empty child sets, new scalar fallback fields, and distinct promotion unions needed behavioral
  coverage;
- the runtime gear/drink/amenity vocabularies must be exported through the core package entry point
  for the downstream form adapter.

A file-length-only finding against `records.ts` was independently rejected as an unsupported
preference whose proposed new module was outside the authorized file scope. Security, performance,
migration, and reliability reviewers found no additional defect. The configured external
cross-model review did not run: the environment rejected external transmission, so no code was sent;
the adversarial lens ran locally instead.

## Verification

| Gate                       | Result                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run check:clean-room` | pass — no participant-data artifacts in working tree or history         |
| `npm run check:boundaries` | pass — core imports no adapter package; routes remain registry-only     |
| `npm run typecheck`        | pass                                                                    |
| `npm test`                 | pass — 15 files, 187/187 tests; boundary and clean-room self-tests pass |
| `npm run lint`             | pass                                                                    |
| `npm run format:check`     | pass                                                                    |
| `git diff --check`         | pass                                                                    |

The first clean-room run correctly rejected phone-shaped synthetic fixtures. They were replaced by
explicit non-phone sentinel strings, and the final clean-room and full test gates passed.
The first post-review typecheck caught `null` values in test fixtures for required performer text
inputs; the fixtures now use empty strings, and the final typecheck passes.

## Spec/code disagreements

- The task says “roughly nine” missing R1 fields but enumerates 11: six venue-side and five
  act-side. All 11 enumerated fields are modeled.
- The initial implementation treated only `signups_open` as open. The authoritative state table
  says Matching (`assigning`) deliberately continues to accept forms for rolling additions. The
  final legality policy and tests follow that state machine.
- No invalidating final spec/code disagreement remains. The committed starting code did match the
  asserted blocker: it had no creation method and no storage for the enumerated fields.

## Handoff state

All work remains uncommitted as requested. Nothing was staged, committed, pushed, or merged.
