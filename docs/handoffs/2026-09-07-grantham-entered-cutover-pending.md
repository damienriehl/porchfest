---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-07T18:51:00Z"
title: "Porchfest: 1528 Grantham entered in the platform; one bridge pending; cutover after the event"
summary: "First bridge venue is now in production (venue 26, acts 34/35, coordinate verified); nothing left to do before 2026-09-16 except one owner-gated late placement; then run the post-event cutover runbook."
keywords:
  [
    "porchfest",
    "cutover",
    "season-lock",
    "map-publish",
    "u12",
    "late-submissions",
    "bridge",
    "grantham",
    "sapporchfest-site",
  ]
cwd: "/home/damienriehl/Coding Projects/porchfest"
resume_focus: "Place the pending late performer when the host form arrives (owner decides the fallback around 2026-09-12); after 2026-09-16 run docs/operations/post-event-cutover-2026.md."
repository: "github.com/damienriehl/porchfest"
repo_root_sha: "dbf6a6dd03fa91654c65c7364dc924cd6b4160cf"
branch: "main"
head: "382334d7bd2a7b943dde139b79fff2679a3df981"
---

# Handoff — 2026-09-07 (evening): Grantham entered, cutover pending

Sanitized, committed copy. Repo-relative paths only. A private companion with
machine-local detail exists outside git; a session handed only this file loses
nothing it needs to _decide_, only operational shortcuts (prod host, record
ids with names, Drive ids, backup path).

Supersedes `docs/handoffs/2026-09-07-cutover-runbook-landed.md` (retired in the
same commit). Everything durable from that handoff is either here or in the two
runbooks it pointed at.

## Where things stand

The 2026 season (event 2026-09-16) is live in production, unlocked, map
unpublished, every venue and act at status `tentative` (that is the convention
for this season, not a gap). **There is no work that can run before the event.**
The session that wrote this did organizer data entry in prod, updated docs, and
stopped.

