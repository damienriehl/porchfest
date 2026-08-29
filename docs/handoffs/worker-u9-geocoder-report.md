# U9 OpenStreetMap geocoder report

Date: 2026-08-29
Branch: `u9-nominatim-geocoder`
Status: implemented, reviewed, and locally verified; committed locally but not pushed or merged

## Outcome

- Added `OpenStreetMapGeoAdapter`, a configured `GeoPort` implementation whose narrow
  `geocode()` method projects the richer `locate()` outcome to `Coordinates | null`.
- Added one lazy Overpass address-point query per adapter run. It uses caller-provided
  season bounds, indexes valid address points by normalized house number, prefers ways
  over nodes, and resolves remaining ties by the lowest element id.
- Added Nominatim house lookup with deterministic ranking. A matching parcel feature ref
  outranks address and result-type matches; street-level features are never ranked as
  coordinates.
- Added parcel/house combination behavior and complete provenance. Parcel results carry
  `precision: "parcel"`, house results carry `precision: "house"`, all produced results
  are non-interpolated, and OSM feature refs are retained.
- Added the required Nominatim usage-policy protections: a descriptive `User-Agent`, an
  injected clock and wait function enforcing one request per second, a repeat-address
  cache, and an explicit abort timeout on every provider request.
- Added directly testable address query, parsing, and street-matching helpers, including
  a typed parse failure.
- Re-exported the public geocoder surface from `@porchfest/geo` without changing core,
  web, route wiring, or the database schema.
- Added no dependency and did not change `package-lock.json`.

## Files changed

- `packages/geo/src/geocode.ts`
- `packages/geo/src/index.ts`
- `packages/geo/test/geocode.test.ts`
- `docs/handoffs/worker-u9-geocoder-report.md`

`behavior_changed`: `true`

## Existing tests, sources, and conventions inspected

- `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` (`U9`)
- `packages/geo/src/verify.ts`
- `packages/geo/src/index.ts`
- `packages/geo/test/contract.ts`
- `packages/geo/test/verify.test.ts`
- `packages/core/src/ports/geo.ts`
- `packages/antibot/src/turnstile.ts`
- `packages/antibot/test/turnstile.test.ts`
- `~/worktrees/woodshed-porchfest/porchfest/tools/geocode.py`

The Turnstile adapter's dependency-injection, timeout, and outcome patterns were reused.
The committed verification gate remains the authority for deciding whether a located
candidate is publishable.

## Tests added

`packages/geo/test/geocode.test.ts` contains 30 tests covering:

- the shared `geoPortContract`;
- parcel selection, parcel/house cross-checking, way precedence, and lowest-id ties;
- refusal for a `highway` category, `residential` type, and road addresstype;
- preferred-feature-ref ranking over an earlier house-typed result;
- the house-only/no-cross-check path through `verifyGeocodedCoordinate`;
- address suffixing/parsing and all requested alias/direction street matches;
- the one-second Nominatim interval, repeat-address caching, and concurrent in-flight
  deduplication;
- network throws, non-2xx responses, malformed JSON, and valid JSON of the wrong shape;
- retaining a valid parcel result when Nominatim is unavailable.

All test addresses, hostnames, and coordinates are synthetic. The focused final run was:

```text
Test Files  1 passed (1)
Tests       30 passed (30)
```

## Proof-first red observation

The focused test file was written before the production adapter. Its first run failed
21/21 tests because the new exports and implementation did not yet exist. After the
implementation and review-driven additions, the focused suite passed 30/30.

## Verification results

All npm commands used Node v24.13.0 through the required PATH prefix.

- `npm run typecheck`: exit 0; no errors.
- `npm run lint`: exit 0; 0 errors and 2 pre-existing warnings in
  `packages/core/src/access.ts` (unused `stamp` at 244:47 and 275:5).
- `npm run format:check`: exit 0; all matched files used Prettier formatting.
- `git diff --check`: exit 0; no whitespace errors.
- `npm test`: exit 0 with 39 test files and 635 tests passing in 17.08 seconds.

