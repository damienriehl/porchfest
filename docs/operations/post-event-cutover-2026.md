# 2026 post-event cutover — 2026-09-07

## Purpose and when to run

Run this procedure only after the 2026-09-16 event has ended and before 2027
signups open. It moves the 2026 platform from a live season with an unpublished
map to a locked season with a published map, then changes the separate
`sapporchfest-site` marketing site from hand-edited map JSON and Google links to
platform forms and platform-generated map data.

The owner makes every irreversible or editorial decision in this procedure:
whether the last pending performer is placed or dropped, whether each of the
three coordinates in the review queue is verified or left out, and when the
season is locked. The decision to leave U12 unmerged until after the event was
repeated on 2026-09-04 and 2026-09-06; do not use this runbook to cut over
early. Verification of the three review coordinates was offered before
cutover but never authorized, so their disposition still requires a fresh
owner decision here.

The required order is:

1. resolve or deliberately leave the coordinate-review items;
2. resolve or drop every pending placement;
3. lock the 2026 season;
4. publish and verify the platform map;
5. merge `sapporchfest-site` PR #2;
6. pull the published platform data, validate it, push it, and verify the live
   marketing site.

Do not reverse steps 3–6. The site's pull rejects the platform's unpublished
sentinel because its season is 2000, not 2026. Consequently, the pull can
succeed only after the platform map is locked and published.

The platform behavior in this runbook comes from
`packages/core/src/season.ts`,
`packages/web/src/routes/season-lifecycle.ts`,
`packages/web/src/views/season-lifecycle.ts`,
`packages/web/src/routes/admin-records.ts`,
`packages/web/src/views/admin-records.ts`,
`packages/web/src/routes/assign.ts`,
`packages/web/src/views/assign-act.ts`,
`packages/web/src/views/assign-venue.ts`,
`packages/web/src/routes/coordinates.ts`,
`packages/web/src/views/coordinates.ts`, and
`packages/web/src/routes/map.ts`. U12 and R18 are recorded in
`docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md`.

## Preconditions checklist

Do not begin until every box is true.

- [ ] The 2026-09-16 event is over, and the owner has authorized the cutover.
- [ ] The pending performer described under “Pending at time of writing” in
      `docs/operations/late-submissions-map-bridge.md` has either received an
      owner-approved platform placement or been explicitly dropped. No guessed
      match and no marketing-site-only placement is acceptable. Locking
      prevents later assignment into an open slot.
- [ ] Every owner-approved venue, act, and placement added through the
      hand-edit bridge now exists in the platform and agrees with the current
      marketing-site lineup. From `/admin?season=<season-id>`, use “Add an act
      without a submission” or “Add a venue without a submission” for a missing
      record, then use “Find a porch” or “Assign acts” to reach
      `/admin/acts/<act-id>/assign` or `/admin/venues/<venue-id>/assign`.
      “Create placeholder” posts the missing record through
      `/admin/placeholders/act` or `/admin/placeholders/venue`; assignment posts
      through `/admin/slots/<slot-id>/assign`. Confirm each venue slot reads
      “Assigned” and each act's “Current assignment” is correct. Do this before
      lock: placeholder records can still be corrected in `locked`, but
      assignments cannot. Keep any participant contact values in the platform
      and private operational record, not in this repository.
      _Status 2026-09-07:_ the first bridge (1528 Grantham, two acts) is
      entered — platform venue 26, acts 34 and 35, both slots assigned, the
      coordinate organizer-verified against the site JSON point. Only a second
      bridge, if one lands, still needs this step.
- [ ] The owner has decided separately for each of the three
      `nominatim-house` / `cross-check-missing` coordinate rows recorded in
      `docs/operations/season-import-2026-09-03.md`: verify the candidate (or a
      corrected point), or leave that venue off the platform map.
- [ ] Record the expected platform venue count. Count unique active,
      non-superseded venues that have a nonblank address, a verified coordinate,
      and at least one assigned active, non-superseded act. Exclude each of the
      three review rows left unverified. This is the exact inclusion logic in
      `packages/web/src/routes/map.ts`; an open or held slot contributes no act,
      and a venue with no publishable act is omitted.