| Piece                                   | State                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First bridge (1528 Grantham, two acts)  | **Complete in both places.** Site map since site commit `4dd52e7`; **platform since 2026-09-07**: placeholder venue 26, placeholder acts 34 and 35, both slots `assigned`, coordinate `verified`. |
| Post-event cutover runbook              | **Complete.** `docs/operations/post-event-cutover-2026.md` (PR #59). Precondition for the first bridge is annotated as satisfied (commit `382334d`).                                              |
| Late-submissions bridge runbook         | **Complete.** `docs/operations/late-submissions-map-bridge.md`.                                                                                                                                   |
| Second bridge (one late solo performer) | **Blocked** on a household's host form; owner emailed them 2026-09-07. No host row in the sheet as of 2026-09-07 afternoon (owner checked).                                                       |
| U12 — `sapporchfest-site` PR #2         | **Not started (gated).** Draft, rebased, MERGEABLE. Owner: merge only after 2026-09-16.                                                                                                           |
| Season lock / map publish               | **Not started (gated).** Owner actions at cutover; lock is irreversible.                                                                                                                          |
| Cockpit housekeeping (on-deck edits)    | **Deliberately not done.** The cockpit tree is under a cutover freeze (timers masked since 2026-08-31, feature branch, large dirty tree). Two porchfest on-deck edits remain uncommitted there.   |

## What this session did in production (organizer data entry, not code)

Entered via the admin UI exactly as the cutover runbook's precondition
describes (`/admin/placeholders/{venue,act}/new`, then
`/admin/venues/<id>/assign`, then `/seasons/1/coordinates`):

- Venue 26 — 1528 Grantham Street, placeholder, direct host contact attached,
  provenance in the notes (host form date, site commit that bridged it).
- Act 34 (the band, 6–7 PM, slot 51) and act 35 (the host's own band, 7–8 PM,
  slot 52); assignments 40 and 41.
- Coordinate row: the site JSON's Nominatim house-number point, cross-checked
  against the neighbour at 1533 Grantham, marked organizer-verified.
- Verified read-only in the prod DB afterwards: both slots `assigned`,
  coordinate `verified`, canonical non-withdrawn venue count 21 → 22, coordinate
  statuses 18 verified / 3 needs-review.
- A zero-downtime SQLite backup was taken inside the app container before any
  write (path in the private companion). `deploy/archive.sh` was deliberately
  **not** used — it quiesces and restarts the live app.
- The single-use organizer sign-in link was consumed on sign-in and the session
  was signed out at the end; nothing credential-shaped is left on disk.

## Owner decisions in force (his, not inferred)

- **Option 1 bridge (2026-09-06):** late Forms submissions go onto the
  marketing-site map by hand-editing `static/data/venues-2026.json`. Rejected:
  locking early; freezing the map. Ask:
  `porchfest-2026-09-06-1404-late-submissions-map-bridge`.
- **Enter bridge venues in the platform before lock (2026-09-07):** he said
  "go ahead" on the Grantham entry; done. A second bridge needs the same entry.
- **U12 stays unmerged until after the event** (2026-09-04, 09-06).
- **Matching is always his call.** Never publish a guessed placement. Fallback
  rule for an unplaced act: bridge runbook, step 6.
- **The three `needs-review` coordinates** are decided at cutover, not before.
  `map.ts` suppresses those pins silently on publish.
- **Cockpit housekeeping stays frozen** — my call this session, reported to
  him and not contested: do not commit into or regenerate the cockpit tree
  while its cutover freeze is on.

## The pending bridge — when the host form arrives

One performer (form 2026-08-27, solo acoustic, either slot) asked to play at a
household that has filed no host form. Procedure:
`docs/operations/late-submissions-map-bridge.md` steps 1–6 for the site map,
**plus** the platform entry above (placeholder venue + act + assign +
coordinate) so the cutover precondition holds. If nothing arrives by roughly
2026-09-12, the fallback is the owner's call. Do not read the Forms sheet
inline (~130 KB); parse it by script, timestamp-keyed, year-2026 filter.

## The cutover — after 2026-09-16

Run `docs/operations/post-event-cutover-2026.md` top to bottom. Its
Preconditions section now records the Grantham entry as done. Two owner
decisions it will surface: the three review-queue coordinates (verify or leave
off) and the expected venue count. Order fixed by the code: coordinates → lock
→ publish → merge PR #2 → pull → verify → retire Forms. A manual
`deploy/archive.sh` never runs `deploy/offsite.sh` — run both.

Not map-eligible today, no action: venue 2 (a park venue) has no coordinate
row and no assigned acts, and is not on the site map either. If an act is ever
placed there it needs a coordinate before lock.

## Orchestration note for the next session

Fable's weekly quota was at 99% when this was written; the owner intends the
next session to run with Opus as orchestrator. Nothing here needs Fable.
`worker_route=codex` is unchanged — implementation, if any ever arises, goes to
Codex workers; the orchestrator does credentialed prod actions itself (the
admin UI via chrome-devtools worked cleanly for data entry).

## Traps already hit (don't retry)

- **Inline `node -e` over ssh with nested quotes** fights three quoting layers;
  pipe a script file to `docker compose … exec -T app node -` via stdin instead.
- `seasons` has `display_name`, not `name`; `venues` has no `withdrawn_at` —
  withdrawal is `status = 'withdrawn'`. Use `pragma table_info` before
  guessing columns.
- The box-local `/health` on the app port returns 000 under the external-proxy
  overlay; use the public `https://app.sapporchfest.org/health`.
- The runtime image ships no `scripts/` beyond `organizer-link.ts`; one-off
  scripts must be bind-mounted or piped.
- `codex-run.sh` reports `VERIFY-FAIL` on attempt 1 when the out-file is a
  fresh path; check `git diff` before reading that as "no work."

## Authoritative references

- `docs/operations/post-event-cutover-2026.md` — the cutover; Preconditions
  (lines ~50–80) and step 3 are load-bearing.
- `docs/operations/late-submissions-map-bridge.md` — the bridge; step 6 has the
  owner's placement rule; "Pending at time of writing" is the open item.
- `docs/operations/season-import-2026-09-03.md` — the three review-queue
  coordinates and why.
- `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` §U12 — the site
  cutover unit; everything else in the plan is shipped.
- `sapporchfest-site` PR #2 body — what `tools/pull-map-data.sh` validates and
  why it refuses the unpublished sentinel.

## Plausible next steps

One path, not a fork: (1) when the host form appears, bridge it on the site
**and** enter it in the platform; (2) around 2026-09-12 with no form, put the
fallback to the owner; (3) after 2026-09-16, present the runbook's two owner
decisions and run the cutover; (4) once the cockpit freeze lifts, commit the
two on-deck edits and regenerate the board.
