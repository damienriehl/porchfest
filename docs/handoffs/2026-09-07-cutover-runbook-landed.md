---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-07T15:10:00Z"
title: "Porchfest: cutover runbook landed; one bridge pending; cutover after the event"
summary: "Post-event cutover runbook merged (PR #59); nothing left to build before the 2026-09-16 event; one late performer placement waits on a host form; U12 site PR #2 stays draft until after the event."
keywords:
  [
    "porchfest",
    "cutover",
    "season-lock",
    "map-publish",
    "u12",
    "late-submissions",
    "bridge",
    "sapporchfest-site",
  ]
cwd: "/home/damienriehl/Coding Projects/porchfest"
resume_focus: "Bridge the pending late performer placement when the host form arrives; after 2026-09-16 run docs/operations/post-event-cutover-2026.md."
repository: "github.com/damienriehl/porchfest"
repo_root_sha: "dbf6a6dd03fa91654c65c7364dc924cd6b4160cf"
branch: "main"
head: "a5c2b1ed90aeaa87e94657796f4d004aabf70e9f"
---

# Handoff — 2026-09-07: cutover runbook landed, bridge pending

Sanitized, committed copy. Repo-relative paths only. A private companion with
machine-local detail exists outside git; a session handed only this file loses
nothing it needs to _decide_, only some operational shortcuts.

## Where things stand

The 2026 season (event 2026-09-16) is live in production, unlocked, map
unpublished. There is **no plan unit left that can run before the event**; the
only remaining plan work (U12, the marketing-site cutover) is gated on the
event by the owner's standing decision. The session that wrote this shipped a
docs-only unit and stopped rather than invent work.

| Piece                                   | State                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| Post-event cutover runbook              | **Complete.** `docs/operations/post-event-cutover-2026.md`, PR #59, merged `a5c2b1e`.   |
| Late-submissions bridge runbook         | **Complete.** `docs/operations/late-submissions-map-bridge.md`, commit `8ee061c`.       |
| First bridge (1528 Grantham, two acts)  | **Complete, live** on the site map (site commit `4dd52e7`, 21 venues).                  |
| Second bridge (one late solo performer) | **Blocked** on a household's host form; owner emailed them 2026-09-07. See below.       |
| U12 — `sapporchfest-site` PR #2         | **Not started (gated).** Draft, rebased, MERGEABLE. Owner: merge only after 2026-09-16. |
| Season lock / map publish               | **Not started (gated).** Both are owner actions at cutover; lock is irreversible.       |

## Owner decisions in force (his, not inferred)

- **Option 1 bridge (2026-09-06):** late Forms submissions go onto the
  marketing-site map by hand-editing `static/data/venues-2026.json` in the
  site repo. Rejected: locking early to enter them in the platform (closes six
  open slots); freezing the map. Ask: `porchfest-2026-09-06-1404-late-submissions-map-bridge`.
- **U12 stays unmerged until after the event** (repeated 2026-09-04, 09-06).
- **Matching is always his call.** Never publish a guessed placement. His
  fallback rule for an unplaced act is in the bridge runbook, step 6.
- **The three `needs-review` coordinates** were offered for clearing and never
  authorized. Left as-is, `map.ts` suppresses those pins silently on publish.
  Decide at cutover, not before.

## The pending bridge — what to do when the form arrives

One performer (form 2026-08-27, solo acoustic, either slot) asked to play at a
specific household that has filed no host form. The owner emailed that
household 2026-09-07. Procedure: `docs/operations/late-submissions-map-bridge.md`
steps 1–6 (source-of-truth parsing, missing-check, Nominatim house-number
geocode cross-checked against a neighbour, validator, push, live verify). The
runbook's "Pending at time of writing" section is this item. If nothing
arrives by roughly 2026-09-12, the fallback is the owner's call (ask the
performer to forward the host form, or place them in an open slot with his
approval). The sheet had no rows newer than 8/27 when checked 2026-09-07.

## The cutover — after 2026-09-16

Run `docs/operations/post-event-cutover-2026.md` top to bottom. Read its
Preconditions first; two of them are easy to miss:

- **Bridge-era venues exist only in the site JSON.** 1528 Grantham (and any
  second bridge) were never entered in the platform. PR #2's
  `tools/pull-map-data.sh` regenerates `venues-2026.json` from
  `/map/data.json`, so they vanish from the public map unless entered in the
  platform **before the lock**. This is organizer data entry, not code.
- **A manual `deploy/archive.sh` never runs `deploy/offsite.sh`** — run both,
  or take evidence from a full `deploy.sh` gate.

Order is fixed by the code: coordinates → lock → publish → merge PR #2 → pull →
verify → retire Forms. The pull refuses the unpublished sentinel (season 2000),
so merging PR #2 first is harmless but useless.

## Verification performed this session

- Runbook: Codex fact-check against `packages/core/src/season.ts`,
  `packages/web/src/routes/map.ts`, `coordinates.ts`, `geocoding.ts`,
  `setup.ts`, `deploy/*.sh`, `docs/deploy.md` → FIX-FIRST (2 HIGH, 3 MEDIUM,
  2 LOW) → second Codex pass fixed all → gates rerun by the orchestrator:
  privacy grep clean, `npx prettier --check` passes,
  `node scripts/clean-room-scan.mjs` OK. Both repos clean at handoff.
- The Forms sheet was parsed by script (timestamp-keyed, year-2026 filter):
  nothing after 8/27. Do not read the sheet inline — ~130 KB.

## Traps already hit (don't retry)

- `codex-run.sh` reports `VERIFY-FAIL: out-file does not exist` on attempt 1
  when the out-file is a fresh path; making the **deliverable itself** the
  out-file is what finally yields VERIFIED. Check `git diff` before reading a
  wrapper failure as "no work."
- Gmail `search_threads` returned `{}` for the owner's sent email to the
  household — could not confirm it from the transcript side; proceeded on his
  word.
- The cockpit board is stale (`briefs/BOARD.json` last generated 2026-09-03;
  the cockpit tree sits on a feature branch, no sync timer). The on-deck edit
  for this work is in the cockpit working tree, uncommitted. Cockpit-repo
  problem, not porchfest.
- Model steering is retired (2026-08-15). A drift-check reminder still says
  "TIER_CHANGE → run /model"; that line is stale and should be removed at its
  source, not honored.

## Authoritative references

- `docs/operations/post-event-cutover-2026.md` — the cutover; Preconditions
  and step 3 (publish gates vs public-serving gates) are the load-bearing parts.
- `docs/operations/late-submissions-map-bridge.md` — the bridge; step 6 has the
  owner's placement rule; "Pending" is the open item.
- `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` §U12 (~line 589) — the site cutover unit; everything else in the plan is shipped.
- `docs/operations/season-import-2026-09-03.md` — the three review-queue
  coordinates and why.
- `sapporchfest-site` PR #2 body — what `pull-map-data.sh` validates and why it
  refuses the sentinel.

## Plausible next steps

One path, not a fork: (1) when the host form appears, bridge it; (2) after
2026-09-16, present the runbook's two owner decisions and run the cutover.
Anything else before the event is the owner's to raise.
