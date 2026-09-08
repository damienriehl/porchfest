# Late-submissions map bridge — 2026-09-06

This runbook records how to place late 2026 host and performer submissions on
the public marketing-site map without publishing the platform map. It captures
the decision made on 2026-09-06, the repeatable bridge procedure, and the first
completed bridge as evidence that the procedure works.

## Context and decision

The 2026 SAP Porchfest event is on 2026-09-16. During the final approach to the
event, two different maps exist:

| Map                | Location                                                             | Publication state                                                                               |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Platform map       | This repository; `app.sapporchfest.org`                              | Public publication requires an irreversible season lock and the U12 marketing-site pull request |
| Marketing-site map | The separate `sapporchfest-site` repository; `sapporchfest.org/map/` | Published from the hand-maintained `static/data/venues-2026.json` file                          |

The platform's 2026 production import occurred on 2026-09-03. Host and performer
responses submitted after its source cutoff are therefore absent from the
platform map. They are also absent from the marketing-site map unless an
operator has explicitly added them to `static/data/venues-2026.json`.

On 2026-09-06, the owner chose Option 1: bridge each late submission onto the
marketing-site map by editing that JSON file, validating the result, and
pushing the site repository. This keeps the public map current without changing
the platform's publication state.

The owner rejected two alternatives. Entering the submissions in the platform
and merging U12 early would require the irreversible season lock and would
close six still-open slots. Freezing the public map would omit valid late
submissions. U12 therefore remains gated and unmerged until after the
2026-09-16 event.

The decision is recorded in the cockpit ask
`porchfest-2026-09-06-1404-late-submissions-map-bridge`.

## Bridge procedure

### 1. Establish the source of truth

The current responses are in the owner's Google Sheet named "SAP Porchfest
Performers and Hosts." The sheet is referenced from the private handoff store
and the owner's Drive; do not copy its Drive file identifier into repository
documentation.

The tabs appear in this order:

|       Order | Tab contents                       |
| ----------: | ---------------------------------- |
|           1 | Curated host-to-act matching table |
|           2 | Current Host form responses        |
|           3 | Current Performer form responses   |
| 4 and later | Older 2025-era material            |

The curated table has the columns `Venue`, `Host`, `Host Email`, `Host Phone`,
`6–7 pm`, `7–8 pm`, `Status`, `Chase`, and `Notes`. Treat it as a matching aid,
not permission to disclose its private contact fields.

Response timestamps use `M/D/YYYY H:MM:SS`. The Drive connector returns the
entire sheet as Markdown tables, currently about 130 KB. Do not try to reason
over that response inline. Save the returned content outside the repository and
use a small script to split the tables and select rows by their timestamp
column. Explicitly require timestamp year 2026 so the older tabs, which repeat
the same headers and some rows, cannot enter the candidate set.

### 2. Find submissions missing from both maps

In the marketing-site repository, identify the most recent `data(map):` commit
that touched `static/data/venues-2026.json`. Compare the current-form response
timestamps with the date represented by that map update, then inspect later
responses as bridge candidates.

The historical Goal-1 reconstruction and the 2026-09-03 platform import both
stop at 2026-08-22. A response after that cutoff is on neither original map
unless someone bridged it afterward. The reconstruction's raw export filename
is not reliable evidence of the cutoff: although its name contains a
2026-08-19 date, its contents include rows from 8/23 and 8/24.

Before classifying a candidate as missing, search the current
`static/data/venues-2026.json` for both its venue and act names. This second
check is mandatory because a previously completed bridge can make a response
present even though its timestamp is later than the original cutoff. Record
which host response, performer response, and owner-approved placement support
each proposed JSON change.

### 3. Geocode and edit the site data

For every genuinely new venue, geocode the address with Nominatim and require a
house-number match. Sanity-check the returned point against a nearby venue that
already appears in the JSON. A plausible street and city are insufficient if
the house number did not match or the point is inconsistent with neighbouring
markers.

Edit `static/data/venues-2026.json` in the marketing-site repository and follow
the file's existing object shape, ordering, indentation, and naming
conventions. Link labels must be only `Listen` or `Website`. Use en dashes (`–`)
rather than hyphens in both `schedule` and `slot_label`. Preserve existing
entries unless the owner has separately authorized a correction.

### 4. Validate the data

From the marketing-site repository, run:

```bash
python3 tools/verify-map-data.py
```

Do not proceed unless it passes and reports the expected new venue count.
Inspect the diff as well as the validator output so the change contains only
the intended venue and lineup data.

The `.sha256` pin stored beside the schema covers the schema itself, not the
venue data. A data-only change to `static/data/venues-2026.json` must not update
that pin.

### 5. Publish and verify the live map

Commit the validated data change in the marketing-site repository and push its
`main` branch. That repository has no CI workflow; Railway redeploys the site
when `main` is pushed. The new data normally becomes live in about one minute.

After allowing the deployment to complete, fetch the live
`/data/venues-2026.json` endpoint with a unique cache-busting query string.
Count the returned venue objects and confirm that the count matches the local
validator. Then load `/map/`, wait for client rendering to finish, and verify
that the new venue name, marker, and approved lineup appear. A successful push
alone is not publication evidence.

