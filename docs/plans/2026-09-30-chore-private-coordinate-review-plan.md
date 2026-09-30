---
title: Prepare the private archive coordinate decision packet
type: chore
status: blocked
execution: knowledge-work
date: 2026-09-30
---

# Goal and settled decision

Damien 2026-09-30: show the coordinate rows privately before deciding the archive
cutover. Keep addresses and coordinates out of the repository, sheet and chat.

## Evidence and blocker

`../operations/season-import-2026-09-03.md` establishes a historical queue of
three nominatim-house / cross-check-missing rows. It deliberately keeps the
source artifacts machine-local. The current queue may have changed.
No current private source path was supplied to this worker. Production reads
are prohibited, and the heartbeat is the only permitted outside-worktree write.
A private file inside the repo, even gitignored, would violate the requested
storage boundary and the repo's clean-room model. No review packet or private
rows were created; this document is only preparation. Do not hand Damien an
empty template as if it contained reviewed rows.

## Implementation units

1. Orchestrator assigns an existing approved private home-box operational
   directory outside every checkout and authorizes a separate executor's writes
   there. No credential minting or new authorization from Damien is implied;
   this is a lane restriction. Use existing approved operational access without
   putting credentials in the packet, terminal output, or worker messages.
2. In that lane, obtain the current organizer coordinate queue at
   GET /seasons/<season-id>/coordinates. Record retrieval time, season ID and
   source freshness privately. If using an offline snapshot, label its date and
   require a live refresh before any mutation. Do not assume exactly three rows;
   include every unresolved row and explain any difference from the baseline.
3. Write a mode-0600 file in a mode-0700 private directory, without printing its
   body. Include, per row: venue ID/version, address, candidate latitude/longitude,
   source/status/reason, independent cross-check evidence or explicitly unverified,
   assigned publishable-act presence, effect of omission on venue count, and
   blank owner choice (verify candidate / correct and verify / omit).
   Add expected-count calculation, unresolved placements and archive-completeness
   decision. Do not include participant contacts or credential material.
4. Verify permissions and row coverage against the current queue, privately;
   return only the real path and row count to Damien. Leave all choices blank
   until his call. Preserve the packet under existing operational retention rules.

## Verification and definition of done

A populated private file exists outside all repos; permissions restrict access;
its row count matches fresh queue evidence; no addresses/points entered repo,
sheet or chat. Damien can review a path, make per-row choices, and decide archive
completeness. Refresh versions immediately before any later coordinate mutation.
None of those private-packet acceptance conditions is claimed complete here.

## Rollback and integration

This plan belongs on main independently of the coverage branch. Revert its
commit if superseded. No coordinate mutation occurred. Verification has no routine
backout to the old provider-review state; stop before verification if uncertain.
The next executor must deliver the populated packet before requesting the decision.
