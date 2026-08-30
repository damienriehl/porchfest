# U9D-b public map route report

- Date: 2026-08-29
- Branch: `u9d-map-route`
- Status: implemented, reviewed, verified, and committed locally; not pushed or merged

## Outcome

U9D-b now provides the public Leaflet map, its validated JSON feed, organizer
coordinate review and season geocoding, explicit map publication, and production
OpenStreetMap composition. Publication is fail-closed: only a locked, explicitly
published, non-future season can contribute venue data, and only assigned acts at
organizer-verified coordinates are serialized.

No dependency was added. `package-lock.json` was not changed. All fixtures use
invented addresses, `example.invalid` contacts, and synthetic coordinates.

## What was built

### Publication and migration

- Added Drizzle migration `0015_map_publication.sql`, its snapshot, and journal
  entry. Seasons now carry `event_city`, `event_state`, and nullable
  `map_published_at`; the schema migration test covers the added columns.
- Added `publishSeasonMap(seasonId, actor, version)` and
  `unpublishSeasonMap(...)`. Publication is allowed only in `locked`; archival
  clears publication; compare-and-swap versions guard every action.
- Added a locked-season event metadata update so upgraded rows with the migration's
  honest `Unconfigured` placeholders can be repaired before publication. Direct
  publication refuses those placeholders. New setup input fields remain optional
  for programmatic compatibility, while the organizer setup form requires them.

### Public map routes

- Chose `GET /map/data.json` as the single public feed. A per-season public route
  was not added: the public contract is intentionally the current eligible
  publication, while organizer screens remain season-scoped.
- `GET /map/data.json` selects the newest locked, explicitly published season whose
  calendar year has begun in the season timezone. A newer draft does not implicitly
  unpublish an older live season. Setup, signups, assigning, archived, unpublished
  locked, future-only, and no-season deployments emit the valid v1.3.0 empty
  document with `venues: []`.
- The serializer constructs named public fields only. It calls
  `publishableCoordinate(venueId)` for every candidate venue, requires an assigned
  slot, and excludes held slots, withdrawn or superseded acts, withdrawn or
  superseded venues, and non-HTTP(S) links. Season acts are loaded once to avoid an
  act lookup per assignment; coordinate reads remain per venue because the owner
  explicitly required serialization only through `publishableCoordinate`.
- The route verifies the pinned schema through the verified-once loader and runs
  the real AJV validator before sending a body. Digest, generation, or validation
  failure logs the reason and returns a plain 500 without partial venue data.
- Responses are `application/json; charset=utf-8`, set no cookie, and use
  `Cache-Control: public, max-age=300`. Five minutes bounds stale-address exposure
  after withdrawal or unpublication while avoiding a database read on every map
  refresh.

### Public Leaflet page

- Added `GET /map` and registry-owned routes for the platform's existing
  `porchfest-map.js` and `porchfest-map.css` assets.
- Kept the shared map asset rather than forking it. The script now reads
  `data-map-url` from its script tag, then `window.PORCHFEST_MAP_DATA_URL`, and
  finally its original `/data/venues-2026.json` fallback. The site copy therefore
  continues to work unchanged. The catch-up note is recorded in the map schema
  README.
- Leaflet remains dependency-free and loads pinned version 1.9.4 from unpkg with
  integrity and `crossorigin="anonymous"`. The page's CSP permits only the required
  unpkg script/style/font origin and OpenStreetMap tile origin in addition to local
  assets. Route tests assert those directives.
- The initial HTML includes the map container and an honest "No map is published
  yet" state, so an unconfigured deployment renders useful HTML before JavaScript
  and returns 200 rather than a broken page.

### Organizer coordinate review

- Chose the season-scoped coordinate page for publication controls because it is
  where organizers can see whether venue coordinates are publishable. The page
  links back to lifecycle settings and exposes `/map` and `/map/data.json`.
- `GET /seasons/:id/coordinates` lists every non-verified coordinate with venue,
  address, status, rejection meaning, candidate point, and the season bounding box
  named once.
- Per-row verification uses CSRF plus venue version. Inside-box pins leave the list;
  outside-box pins return a 409 naming the box. Addressless rows show a recovery
  instruction instead of an impossible form, and stale direct submissions return a
  domain 409 instead of 500.
- Season geocoding is deliberately sequential. It skips already verified,
  withdrawn, and superseded venues; reports stored, cached, preserved,
  needs-review, and unavailable counts; and degrades legacy adapter-input errors to
  unavailable rather than failing the entire page. The null adapter names
  `GEO_PROVIDER` and disables the button.
- Publish/unpublish controls appear only while locked. The publish form also repairs
  event city/state for migrated rows, shows the current publication timestamp, and
  uses CSRF plus season versioning.

