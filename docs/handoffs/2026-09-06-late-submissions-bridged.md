---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-07T01:30:00Z"
title: "Late submissions bridged onto the site map; one performer waits on a host form"
summary: "Owner chose Option 1 (hand-edit the marketing site's venues-2026.json per late Google Forms submission); 1528 Grantham with two acts is live, Samuel Wilbur is held pending a host form, U12 stays gated until after the Sept 16 event."
keywords:
  - "porchfest"
  - "2026-season"
  - "late-submissions"
  - "site-map"
  - "venues-2026-json"
  - "google-forms"
  - "option-1-bridge"
  - "u12"
  - "cockpit"
cwd: "/home/damienriehl/Coding Projects/porchfest"
resume_focus: "Bridge any further Google Forms submissions onto the site map the same way (validator, then push); place Samuel Wilbur once the requested host files a host form; keep U12 gated until after 2026-09-16; retire this handoff once the bridge procedure lands in docs/operations."
repository: "porchfest"
branch: "main"
head: "36c63d3"
---

# Status at capture

This handoff supersedes the retired
`docs/handoffs/2026-09-05-smtp-live-map-gated.md` (recoverable with
`git log --diff-filter=D -- docs/handoffs/`). Everything in that handoff that
was still open is either decided here or carried forward below. Nothing in the
`porchfest` repository changed this session; the code changes were in the
separate `sapporchfest-site` repository.

## The owner's decision (2026-09-06)

The owner chose **Option 1**: late submissions reach the public by hand-editing
the marketing site's `static/data/venues-2026.json`, validating, and pushing.
Rejected alternatives were entering them in the platform and merging U12 early
(would require the irreversible season lock, closing six open slots), and
freezing the map. U12 (`sapporchfest-site` PR #2, draft, MERGEABLE) remains
gated until after the event — the owner's standing call, unchanged.

The decision batch and answers are recorded in the cockpit at ask
`porchfest-2026-09-06-1404-late-submissions-map-bridge` (Decision Sheet
publication timed out; the answers file carries `[Executed]` notes).

## What is live

- `sapporchfest-site` commit `4dd52e7` on `main` adds venue **1528 Grantham
  Street** with The O'Keefe Brothers (6–7 pm) and Loose Rooster (7–8 pm).
  `tools/verify-map-data.py` passed at 21 venues; the push redeployed within
  about a minute; the marker and lineup were verified rendering on the live map.
- Placement rationale: the host and the band named each other in their forms
  (mutual self-match at 7–8). The O'Keefes were unplaced; the owner's rule was
  "an act-less venue first, otherwise 1528 Grantham 6–7". No act-less venue with
  power exists on the map (the only empty venue in the sheet is a park with no
  electrical, deliberately off-map), so they went to Grantham 6–7.
- Coordinates came from a Nominatim house-number match, cross-checked against
  the existing 1533 Grantham entry across the street.

## What is waiting

- **Samuel Wilbur** (performer form 8/27, solo acoustic, either slot) asked to
  play at a specific household that has filed no host form and whose contact
  details appear neither in the response sheet nor in the owner's mail. A Gmail
  draft asking them to fill out the Host form sits in the owner's Drafts with no
  recipient; the owner adds the address and sends. This is tracked on the
  cockpit on-deck list under `waiting`.
- Every other submission in the response sheet is either on the map or was
  deliberately withdrawn in August (two venues; see the site repo's data commit
  history for `venues-2026.json`).

## The bridge procedure (learned this session; not yet in docs/operations)

1. The Forms responses live in one Google Sheet ("SAP Porchfest Performers and
   Hosts"). Its tabs, in order: a curated host↔act matching table, the Host form
   responses, the Performer form responses, then older 2025 tabs. Timestamps are
   `M/D/YYYY H:MM:SS`. The Drive connector returns the whole sheet as Markdown
   tables (about 130 KB); parse it with a script rather than reading it inline.
2. Diff the response timestamps against the site's last `data(map):` commit
   date; the Goal-1 reconstruction and the 9/3 platform import both stop at
   Aug 22, so anything later is on neither map.
3. Geocode new addresses (Nominatim house-number match; sanity-check against a
   neighbouring existing venue), then edit `static/data/venues-2026.json`
   following the file's own conventions — link labels are `Listen` / `Website`
   only; en dashes in `schedule` and `slot_label`.
4. `python3 tools/verify-map-data.py` must pass. **The `.sha256` pin covers the
   schema, not the data** — a data-only edit never touches it.
5. Push `main`; Railway redeploys on push (there is no CI workflow in the site
   repo). Confirm by fetching the live `data/venues-2026.json` and counting
   venues, then the map page.
6. Matching (who plays where) is always the owner's call; ask before publishing
   an unconfirmed placement.

## Traps hit

- `codex-run.sh` reported `VERIFY-FAIL: out-file does not exist` and exit 2 on
  both attempts, yet the JSON edit had landed correctly in the working tree.
  Check `git diff` before treating that exit as "no work" (already recorded in
  the orchestrator's memory as a known sandbox trap).
- `cockpit-decide file` rejects a `refs` entry that merely contains "smtp" in a
  filename as credential-shaped; describe the handoff by date and topic instead
  of pasting the path.
- `cockpit-decide file` requires `default_mode` and a five-field `capsule`
  (`why`, `blocks`, `refs`, `asked_by_session`, `asked_on`).

## Still open from the previous handoff (unchanged)

- Three platform coordinates remain in `needs-review`; clearing them was
  offered, never authorized. Only matters if the platform map ever publishes.
- Decoupling platform map publication from the season lock remains a
  recommendation, not a decision.
- The `hello@` sending alias is not created; From is still the owner's Gmail.
- Cockpit: the freeze sentinel is not honoured by services that set
  `COCKPIT_ROOT`; the cockpit tree sits on a feature branch. Both untouched.

## Retiring this handoff

Retire when the bridge procedure above is written to
`docs/operations/` (or a `docs/solutions/` entry) and Samuel Wilbur is either
placed or declined. Delete this file and its private companion in that commit.