- [ ] A current, verified production archive and encrypted off-site copy exist,
      and the latest restore-rehearsal result is known, as required by
      `docs/deploy.md`. For a manual backup, run `bash deploy/archive.sh` and
      then run `bash deploy/offsite.sh` every time; the standalone archive
      command never invokes the off-site step. Alternatively, use evidence from
      a successful full `bash deploy/deploy.sh` gate run with
      `PORCHFEST_DEPLOY_OFFSITE=1`, which is the flow that conditionally invokes
      the off-site step. Confirm both archive and off-site evidence rather than
      treating file existence as a successful backup.
- [ ] Platform health, organizer queue, current season, map publication state,
      provider state, retention counts, and restore-rehearsal date pass the
      “After every deploy” checks in `docs/deploy.md`. If a deploy is needed
      before cutover, complete its full gate before changing season state.
- [ ] The separate `sapporchfest-site` checkout is clean, is on `main`, and is
      up to date. It has no CI; a push to `main` causes Railway to deploy.
- [ ] `sapporchfest-site` PR #2 is still the reviewed draft rebased onto `main`
      on 2026-09-04, and its diff still matches U12: both signup links change to
      the platform, My Maps is removed, and the fail-safe pull script is added.

## Step-by-step cutover

### 1. Resolve the coordinate review queue, or accept the omission

What to do: sign in as an organizer and open the 2026 season's
`/admin/seasons/<season-id>` page. Follow “Coordinate review & map publication”
to `GET /seasons/<season-id>/coordinates`. Under “Coordinates needing review,”
the three imported rows should show status `needs-review`, reason
“A house-level result is missing an independent cross-check,” and their
candidate latitude and longitude. The import record establishes those three as
the expected baseline. If later work added more review rows, stop and obtain an
owner decision for each of them too; do not treat an unfamiliar row as approved
by the decision about the original three.

For each row, follow the owner's decision:

- To verify it, independently inspect the address and point, correct the
  prefilled “Latitude” and “Longitude” values if necessary, and click
  “Verify pin.” The form posts to
  `/seasons/<season-id>/coordinates/<venue-id>/verify`.
- To leave it out, do nothing. Record that decision and subtract the venue from
  the expected count if it would otherwise have an assigned publishable act.

What the code does: `verifyVenueCoordinate` requires a venue address and a
complete season bounding box, rejects an invalid or out-of-bounds point, and
stores an accepted point as source `organizer-verified`, status `verified`.
Clicking “Verify pin” is therefore an organizer verification, even when the
unchanged provider candidate is submitted; it is not an automatic acceptance
of the old provenance. The organizer route uses a venue-version guard and asks
for a refresh if someone changed the venue concurrently.

A `needs-review` row does not block the map's publication preflight by itself.
It is absent from `publishableCoordinatesForSeason`, however, so
`packages/web/src/routes/map.ts` suppresses that venue's pin and lineup. It is
not published with a warning. Publication can fail when map generation or
serialization throws, including when an assigned slot has no current act or
does not match a configured season time slot; when no venue has both a verified
coordinate and a publishable assigned act; or when the generated document
fails schema validation. The publication route and core can also reject an
invalid or stale season version, a season not in `locked`, or blank or
unconfigured event city or state metadata.

Check: after each successful verification, the browser returns to
`/seasons/<season-id>/coordinates` and that venue disappears from “Coordinates
needing review.” When all review rows were approved, the section reads “No
stored coordinates need review.” When any were intentionally left alone,
confirm they remain in the table and in the written omission list. Recalculate
and record the expected venue count.

Back out: an unverified row has not changed and can be verified later with
owner approval. There is no organizer control that turns a newly verified
point back into its former `needs-review` provider record. The manual-entry
form can replace a verified point with another verified point, but exact
restoration of the prior review state requires restoring data from backup and
is not a routine backout. Stop and investigate before verification if the
point is uncertain.