### Geocoder composition

- `.env.example` documents placeholder-only `GEO_PROVIDER`, `GEO_USER_AGENT`,
  `GEO_COUNTRY_CODES`, `GEO_OVERPASS_TIMEOUT_MS`, and
  `GEO_NOMINATIM_TIMEOUT_MS` values.
- An unset provider selects `NullGeoAdapter`. `GEO_PROVIDER=osm` requires
  `GEO_USER_AGENT` and fails boot with a message naming that variable. Country and
  timeout values use the requested defaults from `@porchfest/geo`.
- `createAdapterSet` constructs exactly one OSM adapter and the core runtime receives
  that same object. Composition tests assert identity, so its per-instance Nominatim
  queue is shared throughout one runtime. Repository search found no other runtime
  constructor of `OpenStreetMapGeoAdapter`; another process/runtime could still make
  another instance, so provider compliance across processes assumes one runtime per
  public egress IP.

## Contract judgment

The owner required a valid v1.3.0 empty document. The top-level `venues` minimum was
therefore relaxed and the digest re-pinned while the per-venue `acts` minimum remains
one. A review suggestion to call this v1.4.0 was not applied because it conflicts with
that settled v1.3.0 decision and would make this route fail its specified contract.
The owner-specified actor argument also remains on publication APIs even though this
unit does not add a separate publication-audit table.

## Review hardening

The `ce-work` simplification and structured review passes produced and verified these
additional fixes:

- a newer draft no longer hides an older explicitly published season;
- a future season remains private;
- withdrawn and superseded addresses do not cross the geocoder boundary;
- address removal cannot turn verification into a 500;
- invalid locality text is rejected for new setup and tolerated for legacy geocoding;
- migrated event metadata is repairable and publication refuses placeholders;
- required setup input expansion remains backward compatible;
- assigned acts are indexed from one season-scoped read.

The external cross-model review launch was denied before egress, so no repository
content left the machine. Local correctness, testing, security, API-contract,
migration, reliability, performance, maintainability, adversarial, and learnings
lenses ran instead, followed by an independent validation pass.

## Verification

Every required command used Node v24.13.0 and exited 0 in the final run.

