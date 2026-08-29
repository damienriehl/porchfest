# U9C core geocoding pipeline report

Date: 2026-08-29
Branch: `u9c-core-geocoding`
Status: implemented, reviewed, and locally verified; committed locally but not pushed or merged

## Outcome

- Widened the core-owned `GeoPort` with `locate(request)` and the complete provider
  outcome/provenance union. Requests carry the current season's bounds and optional
  locality; `geocode()` remains the narrow convenience implemented through `locate()`.
- Updated the null and OpenStreetMap adapters. OpenStreetMap now uses per-call season
  policy, with constructor values only as legacy fallbacks, and namespaces its address
  cache and Overpass snapshots by the effective lookup policy.
- Moved the pure coordinate gate into core and re-exported it from `packages/geo`, so
  core can enforce publishability without importing an adapter package.
- Added migration `0014_venue_coordinates` and a one-to-one provenance table. It stores
  coordinates, source, precision, provider/ref, cross-check distance, review status,
  rejection code, source address, timestamps, organizer attribution, and a coordinate
  version.
- Added the core geocoding repository with geocode, organizer verification, review-list,
  and publishable-coordinate reads. Publication exposes only verified point pairs.
- Added R29 invalidation at the shared venue-record seam and preserved coordinate state
  through placeholder promotion and retention deletion.
- Added no dependency, did not change `package-lock.json`, did not add a route, and did
  not touch `packages/map`.

`behavior_changed`: `true`

## Files changed

- `packages/core/drizzle/0014_venue_coordinates.sql`
- `packages/core/drizzle/meta/0014_snapshot.json`
- `packages/core/drizzle/meta/_journal.json`
- `packages/core/src/geo-verify.ts`
- `packages/core/src/geocoding.ts`
- `packages/core/src/index.ts`
- `packages/core/src/ports/geo.ts`
- `packages/core/src/ports/index.ts`
- `packages/core/src/records.ts`
- `packages/core/src/retention.ts`
- `packages/core/src/storage/schema.ts`
- `packages/core/test/geocoding.test.ts`
- `packages/core/test/records.test.ts`
- `packages/core/test/retention.test.ts`
- `packages/core/test/schema.test.ts`
- `packages/geo/src/geocode.ts`
- `packages/geo/src/index.ts`
- `packages/geo/src/verify.ts`
- `packages/geo/test/contract.ts`
- `packages/geo/test/geocode.test.ts`
- `docs/handoffs/worker-u9c-core-geocoding-report.md`

## Judgment calls

| Decision                         | Choice and reason                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table or venue columns           | A one-to-one `venue_coordinates` table. Coordinate provenance has its own review lifecycle and version; keeping it separate avoids making every ordinary venue write own a wide set of provider fields while retaining exactly one current coordinate state per venue.                            |
| Pure gate placement              | `packages/core/src/geo-verify.ts`. The gate has no I/O or provider knowledge, and core must call it while the boundary checker forbids core importing `packages/geo`. `packages/geo/src/verify.ts` re-exports the core surface so existing adapter callers and tests retain their API.            |
| Bounds/locality ownership        | Core reads the venue's season row and supplies its bounds/locality on every `locate()` call. Constructor policy remains optional fallback compatibility only. A null season locality stays undefined so an adapter fallback is not replaced with the season display name.                         |
| 30 m policy                      | `MAX_PARCEL_CROSS_CHECK_DISTANCE_M` is a documented core constant. The explicit Goal-1 rule applies only to a parcel candidate: more than 30 m is `needs-review / cross-check-distance`; 30 m or less may verify. The pure gate still computes and returns distance without owning the threshold. |
| Organizer precedence             | Any `organizer-verified` source is provider-proof, including after an address edit has changed its status to `needs-review`. A provider can never replace the organizer's pin; only `verifyVenueCoordinate` resolves it.                                                                          |
| Organizer pin after address edit | Keep the point and its stronger source, but mark it `needs-review / address-changed` and remove it from publication. A hand-placed pin may be wrong after the address moves, but discarding it or downgrading its source would violate AE10.                                                      |
| Provider no-result outcomes      | `not-found` and `refused` are retained as null-point provenance (`pending` and `rejected` respectively). `unavailable` writes nothing and never clears existing state because an outage says nothing about the address. Unexpected rejected port promises also degrade to `unavailable`.          |
| Malformed located point          | Retain provider/ref provenance as `needs-review / invalid-coordinate`, but store a null point pair so a non-finite number cannot fail SQLite binding or become publishable.                                                                                                                       |
| Legacy migration                 | Complete legacy pairs become conservative `geocoded / legacy / pending` rows. A partial legacy pair becomes a null-point `needs-review / invalid-coordinate` row rather than silently disappearing. A venue with no legacy coordinate gets no coordinate row.                                     |
| Concurrent provider writes       | The provider call stays outside a database transaction. After it resolves, the venue/address recheck, organizer-source recheck, and final upsert run in one immediate transaction, closing the final check/write race.                                                                            |
| Placeholder promotion            | Transfer submitted provenance unless it would replace an organizer-owned placeholder pin with a geocoded point. If the promoted address differs, preserve that organizer pin but flag it `address-changed`.                                                                                       |

## Pipeline behavior

`geocodeVenue(venueId, actor)`:

1. Reads the venue address and its season bounds/locality.
2. Preserves any organizer-owned coordinate and skips a verified geocoded cache hit for
   the same trimmed address.
