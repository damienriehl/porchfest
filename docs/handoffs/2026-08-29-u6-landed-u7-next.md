---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-29T00:00:00Z"
title: "U6 landed — assignment, suggestions, and season transitions; U7 is next"
summary: "U6 is implemented, simplified, reviewed, and fixed on one branch: organizers assign acts with explained suggestions, are refused every double-booking by name, and move a season through its states. U7 (email waves and outbox) is the next unit and the last one before the human UAT can close U5."
keywords:
  [
    "porchfest",
    "u6",
    "u7",
    "matching",
    "season-transitions",
    "codex-workers",
    "node-24",
  ]
resume_focus: "Start U7 — email waves, outbox, and provider adapters"
repository: "porchfest"
branch: "u6-assignment-and-season-transitions"
head: "25364c2"
---

# U6 landed. U7 is next, and it completes the Tuesday-night loop.

## Start here

The U6 branch carries everything the plan's U6 section asked for, plus the
review fixes. Read `### U7.` in
`docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` before anything
else; U7 is the last unit standing between the product and the human UAT that
closes U5 (`docs/operations/organizer-uat.md`, tasks 1–4 and 6 are runnable
now; task 5 waits on U7).

The whole build ran as Codex workers through the `ce-work` cross-model
controller, one bounded unit at a time, with the host owning every commit and
gate. The unit shape that worked, in order:

| Unit | What                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| U6A  | core: schema/migration 0012, pure `matching.ts`, named refusals, act links, venue slot materialization            |
| U6B  | web: `/admin/seasons/:id` transitions with derived "stops allowing" text; forms capture the three matching fields |
| U6C  | web: venue-first and act-first assignment screens, holds, links; timezone-aware times                             |
| U6D  | simplify pass (three reviewer rubrics in one packet) + one behavior fix                                           |
| U6E  | the code-review findings, C1–C8 correctness and K1–K11 cleanup                                                    |

## What the plan did not know, and what U6 decided

- **The schema had no matching data.** Nothing stored a shared-member
  declaration, a host's requested acts, or a venue's genre preference. U6 added
  `acts.shared_member_note`, `venues.requested_act_names`,
  `venues.genre_preferences`, an organizer-confirmed `act_links` table, and
  `assignments.shared_member_override` (the recorded override R7 requires).
  Both public forms and the record editor capture the new fields (R1).
- **No production path created venue `slots`.** Only the test seam did. Venue
  slots are now materialized from the season's time-slot grid at host signup,
  at placeholder creation, and on demand by `ensureVenueSlots`; read-only
  listings exist for archived seasons.
- **Matching is a pure function** (`packages/core/src/matching.ts`,
  `rankPairings`) over plain data built by `buildMatchingInput(seasonId)`;
  every pairing carries reasons and warnings as text, and the ranking is a
  total order (score, act name, act id, slot start, slot id). A checked-in
  fixture (`packages/core/test/fixtures/matching-season.json`, synthetic
  names only) pins the ranking.
- **Refusals are named.** `AssignmentConflictError.kind` is one of
  `slot_filled | slot_held | act_already_assigned | shared_member |
act_withdrawn`, and the message is the organizer-facing sentence the route
  shows verbatim (AE3).
- **Season transitions are forward-only** and the page derives "moving to X
  stops allowing: …" from `isSeasonActionLegal`, never from hand-written
  sentences. Lock and archive need a confirmation; archive refuses while any
  slot is still held.

## Constraints a later PR must not undo

Everything in the retired 2026-08-28 handoff still holds (KTD7 everywhere; the
`lifecycleRefusal` wording is byte-identical on purpose; unknown ids answer 404;
the recovery CLI adds no HTTP surface; the public sign-in page names no repo
path). Added by U6:

- **Availability is containment, not overlap.** A stated window must cover the
  whole slot; the review confirmed partial overlap contradicted the "hard
  constraint" the code claims.
- **Name and genre matching are word-bounded and negation-aware.** "Joe" must
  not match "Banjoe Boys"; "anything but country" must not boost a country act.
- **Unassign is gated on `assignment`, not `correction`**, so a locked season
  cannot be holed with no way to repair it.
- **A hold's decide-by is the end of that day in the season's timezone.**
- **Core time strings follow `seasons.timezone`** (`formatZonedWindow`); the
  web views use the same helper so headings and reason text agree.

## Two residuals recorded on the PR, deliberately not fixed

- `assignSlot` does not check stated availability — an organizer can place an
  act outside its window through a hand-crafted POST. Organizer-decided by
  design (KD4).
- Conflict rules exist twice: warnings in `matching.ts`, refusals in
  `assignSlot`. A shared `assignmentConflicts()` is a later refactor; the two
  agree today and tests pin both.

## The environment traps, still live

- **Node 24.** `source ~/.nvm/nvm.sh && nvm use 24` in every shell; the box
  default is v25 and `better-sqlite3` fails there, which reads like a
  catastrophic regression across untouched files.
- **Seeding a Codex worker's worktree.** Follow the cockpit solution doc for
  the `node_modules` symlink directory, and additionally re-point
  `node_modules/@porchfest/*` at the worktree's own `packages/*` — the
  canonical links are relative and resolve back to the canonical checkout.
  Quote every path; the repo lives under a directory with a space in its name.
- **A harness-native review fork can die silently.** This session's
  `code-review` fork stopped three hours in, after its verifiers had all
  reported and before it wrote a report. The verifier transcripts under the
  session's `subagents/` directory carried every verdict with evidence, and the
  review was finished from those. Check the fork's output file mtime before
  assuming it is still working.

## Open, in order

1. **U7** — email waves, outbox, provider adapters. Needed before task 5 of the
   organizer UAT can run.
2. **The human UAT** that closes U5 (`docs/operations/organizer-uat.md`).
   Tasks 1–4 and 6 are runnable today; running them now finds interface
   problems in the new assignment screens while they are cheap.
3. **U9's other agent** still has worktrees on `u9-*` branches; leave them.
