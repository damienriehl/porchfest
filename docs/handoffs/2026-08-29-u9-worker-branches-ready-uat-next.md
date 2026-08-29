---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-29T15:35:00Z"
title: "U6/U7 on main; both U9 worker branches built and verified, unreviewed; the organizer UAT is Damien's"
summary: "main is 59139ae (605 tests). The two U9 Codex workers re-dispatched today finished clean — u9-nominatim-geocoder (635 tests) and u9-map-schema-v1-2-0 (610 tests), two commits each, unpushed and unreviewed. Next agent: review both, push, PR, then U9's map route. Human: run docs/operations/organizer-uat.md."
keywords:
  [
    "porchfest",
    "u9",
    "geocoder",
    "map-schema",
    "review",
    "uat",
    "u6",
    "u7",
    "node-24",
  ]
resume_focus: "Review and land the two U9 worker branches (geocoder, map-schema), then U9's map route; the organizer UAT runs whenever Damien has a tester"
repository: "porchfest"
branch: "main"
head: "59139ae"
---

# Where things stand

Supersedes `2026-08-29-u6-u7-merged-uat-and-u9.md`, written an hour earlier
in this same session while the U9 workers were still running (renamed in
place; `git log --follow` keeps the trail). Everything below it is current as
of 15:30 UTC.

## The two U9 worker branches — built, verified, NOT reviewed, NOT pushed

Both Codex workers completed within the hour. Each branch is two commits on
`d4ee645` (a feature commit + its worker report), one commit behind `main`
(`59139ae`, docs only), worktree clean, nothing pushed — exactly as instructed.

| Branch                  | Feature commit                                                      | Worker report (on the branch)                  | Its own gate                              |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `u9-nominatim-geocoder` | `d88be07` feat(geo): locate addresses with OpenStreetMap provenance | `docs/handoffs/worker-u9-geocoder-report.md`   | 39 files / **635** tests, six `OK:` lines |
| `u9-map-schema-v1-2-0`  | `2c6a1c1` feat(map): pin the venues-map v1.2.0 contract             | `docs/handoffs/worker-u9-map-schema-report.md` | 39 files / **610** tests, six `OK:` lines |

Both reports are the worker's own account — read them as evidence, not
verdicts. What each report flags as _not done_ (their words, their
judgement):

- **Geocoder:** the `GeocodeCache` is an in-memory seam; the DB-backed cache
  the plan wants is a later migration. A house-only result is emitted with no
  cross-check so `verifyGeocodedCoordinate` refuses it — deliberate, tested.
  Nothing in `packages/core` or `packages/web` touched; no route wiring.
- **Map schema:** three findings to carry forward — the schema's Goal-1
  consts (date, city, state, bounding box) block any other deployment; U9's
  map route still needs a JSON-Schema validator decision (none in the repo,
  adding one is a dependency decision); local pins cannot prove parity with
  the producer and site copies, which stay at v1.1.0. Final digest
  `ead84ab7…f8f5e4`; `packages/map/schemas/` is prettier-ignored on purpose.

They touch disjoint packages (`geo` vs `map`) and can land in either order.
Neither has had the harness review or the Codex GitHub review that U6 and U7
got; that is the next agent's first job. Nothing here was decided by Damien
beyond the two 2026-08-24 answers the specs implement (ask
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`: OSM/Nominatim;
widen `generated_from` in a v1.2.0).

## Merged today

- **PR #26 (U6)** → `ab66025`, squash. **PR #27 (U7)** → `d4ee645`, squash.
- #27 went CONFLICTING the moment #26 was squashed; resolved with a verified
  `-s ours` merge, full gate green (605 tests, 38 files), CI green, merged.
  How and why: `docs/solutions/workflow-issues/a-stacked-pr-conflicts-after-its-base-is-squash-merged.md`.
- Branches `u6-assignment-and-season-transitions` and `u7-email-waves-and-outbox`
  still exist on the remote — deletion is Damien's call.
- `main` boots per `docs/operations/organizer-uat.md` (bootstrap link printed
  to the log; `/admin` and the outbox answer 401 unauthenticated). Note for
  the UAT observer: `/` has no route and returns 404 — the tester's first
  URL is the bootstrap link in the log, by design.

## Damien's — not an agent's

**Run the organizer UAT** (`docs/operations/organizer-uat.md`). It needs a
tester other than Damien and an observer; it closes U5's DoD. Leave email
unconfigured so task 5 exercises export. Nothing an agent can do here except
fix findings afterwards.

## How the U9 branches came to exist

The on-deck board had said U9 was "In Motion" since 2026-08-24. It was not:
both Codex workers had `state: failed` at "Starting worker" with empty logs.
Today they were fast-forwarded to `d4ee645`, their specs re-based (base
commit, 605-test baseline, Node 25 warning, "map route no longer blocked on
U6"), re-dispatched through the cockpit's `agents/worker-wrapper.sh`, and
completed on the first run:

| Worker id                 | Branch                  | Spec (cockpit)                                    | Delivers                                                                                                                                                                |
| ------------------------- | ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `porchfest-u9-geocoder`   | `u9-nominatim-geocoder` | `agents/tasks/porchfest-u9-nominatim-geocoder.md` | `packages/geo/src/geocode.ts` — Overpass parcel + Nominatim house cascade behind `verify.ts`; in-memory cache seam; report `docs/handoffs/worker-u9-geocoder-report.md` |
| `porchfest-u9-map-schema` | `u9-map-schema-v1-2-0`  | `agents/tasks/porchfest-u9-map-schema-v120.md`    | `packages/map/schemas/` at v1.2.0 with `generated_from` enum, pin, `contract.ts`, README; report `docs/handoffs/worker-u9-map-schema-report.md`                         |

Both were told: commit on the branch, do not push, write a worker report.
Damien's decisions they implement: ask
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`, `q1-geocoding-provider`
= Nominatim/OpenStreetMap, `q2-map-schema-generated-from` = widen in a v1.2.0.

After both land, U9's remaining half is the map route
(`packages/web/src/routes/map.ts` + a public Leaflet map page over the same
JSON), which needs both branches and the validator decision above.

## Order of the plan from here

U9 (map data) → U10 (2026 import) → U11 (Hetzner deploy + shakedown) are
Phase 3 and the fall critical path. **U8 is Phase 4** — the prior handoff
named it next; the plan
(`docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md`, "Four phases")
does not.

## Residuals still open (all P3, recorded on PR #27)

`mutationRefusal` maps every lifecycle refusal to 409; `findWave` scans every
season; TLS handshakes flag-tested only; `NoneEmailAdapter` naming; no direct
test of `recorded === false`.

## Traps

- **Node 24 in every shell** — `export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"`.
  The box default is v25 and `better-sqlite3` is built for 24: 347 failures
  that read like a total regression. Never `npm rebuild`.
- **Never delete the base branch of a stacked PR at merge time**; retarget
  the upper PR with `gh pr edit N --base main` and expect CONFLICTING —
  see the solution doc above.
- **Trailer rebases break the ce-work controller's ancestry check**; add
  trailers at commit time.