### 6. Obtain the owner's matching decision

The owner always decides who plays where. Do not publish a guessed or
unconfirmed placement, even when the source forms suggest a likely match. Ask
the owner and retain the decision in the private operational record before
changing the live lineup.

For an otherwise unplaced act, the owner supplied this rule on 2026-09-06:
prefer an act-less venue that has electrical power; if none is available, use
an open slot at the newest bridged venue. This is a decision rule for proposing
a placement, not authority to override a later instruction from the owner.

## Worked example — 2026-09-06

The first bridge added 1528 Grantham Street in site commit `4dd52e7`, with one
act from 6–7 pm and another from 7–8 pm. The host and one band had each named
the other in their forms. That mutual self-match made one slot
uncontroversial. The other act was unplaced and entered the remaining slot
under the owner's rule.

The matching sheet contained one act-less venue, but it was a park without
electrical service and had deliberately been kept off the map. It therefore did
not satisfy the owner's preference for an act-less venue with power, leaving
the newest bridged venue's open slot as the applicable choice.

Nominatim returned a house-number match for 1528 Grantham Street. The operator
cross-checked its coordinates against the existing 1533 Grantham Street entry
across the street. The validator passed with 21 venues. About one minute after
the push, the live data had the expected count and the map rendered the new
marker and both lineup entries.

## Withdrawals — the same bridge, in reverse

A cancellation reaches the map the same way an addition does: edit
`static/data/venues-2026.json`, validate, push, and verify the live data and
`/map/`. Remove the act object; when the withdrawing act was the venue's only
act, remove the whole venue object, as site commit `6ad2ec0` did for 991
Bayless. Never leave a venue with an empty `acts` array on the map.

A withdrawal has one obligation an addition does not. The platform still holds
the imported venue and act, so the cutover checklist in
`docs/operations/post-event-cutover-2026.md` carries a matching item: withdraw
those records before lock, or the published platform map will restore what the
site map just dropped.

Withdrawing the act is always required. Withdrawing the venue is the owner's
call: a venue kept active with no assigned act is omitted from the published
map anyway, and keeping it leaves a porch available for a late performer. Keep
it only when the host is genuinely still willing — a host who withdrew must
re-confirm before anyone is placed there.

### Recorded withdrawal — 2026-09-08

The contact for Crazy Chester wrote that the band and the 2379 Bourne Ave. host
site are both unable to participate in 2026, and asked for the map to be
corrected. Crazy Chester was that venue's only act, so the venue object was
removed in site commit `f0d87df`. The validator reported 20 venues (down from
21; 27 acts to 26), and the live `/map/` rendered 20 markers with no Bourne
pin and no Crazy Chester lineup entry.

The platform records were not changed in that session. On 2026-09-08 the owner
decided to keep the 2379 Bourne venue record active there, in case a late
performer needs a porch, and to withdraw only the act. The host's own
withdrawal stands on the record, so that porch is not available for a placement
until the host re-confirms. Both halves are the open cutover item above.

## Pending at time of writing

One performer submitted the form on 2026-08-27 for a solo acoustic set in
either slot and asked to play at a particular household. That household has not
submitted a host form. On 2026-09-07, the owner emailed the household and asked
it to complete the form.

When the host response arrives, verify the relationship and bridge the venue
and placement through the procedure above. If no response arrives, ask the
performer to forward the host form or seek the owner's approval to place the
performer in an open slot. Do not infer consent from the performer's request.
The item remains on the cockpit on-deck list.

## Operational traps

### A failed wrapper can still leave a valid edit

During both attempts at the 2026-09-06 edit, `codex-run.sh` exited with status 2
and reported:

```text
VERIFY-FAIL: out-file does not exist
```

The JSON edit had nevertheless landed correctly in the working tree. Check
`git diff` before interpreting that wrapper result as "no work." Better, set
the deliverable file itself as the wrapper's out-file so its existence proves
the requested write occurred.

### Old tabs resemble current data

The 2025-era tabs repeat the 2026 response headers and contain some repeated
rows. Filter parsed responses by timestamp year, not by header text or tab
position alone.

### The raw-export filename understates its contents

The reconstruction export whose filename contains 2026-08-19 also contains
8/23 and 8/24 rows. Inspect and parse row timestamps rather than trusting the
date embedded in that filename.

### Cockpit references have strict validation

`cockpit-decide file` rejects a `refs` entry when its filename merely contains
`smtp`, because the name appears credential-shaped. Refer to that handoff by
date and topic instead. The command also requires `default_mode` and a
five-field `capsule` containing `why`, `blocks`, `refs`, `asked_by_session`, and
`asked_on`.

## Related records

- [2026 season production import](season-import-2026-09-03.md)
- [2026 import procedure](../import-2026.md)
- [Deployment procedure](../deploy.md)

The 2026-09-06 handoff that originally captured this procedure was retired into
this durable runbook. Its deleted repository version remains recoverable with
`git log --diff-filter=D -- docs/handoffs/`.
