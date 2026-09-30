---
title: Carry forward the approved 2027 placement lead
type: chore
status: ready
execution: knowledge-work
date: 2026-09-30
---

# Goal and decision record

Damien 2026-09-30 approved carrying forward the Samuel Wilbur on-deck item as a
2027 placement lead. This minimal planning reference records that decision; no
contact information, host information or private roster data is copied here.
Source lineage: porchfest-2026-09-30-1309-backlog-review-2026-09-30/wilbur-2027.

## Implementation units

- Retain the lead for 2027 planning; the decision is settled and does not need
  to be asked again. The orchestrator may link the Later card to this record.
- At 2027 intake, use the existing private relationship record under its existing
  retention rules. Confirm renewed performer interest and any host's consent
  before proposing a placement. This decision authorizes neither placement nor
  outreach in Damien's voice.
- Keep the 2026 archival disposition separate: the event window expired, but
  this does not prove the performer played, was placed, or was explicitly dropped.
  Reconcile the operational record before the 2026 lock.

## Verification and definition of done

The approved carry-forward is captured durably without contacting anyone or
copying contact values. No application behavior changed; no new tests required.
Dependency-free repository boundary checks pass. Full npm tests cannot run in
this checkout (Vitest absent; Node 22 rather than required >=24).

## Rollback and integration

This record belongs on main independently of the coverage branch. A later owner
change can supersede the lead decision in a focused documentation commit. No
message, platform placement or private-record mutation needs reversal.