| Gate                       | Exact result                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc --noEmit -p tsconfig.json`; exit 0                                                            |
| `npm run lint`             | exit 0; 0 errors and 2 pre-existing warnings in `packages/core/src/access.ts` at lines 244 and 275 |
| `npm run format:check`     | `All matched files use Prettier code style!`                                                       |
| `npm test`                 | `Test Files 45 passed (45)`; `Tests 779 passed (779)`; exit 0                                      |
| `npm run check:boundaries` | both boundary checks printed `OK`; exit 0                                                          |

`npm test` printed all six required success lines:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The stated baseline was 733 tests. The final suite has 779 tests, a net increase of 46. The final Vitest run covered 45 test files.

The first sandboxed full-suite attempt could not bind the existing SMTP test listener
on `127.0.0.1` and also exposed two expectations superseded by the review hardening.
Those expectations were updated, focused tests passed, and the exact full command was
rerun with local-listener permission. The final run passed without suppressing a test.
The existing SMTP TLS ServerName deprecation warning remains visible and unchanged.

## Residual findings not fixed

- A provider outage can consume the configured Overpass timeout once per eligible
  venue because the explicitly requested geocode-season action is sequential and
  processes the whole season. A circuit breaker, bounded resumable batches, or a
  background job changes the product workflow and needs a separate owner decision.
- The five-minute public cache deliberately permits a withdrawn or unpublished map to
  remain in a browser or shared cache for up to five minutes. No purge mechanism was
  added.
- If unpkg accepts a connection and stalls indefinitely, browser script ordering can
  delay the local map bootstrap and its visible missing-Leaflet error. Self-hosting or
  a local timeout-owning loader is a separate reliability enhancement.
- Publication can succeed before proving that every current record will serialize into
  a valid document. The public route still fails closed with 500 for malformed legacy
  or imported records; a publication preflight policy was not specified.
- The Nominatim throttle is shared per adapter instance, not across independent
  processes that share one public IP.

## Operational validation

After deployment, verify `/map` returns HTML, `/map/data.json` returns a schema-valid
empty document before publication, and a synthetic locked publication appears only
after the explicit action. Monitor map-data 500 logs for digest or schema validation
reasons, organizer geocode request duration, provider timeout counts, and unexpected
Nominatim request frequency. Rollback is the normal application rollback plus
unpublication; migration 0015 is additive and its nullable publication column may
remain in place.

## Commits and handoff state

- `39924ee` - `feat(core): add explicit season map publication`
- `447f815` - `feat(web): configure the shared geocoder adapter`
- `90e7dfd` - `feat(web): serve the published public map`
- `409b1f8` - `feat(web): add coordinate review and map controls`
- `e656452` - `fix(map): harden publication and coordinate review`

This report is intended for one final focused documentation commit. Nothing was
pushed or merged.

## Review-fix commits

This section records the PR #36 review-fix packet and supersedes the earlier
contract-judgment, residual-finding, verification-count, and handoff-state text
where they conflict.

- 1 -> `0ea1a37` (`fix(map): serialize slots in local chronological order`)
- 2 -> `0ea1a37` (`fix(map): serialize slots in local chronological order`)
- 3 -> `5cb1927` (`fix(core): publish map metadata atomically`)
- 4 -> `5743f86` (`fix(geocoding): bound and guard season batches`)
- 5 -> `5743f86` (`fix(geocoding): bound and guard season batches`),
  `45a278c` (`fix(geocoding): continue bounded season batches`), and
  `820a6ef` (`fix(review): bound slow geocoding requests`)
- 6 -> `c9a50c8` (`fix(map): preflight organizer publication`)
- 7 -> `c9a50c8` (`fix(map): preflight organizer publication`)
- 8 -> `ac2b53d` (`fix(web): declare the map workspace dependency`)
- 9 -> `b8528c8` (`fix(web): clarify map publication form state`)
- 10 -> `b8528c8` (`fix(web): clarify map publication form state`)
- 11 -> `26573c5` (`fix(map): version empty venue schema as 1.3.1`)
- 12 -> `e93ea45` (`perf(map): batch publishable season coordinates`)
- 13 -> `ee89a91` (`refactor(web): share public link parsing`)
- 14 -> `986913e` (`refactor(web): share admin route helpers`)
- 15 -> `8d01b91` (`refactor(core): share season bounding boxes`)
- 16 -> `ee89a91` (`refactor(web): share public link parsing`)
- 17 -> `5cb1927` (`fix(core): publish map metadata atomically`)
- 18 -> accepted as-is; no code change.

Two additional commits preserve the requested behavior after the simplification
and review gates: `82cda26` (`refactor(map): simplify review fix internals`) and
`5da4a9e` (`fix(web): preserve route boundary checks`). The simplification pass
applied all 3 reuse, 4 quality, and 3 efficiency recommendations; the overlapping
recommendations were consolidated rather than duplicated.

### Review-fix decisions

- The shared published-map builder remains in `packages/web`. It combines route
  publication policy, public serialization, and schema diagnostics; moving it into
  core would invert the existing core-to-adapter boundary.
- Schema v1.3.1 keeps the existing v1-family `$id` and filename. The title,
  description, exported version constant, digest, and README catch-up history carry
  the patch-version change, while the minimum accepted producer version remains
  v1.1.0.
- Link tokens use WHATWG-normalized `url.toString()` output. Signup rejects a field
  containing any bad token; public serialization deliberately drops only bad legacy
  tokens.
- No compatibility overload was retained for the removed publication `actor`
  argument or unused `updateSeasonMapEvent`; item 17 explicitly required that API
  cleanup, and repository search found no remaining caller.
- The 20-venue geocode batch uses a continuation cursor so unavailable early venues
  cannot starve later venues. A structured adversarial review also proved that an
  Overpass outage could otherwise repeat its 180-second timeout for every venue, so
  the request now returns after a 45-second budget while retaining the per-season
  guard until the single in-flight provider operation settles.
- The cross-model adversarial launch was denied before external egress. No repository
  content left the machine; the local adversarial reviewer and an independent
  validator covered that lens instead.
- `package-lock.json` changes only the `packages/web` dependency entry, adding
  `@porchfest/map`; no other lockfile content moved.

### Review-fix verification

Every required command used Node v24.13.0 and exited 0 in the final run.

| Gate                       | Exact result                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc --noEmit -p tsconfig.json`; exit 0                                                             |
| `npm run lint`             | exit 0; 0 errors and 2 pre-existing warnings in `packages/core/src/access.ts` at lines 244 and 275  |
| `npm run format:check`     | `All matched files use Prettier code style!`                                                        |
| `npm test`                 | `Test Files 45 passed (45)`; `Tests 792 passed (792)`; exit 0; all six required `OK:` lines printed |
| `npm run check:boundaries` | both boundary checks printed `OK`; exit 0                                                           |

The stated branch baseline was 45 files and 779 tests. The review-fix packet finishes
at 45 files and 792 tests, a net increase of 13 tests. The first sandboxed full-suite
attempt could not bind the existing SMTP listener on `127.0.0.1`; the required
command was rerun with loopback-listener permission and passed without suppressing a
test. Nothing in this review-fix packet was pushed, rebased, amended, squashed, or
merged.
