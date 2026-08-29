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
- `packages/geo/src/verify.ts`
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
- the Goal-1 repo's `porchfest/tools/geocode.py`

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
- Provider-unavailable outcomes are never cached. A successful Overpass bulk result is
  reused for the adapter run, while a failed load is released so the next lookup retries.
- The in-memory cache is intentionally not size-limited. Eviction would violate the
  repeat-address no-refetch guarantee; durable lifecycle and retention belong with the
  later database-backed implementation.
- Street suffix and direction aliases are position-sensitive, and leading `St`/`Ste`
  before another word is normalized to `Saint` rather than `Street`.
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
reliability, and adversarial cases. Its initial pass added concurrent cache
deduplication, structurally invalid JSON, and parcel-retention coverage. The final pass
identified five follow-up defects: response-body timeouts, caching a degraded house
fallback, direction-prefixed Saint aliases, reverse locality punctuation, and cache
isolation across lookup policies. An independent validator confirmed all five; they
were fixed with focused regression tests. No actionable finding remains.

The optional external cross-model review could not run because source-code egress was
not approved; a local adversarial review ran instead. No implementation blocker remains.

At the final audit, the local `origin/main` tracking ref was one commit beyond this
branch's supplied `d4ee645` base. No fetch, rebase, or merge was performed because the
worker route requires committing on this branch and stopping; integration should account
for that newer main commit.

## Delivery

- Initial implementation commit: `d88be07` (`feat(geo): locate addresses with OpenStreetMap provenance (U9)`).
- Review-hardening commit: `9636cf8` (`fix(geo): harden OpenStreetMap geocoding`).
- Follow-up review commit: `c56259f` (`fix(geo): address follow-up review findings`).
- This handoff is committed separately so the documentation commit remains focused.
- No commit was pushed or merged.

## Review fixes (2026-08-29)

1. Provider faults are no longer written to `GeocodeCache`, and stale cached
   `unavailable` values are ignored. Failed Overpass loads clear their memoized promise
   so a later lookup retries. Overpass failure no longer prevents the parallel
   Nominatim house lookup; outcomes that depend on that degraded path identify the
   Overpass outage in `reason`. A degraded `located` house outcome is also explicitly
   non-cacheable, so the same address can recover a parcel cross-check after Overpass
   returns.
2. Every Nominatim request now sends `viewbox=20,10,21,11`-ordered deployment bounds
   (`W,S,E,N`) and `bounded=1`. Returned points are independently checked against the
   configured box before ranking; an in-box later result can beat an out-of-box earlier
   result, and an all-out-of-box response is `not-found`.
3. `countryCodes?: string` is a documented adapter option with the default `"us"` and
   is passed through as Nominatim's `countrycodes` parameter.
4. One compiled, trailing-only locality grammar now serves suffix detection, stripping,
   query construction, and normalized cache keys. It accepts optional commas and
   flexible whitespace and treats `Saint`, `St.`, and `St` as aliases for any configured
   suffix without mistaking an interior street name for the locality. Optional commas
   work in both directions, including comma-form input with a comma-free configured
   suffix.
5. Street normalization now applies suffix aliases only at the street-suffix position,
   including before a trailing direction; applies one-letter directions only at an
   endpoint; treats leading `St`/`Ste` as `Saint`; and covers boulevard, drive, court,
   road, lane, and parkway aliases. Submitted street tokens are computed once per
   lookup. The Saint alias begins after an optional leading direction, while
   alias-looking interior tokens remain literal.
6. Address parsing now requires the house number at the beginning and accepts plain,
   letter-suffixed, hyphen-letter, and fractional forms. Unit-prefixed and numberless
   inputs produce a typed refusal whose reason says the adapter could not parse a house
   number.
7. Nominatim results without both an OSM feature type and id are skipped instead of
   receiving a fabricated type-based reference.
8. Overpass ways carrying `addr:interpolation` are skipped. The code records that
   Nominatim interpolation cannot be identified from its response and remains protected
   by the independent cross-check gate.
9. Provider timeouts are split into `overpassTimeoutMs` (180,000 ms default) and
   `nominatimTimeoutMs` (10,000 ms default). Each request uses an abort controller,
   keeps the deadline active through JSON body consumption, clears its timer in
   `finally`, and reports timeout, reachability, HTTP status, and malformed JSON as
   distinct reasons. Never-resolving fetches and stalled response bodies are covered
   with fake timers that also assert the request signal was aborted.
10. Cache read failures are treated as misses, cache write failures are swallowed after
    the provider outcome is obtained, and `locate()` returns an outcome for both cases.
    Concurrent equivalents consult the synchronous in-flight map before awaiting the
    cache. Versioned cache keys include canonical country codes and ordered bounding-box
    coordinates so shared caches cannot cross lookup policies.
11. Bulk Overpass loading and the serial, rate-limited Nominatim request now start
    together. Parcel selection and preferred-ref ranking happen only after both settle,
    preserving rank zero without serializing the network calls.
12. `assertBoundingBox` is exported from `verify.ts` and reused. The lookup computes its
    submitted query once; Overpass parsing returns a nullable point, derives refs from
    kind and id, and uses a flattened Nominatim outcome union with
    `results.every(isStreetLevelNominatimResult)` for the refusal test.
13. This report now uses repo-relative wording for the Goal-1 Python reference, updates
    the superseded cache and alias judgment calls, and records the review-fix evidence,
    including the independently validated follow-up fixes.

The proof-first focused run initially failed 29 assertions for the intended defects.
After implementation, cleanup, and follow-up review fixes, the focused geocoder suite
passed 66/66. The exact
Node v24.13.0 verification chain then passed:

```text
npm run typecheck: exit 0
npm run lint: exit 0 (0 errors; 2 pre-existing packages/core/src/access.ts warnings)
npm run format:check: exit 0
npm test: exit 0; 39 files / 671 tests
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The first sandboxed `npm test` attempt could not bind the SMTP integration test's local
listener (`EPERM` on `127.0.0.1`); the permitted final rerun passed in 22.17 seconds. The
existing Node TLS `ServerName` warning also printed and remained outside this unit.

Review-fix commits: `9636cf8` (`fix(geo): harden OpenStreetMap geocoding`) and
`c56259f` (`fix(geo): address follow-up review findings`).
No requested fix was left incomplete. The two recorded map-route design findings remain
out of scope: the core port was not widened, and boot-time composition was not changed.
No dependency or lockfile changed; no rebase, amend, push, or merge was performed.