### 2. Lock the 2026 season

What to do: first confirm the pending performer has been placed or explicitly
dropped, confirm every bridge-era venue and act has been reconciled into the
platform, and review all remaining open and held slots. A generated site pull
will remove a bridge entry that exists only in the old hand-edited JSON. On
`GET /admin/seasons/<season-id>`, the page title is “Season settings & state.”
Under “Available forward transitions,” find “Move to locked,” select “I confirm
moving this season to locked,” and click “Move to locked.” The form posts to
`POST /admin/seasons/<season-id>/transition` with target state `locked`.

The state order in `packages/core/src/season.ts` is `setup`, `signups_open`,
`signups_closed`, `assigning`, `locked`, `archived`. Transitions are
forward-only and may skip intermediate states. The lock is the move to
`locked`; from there, the only later state is `archived`.

What the code does: locking stops public signups, assigning acts to slots, and
holding slots. It still permits record correction and releasing holds. A
critical precision: the transition does not rewrite an `open` slot to another
slot state and does not delete it. Open slots remain marked `open`, but the
`locked` state forbids the assignment and hold actions that could fill them.
That is why the six open slots were operationally “closed” by a lock even
though their stored state stays `open`. Held slots also remain held; unlike
archiving, locking does not require them to be released.

Check: the redirected page shows “Season moved to locked.” and “Current state”
shows `locked`. “Move to locked” is no longer available. Refresh the organizer
queue and confirm the season is still populated; `docs/deploy.md` treats an
empty-looking season as a failed state even when health is 200.

Back out: **there is no application backout. The lock is irreversible.** Both
the route and core reject a transition to the same or an earlier state. Do not
describe a production database restore as an undo button: restoring a
pre-lock archive is disaster recovery that also discards subsequent production
changes. The `deploy/rollback.sh` process in `docs/deploy.md` rolls back a
release image and, when migrations require it, restores matching archived
data; it is not a logical season-state reversal. Stop before clicking if
placements or owner authorization are not final.

Do not move the season to `archived` during this cutover. Archiving requires all
held slots to be released, disables core record/assignment correction and hold
release, and clears the 2026 map publication timestamp. Coordinate verification
is an exception: its organizer route and core mutation have no season-state
check, and the coordinates page continues to expose verification forms for an
archived season. After archival, the public endpoint serves the first other
eligible locked, published, nonfuture season in newest-first order; it returns
the season-2000 unpublished sentinel only when no such season remains.

### 3. Publish and verify the platform map

What to do: return to
`GET /seasons/<season-id>/coordinates`. The “Public map” section now exposes
links to `/map` and `/map/data.json`, event-city and event-state fields when
unpublished, and a “Publish map” button. Confirm the event city and state or
region, then click “Publish map.” The form posts to
`POST /seasons/<season-id>/map/publish`.

What the code does: the publish action requires all of the following:

- the season state is exactly `locked`;
- a valid, current season version;
- nonblank, configured event city and state or region; and
- a successful map-document preflight.

The successful mutation then sets `mapPublishedAt`. It may publish a future
locked season. Separately, the public endpoint scans seasons newest-first and
serves the first one that is `locked`, has a non-null `mapPublishedAt`, and has
a year no later than the current year in that season's timezone. A future
publication therefore remains unserved until 1 January of its season year, as
the coordinates page states.

The publication preflight builds and validates the same map document served to
the public. It refuses an empty document with “No venue has a verified
coordinate and an assigned act,” refuses schema-invalid data, and requires
nonblank event city and state/region. For a published document, the map route
includes only active, non-superseded venues with an address, a verified
coordinate, and at least one assigned active, non-superseded act. Tentative
record status is not separately excluded by this serializer.

