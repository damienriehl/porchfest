---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-29T14:30:00Z"
title: "U6 and U7 are on main; the organizer UAT is Damien's; U9 workers re-dispatched"
summary: "PR #26 (U6) and PR #27 (U7) merged 2026-08-29 — main is d4ee645 at 605 tests. The human UAT that closes U5 is ready to run and needs a tester. U9's two Codex workers (OSM geocoder, venues-map contract v1.2.0) had died at launch on 2026-08-24 and were re-dispatched on today's main; harvest their branches next. U8 is Phase 4 (spring), not next."
keywords:
  [
    "porchfest",
    "u6",
    "u7",
    "u9",
    "uat",
    "geocoder",
    "map-schema",
    "squash-stack",
    "node-24",
  ]
resume_focus: "Harvest the two U9 worker branches (review, integrate, PR); run or schedule the organizer UAT; then U9's map route and U10/U11"
repository: "porchfest"
branch: "main"
head: "d4ee645"
---

# Where things stand

Supersedes `2026-08-29-u7-built-verify-and-pr.md` (deleted in the same commit;
`git log --diff-filter=D -- docs/handoffs/` recovers it). Its step 1 is done;
its steps 2–4 are carried here, with U8 corrected to U9.

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

## U9 — two workers re-dispatched on 2026-08-29

The on-deck board said U9 was "In Motion" since 2026-08-24. It was not: both
Codex workers had `state: failed` at "Starting worker" with empty logs — they
never ran. Today they were fast-forwarded to `d4ee645`, their specs re-based
(base commit, 605-test baseline, Node 25 warning, "map route no longer
blocked on U6"), and re-dispatched through the cockpit's `agents/worker-wrapper.sh`:

| Worker id                 | Branch                  | Spec (cockpit)                                    | Delivers                                                                                                                                                                |
| ------------------------- | ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `porchfest-u9-geocoder`   | `u9-nominatim-geocoder` | `agents/tasks/porchfest-u9-nominatim-geocoder.md` | `packages/geo/src/geocode.ts` — Overpass parcel + Nominatim house cascade behind `verify.ts`; in-memory cache seam; report `docs/handoffs/worker-u9-geocoder-report.md` |
| `porchfest-u9-map-schema` | `u9-map-schema-v1-2-0`  | `agents/tasks/porchfest-u9-map-schema-v120.md`    | `packages/map/schemas/` at v1.2.0 with `generated_from` enum, pin, `contract.ts`, README; report `docs/handoffs/worker-u9-map-schema-report.md`                         |

Both were told: commit on the branch, do not push, write a worker report.
Damien's decisions they implement: ask
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`, `q1-geocoding-provider`
= Nominatim/OpenStreetMap, `q2-map-schema-generated-from` = widen in a v1.2.0.

**Next session:** read `agents/events.log` for their completion, read each
worker report, review the branches (harness review + Codex review as with
U6/U7), push, open PRs against `main`. They touch disjoint packages
(`geo` vs `map`) and can land in either order. After them, U9's remaining
half is the map route (`packages/web/src/routes/map.ts` + public map page),
which needs both.

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
