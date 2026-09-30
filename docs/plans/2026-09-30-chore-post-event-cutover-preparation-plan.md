---
title: Prepare the post-event cutover with refreshed evidence
type: chore
status: blocked
execution: knowledge-work
date: 2026-09-30
---

# Goal

Complete the 2026 cutover after Damien reviews the private coordinate packet and
makes the archive decisions. This document prepares the next executor; it is not
a record of production execution.

## Evidence and settled decisions

Use `../operations/post-event-cutover-2026.md` as the detailed procedure. The
September 14 reconciliation addressed bridge lineup changes and withdrawals;
it did not satisfy the separate coordinate, pending-placement, backup, health,
and current marketing PR gates. September 18 claims about unlocked state,
live Forms, and PR #2 drift are historical and unverified today.

Damien's September 30 answer is to see the rows first. Ordinary shipping
permission does not replace that archive decision. The 2027 lead decision does
not establish whether the performer played in 2026 or resolve a pending 2026 record.
Source inspection confirms map serialization excludes withdrawn/superseded
venues and acts, blank addresses, unverified coordinates, and venues without
publishable assigned acts. Tentative status is not separately excluded. Count
by the actual serializer, not an assumed definition of active.

## Implementation units

1. A separately authorized network executor refreshes organizer season state,
   publication state, coordinate queue, pending placements and actual 2026 lineup.
   If already locked or published, record that state and adjust the remaining
   sequence; never repeat a transition to manufacture a receipt.
2. Complete `2026-09-30-chore-private-coordinate-review-plan.md`; obtain Damien's
   per-row verify/correct/omit choices and archive-completeness call. Reconcile
   the historical 2026 pending placement independently of the 2027 lead.
3. Recompute expected publishable venue/lineup counts. Verify current production
   archive, encrypted off-site success and restore rehearsal, then all health,
   provider, retention and organizer checks in `../deploy.md`. Record actual
   pre-receipt and deploy-rollback-ref privately before any deployment.
4. Read the current diff and checks for sapporchfest-site PR #2; resolve drift in
   that repo's authorized lane and review it. The historical draft and ten-commit
   lag are not current evidence. Preview where supported; verify signup links,
   My Maps removal, fail-safe pull and schema validation.
5. Only after gates pass: lock -> publish platform map -> verify platform ->
   reviewed site merge -> generated-data pull/validation -> publish site -> live
   verification. Use the exact UI routes, commands and failure stops in the
   runbook; this lane does not run them or modify another checkout.

## Verification and definition of done

Platform map is schema 1.3.1, season 2026, with the refreshed expected venue count,
lineup and omissions. Site pull/validator succeeds and live generated data agrees.
Both signup links reach platform forms; no Google Forms/My Maps links remain in
tracked or live site content. Inspect rendered map and representative schedules.
Record individual actual action receipts, current review/check results and dates.
Documentation merges alone prove none of these outcomes.

Offline boundary checks passed; full tests are blocked by missing Vitest and a
Node 22 runtime below the required Node 24. No production or network call ran.

## Rollback and integration

The lock has no logical rollback. A database restore discards subsequent changes
and is disaster recovery, not unlock. Map unpublish leaves the season locked.
Use reviewed forward reverts for site/data changes and a verified prior release
reference for deployment rollback. Do not archive the season during this cutover.
This preparation belongs on main independently of the coverage branch; revert
its documentation commit if superseded. No production rollback is needed here.