While no eligible season is published, `GET /map/data.json` returns HTTP 200
with the valid sentinel document from `packages/web/src/routes/map.ts`:
schema version 1.3.1, season 2000, event date `2000-01-01`, event time, city,
and state set to “Not published,” and `venues: []`. Query parameters do not
select a season. Once published, the endpoint chooses the newest eligible
season because the core lists seasons by descending year and id. Responses may
be cached for five minutes.

Check the JSON without writing it to the site yet:

```bash
curl --fail --silent --show-error \
  'https://app.sapporchfest.org/map/data.json' \
  | jq '{schema_version, season, venue_count: (.venues | length)}'
```

The result must report schema version `1.3.1`, season `2026`, and the expected
venue count recorded in the preconditions. Also inspect that no intentionally
unverified venue appears. Then open
`https://app.sapporchfest.org/map`, allow the client to render, and verify the
expected pins, venue lineup, act names, schedules, and links. The initial
“No map is published yet” message must be replaced by the rendered map.

This extends the public-deployer evidence in
`docs/operations/uat-2026-09-02-leg3-public-deployer.md`: that leg proved the
unpublished page and assets, the season-2000 empty sentinel, and the absence of
private seeded values from attendee-reachable map surfaces. It could not
exercise a published map; its venue, act, and held-slot omission findings were
source diagnostics rather than live-payload proof. Its observation that manual
coordinate entry was unavailable described that older test build; the current
`packages/web/src/views/coordinates.ts` does render “Manual coordinate entry
and review” and “Verify pin” controls.

Back out: on the same coordinates page, click “Unpublish map,” which posts to
`POST /seasons/<season-id>/map/unpublish` and clears `mapPublishedAt`. The page
then confirms “The public map is unpublished.” Allow up to five minutes for
the public cache to expire. If an older eligible locked, published, nonfuture
season exists, confirm `/map/data.json` now serves that named older season and
its expected document. If no older eligible season exists, confirm the endpoint
serves the season-2000 sentinel with an empty `venues` array. The 2026 season
remains locked; unpublishing does not and cannot reverse the lock.

Do not proceed to PR #2 while the endpoint is unpublished, returns 500, names a
season other than 2026, has the wrong venue count, or fails visual inspection.

### 4. Cut the marketing site over with PR #2

What to do: after the platform checks pass, mark `sapporchfest-site` PR #2
ready and merge it into `main` using that repository's normal reviewed merge
method. The PR replaces both Google Form signup links with:

- `https://app.sapporchfest.org/signup/host`
- `https://app.sapporchfest.org/signup/performer`

It also removes the Google My Maps path and adds `tools/pull-map-data.sh`.
Synchronize the clean local `main`, then run the pull and validator from the
marketing-site repository:

```bash
git switch main
git pull --ff-only
bash tools/pull-map-data.sh
python3 tools/verify-map-data.py
git diff -- static/data/venues-2026.json
```

What the code and PR do: `tools/pull-map-data.sh` fetches
`https://app.sapporchfest.org/map/data.json`, validates it against the vendored
`venues-map.v1` schema, and replaces `static/data/venues-2026.json` only after
successful validation. The separate validator additionally requires season 2026. A failed pull leaves the committed JSON untouched. This was verified
before cutover: a platform-shaped schema-1.3.1 season-2026 payload passed, while
the live unpublished sentinel failed with
`expected season 2026, got 2000` and did not replace the file.

Check before publishing: the pull and validator both exit 0; the validator
reports the same expected venue count as the platform; the JSON diff is a
generated replacement matching the platform payload; and these searches find
nothing anywhere in tracked site content:

```bash
git grep -n -E 'forms/(d|u)/|maps/d/' -- .
```

An empty `git grep` result exits 1; for this particular negative check, no
output is the expected result. Also verify the host and performer pages contain
the two platform form paths.

Commit the generated `static/data/venues-2026.json` update if the pull changed
it, push `main`, and allow Railway to deploy. Because this repository has no
CI, local validation and live verification are mandatory.

Check after publishing:

```bash
curl --fail --silent --show-error \
  'https://sapporchfest.org/data/venues-2026.json?cutover=2026' \
  | jq '{schema_version, season, venue_count: (.venues | length)}'
```

