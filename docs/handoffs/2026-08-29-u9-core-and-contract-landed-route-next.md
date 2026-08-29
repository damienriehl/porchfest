---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-29T18:40:00Z"
title: "U6, U7, and three quarters of U9 are on main; the map route (U9D-b) is next; the organizer UAT is Damien's"
summary: "Nine PRs merged on 2026-08-29: U6 (#26), U7 (#27), the U9 map contract at v1.2.0 (#31) then deployment-neutral v1.3.0 with ajv validation (#33), the OSM geocoder (#30), the core geocoding pipeline with coordinate provenance (#34), plus docs (#28, #29, #32). main is 3285ca3 at 733 tests. Next agent: build U9D-b (map JSON route, public Leaflet page, coordinate-review screen, adapter wiring). Human: run docs/operations/organizer-uat.md."
keywords:
  [
    "porchfest",
    "u9",
    "map-route",
    "geocoding",
    "provenance",
    "ajv",
    "uat",
    "u10",
    "node-24",
  ]
resume_focus: "Build U9D-b (map route + public map page + coordinate review + adapter wiring), then U10 import and U11 deploy"
repository: "porchfest"
branch: "main"
head: "3285ca3"
---

# Where things stand

Supersedes `2026-08-29-u9-worker-branches-ready-uat-next.md` (renamed in place;
`git log --follow` keeps the trail). Written at the end of a long autonomous
session; everything below is verified against `main` at `3285ca3`.

## Merged today, in order

| PR            | Unit  | What landed                                                                                                                                                                                   |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #26           | U6    | matching, assignment screens, season transitions                                                                                                                                              |
| #27           | U7    | email waves, review-before-send outbox, SMTP adapter                                                                                                                                          |
| #31           | U9    | venues-map contract in-repo at v1.2.0 + a ten-item review fix pass                                                                                                                            |
| #30           | U9    | OpenStreetMap geocoder (Overpass parcel + Nominatim house behind the gate) + a 13-item review fix pass                                                                                        |
| #33           | U9D-a | contract v1.3.0: deployment-neutral fields, `schema_version` as a v1.x pattern with a code minimum, ajv validation, optional `slot_start`/`slot_end`                                          |
| #34           | U9C   | core geocoding pipeline: widened `GeoPort.locate()`, `venue_coordinates` provenance table (migration 0014), gate moved into core, organizer verification, R29 re-verification on address edit |
| #28, #29, #32 | docs  | handoffs; the admin-records CI timeout investigation (runner stall, no defect, no timeout raised)                                                                                             |

Every code PR had an eight-angle harness review plus the Codex GitHub
reviewer, and a Codex fix worker applied the verified findings before merge.
The worker reports on `main` carry the judgement calls:
`docs/handoffs/worker-u9-geocoder-report.md`, `worker-u9-map-schema-report.md`,
`worker-u9c-core-geocoding-report.md`, `worker-ci-admin-records-timeout-report.md`.

## Damien's decisions today (all implemented)

- Merge #26 and #27; proceed autonomously (2026-08-29 morning).
- Ask `porchfest-2026-08-29-1558-u9-map-contract-decisions`, answered inline:
  **q1** add ajv and validate in the route and tests; **q2** deployment-neutral
  contract v1.3.0 now, the route checks values against the season row;
  **q3** `schema_version` pattern `^1\.\d+\.\d+$` with a code-enforced minimum.
- Standing: U8 is Phase 4 (spring). U9 → U10 → U11 is the fall path.

## What U9D-b must build (the remaining quarter of U9)

Read the plan's `### U9.` test scenarios first — they are the checklist.

- `packages/web/src/routes/map.ts` (registered through the central registry):
  serializes **only** from `publishableCoordinate(venueId)` and the plan's
  published-field allowlist; asserts the digest via `loadVerifiedVenuesMapSchema()`
  and validates with `validateVenuesMapDocument()` before responding; checks
  season/event/slot values against the season row; a draft, future, or archived
  season serves no venue data; publication is an explicit organizer act (there is
  no publication flag yet — design it); no contact email, phone, or organizer
  notes ever appear in the JSON.
- A public Leaflet map page over `packages/map/assets` (the asset now derives its
  hour facet from payload slot labels and intervals).
- An admin coordinate-review screen over `listVenuesNeedingCoordinateReview()`
  (returns every non-verified row: `pending`, `needs-review`, `rejected`, with
  status and code) and `verifyVenueCoordinate()`; a "geocode this season" action
  over `geocodeVenue()`.
- Wire `OpenStreetMapGeoAdapter` in `packages/web/src/composition.ts` behind env
  (today `NullGeoAdapter`; `.env.example` needs the variables — that file is
  denied to agents by default, ask Damien). Bounds and locality now travel per
  call from the season row; pass `userAgent`/`countryCodes` from env.
- Residual: one shared Nominatim throttle from the composition root (policy is
  per IP; the adapter's limiter is per instance).

## Cross-repo work nobody has scheduled

The producer (`porchfest/tools/render.py` in the Goal-1 repo) and the site's
`static/data/` copy are still at v1.1.0. `packages/map/schemas/README.md` has
the catch-up steps. Must happen before U12 cutover; v1.1.0 documents validate
against v1.3.0, so nothing breaks until the platform's route ships.

## Damien's — not an agent's

- **Run the organizer UAT** (`docs/operations/organizer-uat.md`) — closes U5.
- Delete stale remote branches if wanted (`u6-*`, `u7-*`, `u9-*`, `u9c-*`,
  `u9d-*`, `docs-*`, `ci-*`); every one is merged.
- Board: `briefs/on-deck.json` porchfest items are current as of this handoff.

## Traps (all cost time today)

- **Node 24 in every shell**: `export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"`.
  Node 25 makes `better-sqlite3` fail as 347 "regressions". Never `npm rebuild`.
- **Re-install after pulling `main`** — the lockfile gained `ajv`/`ajv-formats`;
  a stale `node_modules` fails two map suites with `Cannot find package 'ajv/dist/2020.js'`.
  Use `npm install --include-workspace-root --workspaces` then `git checkout -- package-lock.json`.
- **Stacked PR after a squash merge goes CONFLICTING** — see
  `docs/solutions/workflow-issues/a-stacked-pr-conflicts-after-its-base-is-squash-merged.md`.
- **The harness `code-review` fork often exits before its finders finish**; the
  finder and verifier results still arrive as task notifications, or sit in the
  fork's transcript. Synthesize from those rather than re-running.
- **Codex worker packets induce what they mention**: a `node --test` line in a
  verification block produced an unwanted dual-runner change. Verify with the
  repo's own commands only.
- **The admin-records 5 s CI timeout** is a runner stall (two occurrences,
  investigated); re-run, do not raise the timeout. A third occurrence earns
  CI-only timing instrumentation around `boot()`.