The required policy gates printed exactly six success lines:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The reported baseline was 38 files and 605 tests. This change accounts for the exact
difference: one new test file and 30 new tests, producing 39 files and 635 tests.

The first sandboxed full-suite attempt was unable to bind the existing SMTP test's local
listener (`EPERM` on `127.0.0.1`). The same command was rerun with the required local
socket permission and passed. An existing Node TLS warning about an IP address as
`ServerName` also printed during that SMTP test; it did not fail the suite and was not
changed because it is outside this package and task.

## Judgment calls

- `geocode()` remains exactly the requested narrowing of `locate()`: any `located`
  outcome becomes coordinates. It does not silently run the verification gate. Rich
  callers use `locate()` and pass its candidate and cross-check to the gate.
- A house-only Nominatim result is deliberately emitted as `located` with
  `crossCheck: null`. `verifyGeocodedCoordinate` then rejects it with
  `cross-check-missing`. This is correct: Nominatim is not an independent corroborating
  source for itself, so the organizer must place the pin manually.
- A `residential` result is refused even if another provider field describes it as a
  building, because the settled street-level type list explicitly includes
  `residential`.
- Provider-unavailable outcomes are cached, and one failed Overpass bulk request is not
  retried within the adapter run. This preserves the requirements that a repeated
  address never re-fetches and Overpass is queried only once per run.
- The in-memory cache is intentionally not size-limited. Eviction would violate the
  repeat-address no-refetch guarantee; durable lifecycle and retention belong with the
  later database-backed implementation.
- The aliases are applied exactly as specified, including `st -> street`; no
  position-sensitive interpretation of `St` as `Saint` was introduced.
- Provider URLs remain the selected public OSM endpoints. Adding mirror configuration,
  a deployment-wide coordinator, or route composition would widen this adapter-only
  slice.
- When Nominatim returns both irrelevant non-street results and street results, the
  outcome is `not-found`; `refused` is reserved for the specified "only street-level
  results" case.

## Database-cache seam left for later

`GeocodeCache` is the persistence seam: asynchronous `get(key)` and `set(key, value)`
methods operate on the normalized address key. `InMemoryGeocodeCache` is the shipped
default. The plan's database-backed cache and its migration are explicitly deferred;
this task did not touch core storage or the database schema.

## Goal-1 behavior deliberately not ported

- The US Census tier was omitted. It interpolates street-centerline coordinates, the
  verification gate rejects interpolation, and the owner selected OSM only.
- The Python tool's JSON-file cache, venue enumeration, all-or-nothing cache rewrite,
  CLI output, and executable `main` orchestration were omitted. This TypeScript package
  provides an injected adapter and cache seam instead.
- Hardcoded city bounds and locality were omitted. Bounds are required constructor data
  from the season; the locality suffix is configurable with the requested default.
- In-box publication checks and cross-check distance calculations were not duplicated.
  The existing `verifyGeocodedCoordinate` gate owns those decisions.
- Python-specific recognized-source strings and persistence encoding were not ported;
  candidates instead use the existing typed provenance fields and OSM feature refs.

## Review and residual findings

A local multi-lens review covered correctness, tests, maintainability, performance,
reliability, and adversarial cases. It found three worthwhile test gaps—concurrent cache
deduplication, structurally invalid JSON, and parcel retention during a Nominatim
failure—which were added. Suggested production changes that conflicted with the settled
requirements or widened scope are recorded under judgment calls above. The final review
had no actionable finding and a ready-to-merge verdict.

The optional external cross-model review could not run because source-code egress was
not approved; a local adversarial review ran instead. No implementation blocker remains.

At the final audit, the local `origin/main` tracking ref was one commit beyond this
branch's supplied `d4ee645` base. No fetch, rebase, or merge was performed because the
worker route requires committing on this branch and stopping; integration should account
for that newer main commit.

## Delivery

- Implementation commit: `d88be07` (`feat(geo): locate addresses with OpenStreetMap provenance (U9)`).
- This handoff is committed separately so the documentation commit remains focused.
- Neither commit was pushed or merged.