The live site data must report schema version `1.3.1`, season `2026`, and the
same expected venue count. Open `https://sapporchfest.org/map/`, wait for
client rendering, and compare representative pins, lineups, schedules, and
links with the platform map. Open both marketing-site signup calls to action
and confirm they reach the platform host and performer forms. Inspect the live
page source or rendered links and confirm no Google Forms or Google My Maps
reference remains. A merge or successful push alone is not evidence of a
successful cutover.

Back out: if PR #2 is merged but the pull fails, do not overwrite or push the
JSON; the site retains its last good committed file. If bad generated data was
pushed, restore the last known-good `static/data/venues-2026.json` in a forward
commit and push `main`. If the platform is later unpublished or down, the
already-deployed marketing site continues to serve its last good committed
JSON; a failed future pull must likewise leave that file untouched. If signup
links themselves must be rolled back, use a reviewed forward revert in the
marketing-site repository. None of these site backouts unlocks the platform
season.

### 5. Retire the hand-edit bridge

After every check above passes, treat this runbook as the successor to
`docs/operations/late-submissions-map-bridge.md`. The bridge was valid only
while the platform map was unpublished and the marketing site was fed by a
hand-maintained file.

From this point forward, `sapporchfest-site/static/data/venues-2026.json` is a
generated snapshot of the platform's `/map/data.json`, refreshed through
`tools/pull-map-data.sh`; it is not an operator-authored map database. Do not
hand-edit it for a late placement or correction. Make the owner-authorized
record, assignment, or coordinate correction in the platform, verify the
platform endpoint, run the pull, run the validator, inspect the generated diff,
and push the site.

The old bridge remains a historical record of the pre-cutover process and its
2026-09-06 decision. Do not delete or rewrite that evidence. Record the actual
cutover time, operator, expected venue count, coordinate decisions, platform
verification, marketing-site commit, and live result in the private
operational record; do not add private participant or infrastructure details
to this repository.

Back out: bridge retirement is a procedural designation, not an application
mutation. If the platform feed proves unusable and the owner authorizes a
temporary return to hand maintenance, document that exception explicitly and
restore the last known-good site data in a forward commit. Do not silently
resume hand editing.

## Post-cutover verification

| Check                      | Expected result                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Event timing and authority | Event is over; owner authorized placement, coordinate, lock, and cutover decisions.                                                      |
| Pending performer          | Owner-approved placement is complete, or performer was explicitly dropped before lock.                                                   |
| Bridge reconciliation      | Every previously hand-added venue, act, and approved placement is represented correctly in platform records and assignments.             |
| Coordinate queue           | Each imported or later-added review row was either verified and disappeared or remains documented and intentionally omitted.             |
| Season lifecycle           | `/admin/seasons/<season-id>` shows current state `locked`.                                                                               |
| Open slots                 | Any unfilled slots may still read `open`, but no further assignment or hold action is legal.                                             |
| Platform publication       | Coordinates page shows a non-null “Published at” value and offers “Unpublish map.”                                                       |
| Platform JSON              | `/map/data.json` is HTTP 200, schema 1.3.1, season 2026, and has the recorded expected venue count.                                      |
| Review-row privacy         | Every venue left `needs-review` is absent from the platform JSON and map.                                                                |
| Platform page              | `/map` renders expected pins and lineups rather than the unpublished message.                                                            |
| Marketing-site PR          | `sapporchfest-site` PR #2 is merged into `main` only after platform publication.                                                         |
| Pull safety                | `tools/pull-map-data.sh` and `tools/verify-map-data.py` pass; generated JSON matches the platform count.                                 |
| Google retirement          | No legacy form or custom-map URL remains in tracked or live site output.                                                                 |
| Signup cutover             | Marketing-site host and performer calls to action open the two platform signup forms.                                                    |
| Live site data             | `/data/venues-2026.json` is schema 1.3.1, season 2026, with the expected venue count.                                                    |
| Live site map              | `/map/` renders representative platform-fed pins, lineups, schedules, and links.                                                         |
| Failure behavior           | Unpublishing or an outage cannot erase the site's last good committed JSON; a failed pull leaves it untouched.                           |
| Operations gate            | Platform health, organizer queue, provider state, archive retention, and restore-rehearsal evidence remain healthy per `docs/deploy.md`. |