3. Calls `GeoPort.locate()` with the per-season policy.
4. Rechecks the venue after the asynchronous call, then atomically protects organizer
   state and stores the outcome.
5. Runs the core verification gate. Out-of-box, interpolated, imprecise, missing
   cross-check, invalid, and excessive parcel cross-check results enter review rather
   than publication.

`verifyVenueCoordinate(venueId, coordinate, actor, version)` rejects an invalid or
out-of-box organizer pin with the season locality/display name in the error, then stores
an in-box point as `organizer-verified / verified` under the venue version guard.

`listVenuesNeedingCoordinateReview(seasonId)` returns the future admin queue.
`publishableCoordinate(venueId)` returns a point only for a `verified` row.

## Tests added and strengthened

`packages/core/test/geocoding.test.ts` covers all requested named scenarios:

- R29/AE10 regeneration precedence and address-edit invalidation;
- R17 out-of-bounds review storage and non-publication;
- house-only missing cross-check, parcel distance above/below 30 m, and interpolation;
- unavailable/no-write behavior and provider rejection degradation;
- repeat-address caching without another provider call;
- different verdicts for identical addresses under two season boxes;
- organizer pin box checks, verification, and later geocode preservation;
- terminal `not-found`/`refused` provenance;
- null-locality adapter fallback;
- invalid numeric candidate persistence;
- address-edit and organizer-verification races while the provider is pending.

The shared geo contract now requires `locate()`, and the OpenStreetMap suite proves
per-call season policy. Schema tests apply migrations through 0013, seed complete,
partial, and absent legacy points, apply 0014, and verify the backfill, dropped columns,
and foreign keys. Record tests pin organizer precedence during placeholder promotion;
retention tests pin coordinate deletion with private venue data.

## Proof-first red observations

- The widened contract first failed typecheck because `GeoPort` did not yet expose
  `locate()`.
- The schema test first failed because migration `0014` did not exist.
- The core pipeline test first failed because `packages/core/src/geocoding.ts` did not
  exist.
- The first final verification attempt after review fixes stopped at
  `format:check` on the two newly strengthened test files. Prettier fixed only those
  files; the complete chain was restarted and passed.

## Review fixes

A local multi-lens review covered correctness, tests, maintainability, performance,
API contracts, data migration, reliability, deployment, institutional learnings, and
adversarial sequences. It produced these applied fixes:

1. Preserve the adapter's configured/default locality when a season has no locality.
2. Sanitize malformed provider points to a reviewable null pair.
3. Close the organizer/provider final-write race with an immediate transaction.
4. Convert an unexpected rejected port promise into `unavailable`.
5. Add real 0013-to-0014 upgrade coverage, terminal-outcome coverage, pending-provider
   race coverage, and organizer-versus-geocoder promotion coverage.
6. Preserve partial legacy coordinate state in the organizer review queue.

The review did not change the explicitly parcel-only 30 m rule. File-length preferences
had no project rule or concrete failure mode, so they were not treated as defects. The
optional external cross-model route was not used because source disclosure to a
third-party model was not authorized; the local adversarial review ran instead. Its
transient review artifacts are not part of the durable repository handoff.

## Verification results

All commands used Node v24.13.0 through the required PATH prefix. The exact final chain
was:

```text
npm run typecheck: exit 0
npm run lint: exit 0 (0 errors; 2 pre-existing packages/core/src/access.ts warnings)
npm run format:check: exit 0
npm test: exit 0
npm run check:boundaries: exit 0

Test Files  41 passed (41)
Tests       700 passed (700)
Duration    23.64s

OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The explicit trailing `npm run check:boundaries` repeated the two live boundary success
lines and exited 0. The user-provided baseline was 39 files / 671 tests; the final run is
41 files / 700 tests. The branch adds the core geocoding test file and strengthens
existing geo, schema, record, and retention coverage; the supplied checkout already
contained the prior U9 adapter tests.

The first sandboxed full-suite attempt could not bind the existing SMTP test listener
on `127.0.0.1` (`EPERM`). The suite passed when rerun with local-loopback permission. The
SMTP test also prints the existing Node `DEP0123` TLS ServerName/IP deprecation warning;
it does not fail the suite and is outside this unit.

## Deployment and residual findings

- Migration 0014 drops `venues.latitude` and `venues.longitude`. Take a pre-migration
  SQLite backup, do not run mixed old/new application processes against the migrated
  database, and restore that backup for rollback; reverting code alone cannot recreate
  the dropped columns or post-cutover provenance writes.
- Complete legacy coordinates intentionally enter `pending`, so an organizer must
  review them before they are publishable under the new verified-only read.
- Successful Overpass snapshots remain cached for the adapter lifetime. They are keyed
  correctly by season box, but no eviction policy was added; configured season count
  bounds ordinary use, and changing the prior adapter's repeat-fetch guarantee was not
  required for U9C.
- Web composition still defaults to `NullGeoAdapter` unless a caller supplies an
  override. Selecting and configuring the live OpenStreetMap provider is a separate
  composition/deployment decision; this core worker did not add route or boot policy.
- The two pre-existing unused-argument lint warnings and SMTP TLS deprecation warning
  remain unchanged.

## Delivery

- `d6dc883` — `feat(geo): carry season policy through locate calls`
- `a1d2a3f` — `feat(core): persist verified coordinate provenance`
- `4189cf5` — `refactor(core): simplify coordinate persistence paths`
- `ce9a680` — `fix(core): harden coordinate provenance transitions`
- This handoff is committed separately so the documentation commit remains focused.
- No commit was pushed or merged.
