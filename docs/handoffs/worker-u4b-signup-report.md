# U4b public signup forms report

Date: 2026-08-22  
Branch: `feat/u4-signup-forms`  
Status: blocked before implementation; intentionally uncommitted

## Outcome

U4b cannot be implemented through the committed U3 core seam while preserving the
plan's settled KTD2 boundary. No production or test files were changed.

`CoreRuntime` exposes the adapter ports and `SeasonRepository`. The repository can
read seasons, list the activity queue, and perform lifecycle updates, but it has no
operation that transactionally creates a public signup's contact plus venue or act.
`createRecordRepository` is internal and likewise has no creation operation. U3
deliberately removed the raw database from `CoreRuntime`; the existing boot-regression
test asserts that it remains absent.

The committed schema also has no first-class storage for most R1 fields:

- host: space, power, rain plan, gear, drinks, and amenities;
- performer: duration, available slots, amplification, house preference, and lend-gear.

Web code could reach the composition root's temporary database handle and issue raw
SQL, then serialize these fields into generic `notes`, `genre`, or annotation text.
That would put domain/storage behavior in `packages/web`, bypass the gated core seam,
and create an undocumented encoding that U5 admin, U7 outbox, and U9 map code would
have to reverse-engineer. This conflicts with KTD2's user-approved decision that
`core` owns the domain and storage and that `web` consumes it through injection.

## Required unblock

The core owner needs to add a narrow transactional public-signup API and durable field
model, then expose it through `CoreRuntime` (or explicitly approve a different seam).
At minimum it must:

1. find the season accepting signups;
2. atomically create the contact and venue/act plus every R1 field;
3. leave no rows when the transaction fails;
4. return enough identity for the activity-queue assertion;
5. preserve submitted values as raw participant data for later escaped rendering.

Once that API is committed, U4b can consume the finalized anti-bot port without
changing `packages/antibot/**` or `packages/core/src/**`.

## Files changed

- `docs/handoffs/worker-u4b-signup-report.md` (this blocker report only)

`behavior_changed`: `false`

## Existing tests and code inspected

- `packages/web/test/app.test.ts`
- `packages/web/test/boot-regressions.test.ts`
- `packages/web/test/composition.test.ts`
- `packages/web/test/route-registry.test.ts`
- `packages/core/test/records.test.ts`
- `packages/core/test/season.test.ts`
- `packages/core/src/index.ts`
- `packages/core/src/records.ts`
- `packages/core/src/season.ts`
- `packages/core/src/storage/connection.ts`
- `packages/core/src/storage/schema.ts`
- `packages/core/src/ports/antibot.ts`
- `packages/antibot/src/index.ts`
- `packages/antibot/src/ratelimit.ts`
- `packages/antibot/src/turnstile.ts`
- `packages/web/src/app.ts`
- `packages/web/src/composition.ts`
- `packages/web/src/router/registry.ts`
- `packages/map/assets/porchfest-map.css`
- `scripts/check-core-boundary.mjs`
- `docs/handoffs/worker-fix-boot-report.md`
- `docs/handoffs/worker-u4a-antibot-report.md`

## Tests added or changed

None. The missing persistence contract determines both the black-box database
assertions and the production injection shape. Writing tests against an invented raw
SQL/JSON encoding would prematurely choose the architecture that the settled KTD2
decision rules out.

## Proof-first red observations

None. The seam blocker was found during the required pre-write two-level trace, before
the proof-first test edit. No red result is claimed or reconstructed.

## Verification commands and results

- Read-only source, history, route-boundary, and repository API inspection completed.
- Authoritative or focused test commands were not run because no behavior-bearing
  implementation was made.

## Spec/code disagreements

- The U4 plan and worker packet require a real-database, atomic public-signup write and
  activity-queue visibility while forbidding changes to `packages/core/src/**`.
- The committed code exposes no public creation API and intentionally hides the raw
  database from runtime application callers.
- The committed schema cannot represent every R1 field as a named domain field.
- The anti-bot port itself is correct: its four-way discriminated union supports the
  required exhaustive caller switch. It was not changed.

No dependency was added. No staging, commit, push, merge, or branch change was
performed. This report is left uncommitted for the orchestrator.
