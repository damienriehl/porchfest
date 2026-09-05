---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-05T17:00:00Z"
title: "SMTP live; public map gated by the irreversible season lock"
summary: "SMTP, organizer access, and the public-map privacy fix are live; the platform map remains deliberately unpublished while submissions continue and locking would permanently close six open slots."
keywords:
  - "porchfest"
  - "2026-season"
  - "smtp"
  - "organizer-access"
  - "public-map"
  - "season-lock"
  - "google-forms"
  - "coordinate-review"
  - "u12"
  - "cockpit"
cwd: "/home/damienriehl/Coding Projects/porchfest"
resume_focus: "Reassess the map-publication gate with the owner while six slots remain open, capture the owner's decision about bridging late Google Forms submissions, and preserve U12's after-event gate."
repository: "porchfest"
branch: "main"
head: "c4dc521"
---

# Status at capture

This handoff supersedes the retired
`docs/handoffs/2026-09-03-season-live-smtp-pending.md`. SMTP and every other
shipped item from that handoff have either landed or are recorded here.

The 2026 season is live in production and healthy over HTTPS. The platform's
public map remains deliberately unpublished and displays "No map."

## Landed and verified

### SMTP is live

- The deployment `.env` contains the Gmail app password and has mode 600. No
  credential value is recorded in this repository.
- SMTP uses `smtp.gmail.com`, port 587, STARTTLS enabled, and implicit TLS
  disabled.
- The orchestrator verified the setup four ways: a real `AUTH` handshake before
  configuration was written, a healthy restart, an actually sent message, and
  the application's AE1 gate opening. `/self-serve/request-link` is now publicly
  surfaced.
- The From identity is currently the owner's personal Gmail. A `hello@` alias
  on the event domain was not created because the owner was travelling. Moving
  to that alias later is a one-line deployment `.env` change followed by an
  `app` restart.
- `packages/email/src/smtp.ts` supports AUTH PLAIN and LOGIN only, not XOAUTH2.
  This session checked that Gmail OAuth tokens elsewhere on the machine cannot
  be reused; this is verified behavior, not an inference.

### Organizer access exists

- Production now has organizer account id 1. Before setup, production had zero
  organizers, so nobody could reach `/admin`; the application emitted a fresh
  one-hour bootstrap link to the container log on every boot.
- The account was created by redeeming the bootstrap link server-side. The owner
  subsequently signed in successfully.
- A second, orphaned session created during setup was explicitly revoked.

### Repository changes are live

| Change            | Verified state                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #57, `c4dc521` | Deployed with `deploy_result=PASS`, integrity healthy, record counts unchanged, and the rollback tag retained. The full suite passed outside the sandbox: 52 files and 1030 tests. |
| PR #54, `a84ece9` | Season `year` is part of the schedule dependency guard.                                                                                                                            |
| PR #55, `ec0151d` | The durable import record and idempotent E6 correction script landed at `docs/operations/season-import-2026-09-03.md` and `scripts/ops-e6-rain-backup.ts`.                         |

PR #57 closed a public-data leak in `packages/web/src/routes/map.ts`. That route
previously emitted `title: venue.title` verbatim. `venue.title` is organizer
free-text, and the Goal-1 importer had synthesized it from host names; 20 of 21
publishable venues therefore paired a private individual's name with their home
address. The published label is now the venue address. A venue with a null,
empty, or whitespace-only address is excluded together with all of its acts.

## Public map gate and current tradeoff

- Publishing the platform map requires locking the season. The transition is
  irreversible because season state is forward-only:
  `if (targetIndex <= currentIndex) throw` in `packages/core/src/season.ts`.
- Once locked, corrections remain legal, but new act-to-slot assignments are
  permanently refused. Production currently has six open slots across five live
  venues.
- The owner is still accepting submissions and declined to lock the season.
- Decoupling map publication from the lock is this session's recommendation, not
  an owner decision. The map already has an explicit `mapPublishedAt` gate, so
  this session inferred that publication need not also depend on the irreversible
  scheduling transition.
- Publishing the platform map would add no visible public capability for the
  2026 event. The marketing site already serves an accurate Leaflet map from a
  committed JSON file. U12, which switches that site to the platform feed, is
  deliberately gated until after the event.

New submissions currently reach neither map automatically. They land in Google
Forms, and the platform has received zero new venues or acts since the import.
The owner has not yet decided how the remaining pre-event submissions should be
bridged.

Three coordinates remain in the `needs-review` / `cross-check-missing` queue.
This session checked all three against an independent geocoder and found a 0 m
difference. They have also appeared on the public marketing-site map since
August. The platform publishes only `verified` coordinates, so all three would
be silently excluded from its map. Their review state has not been cleared; that
was offered but not authorized.

## U12: corrected understanding

`sapporchfest-site` PR #2 has been rebased onto that repository's main branch and
is now MERGEABLE. It remains a draft and remains gated until after the event.
The repository is cloned on this machine, but its machine-local absolute path is
intentionally omitted.

There is no latent U12 schema defect. This session initially reported one after
testing PR #2's stale branch. Site main already contains the platform's canonical
`venues-map.v1.schema.json`, landed in site commit #1, with a version pattern, a
minimum season, and a `generated_from` enum. Rebasing resolved the stale branch's
over-pinning.

The schema behavior was checked against the live deployment: a platform-shaped
payload passes, while the unpublished placeholder with season 2000 and no venues
fails with `expected season 2026, got 2000`. The committed map therefore survives
validation.

Site main's pre-rebase `verify-map-data.py` accepted no CLI arguments and silently
ignored any that were supplied; it validated only the committed file. A passing
run of that version is not evidence that a candidate payload is valid.

The live marketing site still links to Google Forms from `/hosts/` and
`/performers/`. This corrects an earlier claim from this session that no Google
references remained; that claim came from searching only the homepage.

## Cockpit infrastructure findings

These findings concern cockpit infrastructure, not the porchfest repository.

- `agent-watchdog.timer` and `agent-ratchet.timer` were masked and inactive. At
  the owner's request, this session unmasked and started them.
- Model steering remains disabled with `model_steering_enabled: false`. A
  ratchet run left the relevant settings files byte-identical.
- The cockpit freeze sentinel is not honored by services that set
  `COCKPIT_ROOT`. The freeze command writes the sentinel under the user's local
  state directory, while `freeze_sentinel()` in cockpit-relative
  `agents/repo_gate.py` redirects lookup beneath `COCKPIT_ROOT` when that
  variable is present. The systemd units set it, and the redirected sentinel
  does not exist, so those services run unfrozen. This was confirmed by
  simulating the service environment.
- The cockpit working tree is on a feature branch rather than `master`. That is
  what the repeating `TIER_WRITE_WHILE_DRIFTED` entries in cockpit-relative
  `agents/events.log` report.
- Neither cockpit issue was changed here because the cockpit tree is mid-work in
  another session.

## Verification trail

`docs/operations/season-import-2026-09-03.md` is the authoritative repository
record for the import gates, archive counts, and E6 correction. Production
evidence blocks remain on the deployment host under its backups directory; that
location is machine-local and no absolute host path is recorded here.