## Open questions and recommendations for 2027

### Decouple map publication from the season lock

The standing recommendation is to decouple platform map publication from the
irreversible season lock. This is a recommendation, not an approved decision.
Today, `publishSeasonMap` accepts only state `locked`, while `locked` also
forbids signup, assignment, and new holds. That coupling forced the 2026 choice
between publishing the platform map and preserving six fillable slots.

For 2027 planning, define a separately authorized publication state or snapshot
that can expose only owner-approved assignments and verified coordinates while
placement remains open. Preserve the current explicit publish/unpublish action,
privacy filters, schema preflight, and public-serving future-year guard.

### Make the expected-count preview explicit

The publication preflight proves only that at least one venue will publish and
that the document satisfies the schema; the organizer page does not display
the full pre-publication document or venue count. Add a preview/count control
that uses the same serializer as `/map/data.json`, including a list of excluded
venues and reasons. This would make the required expected-count check less
manual.

### Decide how post-publication corrections propagate

Coordinate verification has no season-state check of its own, and record
correction remains legal in `locked`. A newly verified coordinate or corrected
record can therefore change the published platform payload after cutover; the
platform response cache may retain the old payload for up to five minutes, and
the marketing site will remain unchanged until its pull is run and pushed.
Choose and document a refresh cadence and an owner-approval rule for these
post-publication changes.

### Account for serializer details

The serializer omits open and held slots, withdrawn or superseded venues and
acts, venues without addresses, unverified coordinates, and venues without a
publishable assigned act. It does not require a venue or act to be `confirmed`;
anything not withdrawn or superseded can appear when otherwise eligible. Decide
whether 2027 publication should require confirmed record status.

The public endpoint selects the first eligible season from a newest-first list.
That keeps an older published map live when a newer draft exists, but multiple
locked and published nonfuture seasons rely on ordering rather than an explicit
single-publication invariant. Consider enforcing or displaying which season is
the public map of record.

### Keep generated site data fail-safe

Retain the static-pull design from PR #2. It satisfies U12's requirement that
the map keep rendering when the platform endpoint is unavailable. Consider
automating the pull and validation later, but preserve the atomic rule: invalid,
unpublished, wrong-season, or unreachable platform data must never replace the
last good committed JSON.

## Related records

- [Season state machine](../../packages/core/src/season.ts)
- [Coordinate verification core](../../packages/core/src/geocoding.ts)
- [Coordinate verification rules](../../packages/core/src/geo-verify.ts)
- [Season lifecycle routes](../../packages/web/src/routes/season-lifecycle.ts)
- [Season lifecycle view](../../packages/web/src/views/season-lifecycle.ts)
- [Organizer record routes](../../packages/web/src/routes/admin-records.ts)
- [Organizer record view](../../packages/web/src/views/admin-records.ts)
- [Assignment routes](../../packages/web/src/routes/assign.ts)
- [Act assignment view](../../packages/web/src/views/assign-act.ts)
- [Venue assignment view](../../packages/web/src/views/assign-venue.ts)
- [Coordinate routes](../../packages/web/src/routes/coordinates.ts)
- [Coordinate review view](../../packages/web/src/views/coordinates.ts)
- [Public map routes and serializer](../../packages/web/src/routes/map.ts)
- [Deploy and rollback procedure](../deploy.md)
- [2026 production import record](season-import-2026-09-03.md)
- [Late-submissions map bridge](late-submissions-map-bridge.md)
- [Public-deployer UAT](uat-2026-09-02-leg3-public-deployer.md)
- [Platform plan: R18 and U12](../plans/2026-08-20-0830-feat-porchfest-platform-plan.md)
