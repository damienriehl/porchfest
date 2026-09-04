---
artifact_contract: "ce-handoff/v1"
created_at: "2026-09-03T22:30:00Z"
title: "2026 season live and verified; SMTP setup and owner-run shakedown pending"
summary: "The verified 2026 production import, post-import archive, E6 correction, and locked-season year guard have landed; SMTP owner setup is the only blocker to the operator-controlled shakedown."
keywords:
  [
    "porchfest",
    "2026-season",
    "production-import",
    "smtp",
    "gmail-app-password",
    "shakedown",
    "rain-plan",
    "u12",
  ]
resume_focus: "With the owner present: complete the Gmail app-password and verified Send-mail-as alias setup, configure the prepared paste-safe SMTP environment, then let the owner generate, review, trigger, and record the shakedown wave; after the thaw reconcile the cockpit, and after Sept 16 merge sapporchfest-site#2"
repository: "porchfest"
branch: "main"
head: "ec0151d"
---

# Where things stand (2026-09-03, season live; SMTP pending)

Supersedes `docs/handoffs/2026-09-02-resume-run-complete.md` (retired in this
change; every open item there either landed or is re-recorded here).

## Landed this run

| What                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Season `year` joined the schedule dependency guard. A locked season with dependent schedule data now refuses a `year` edit through `assertScheduleDependenciesClear`, while year-only edits remain legal wherever event-date edits already are. The out-of-scope year-must-equal-event-date rule was dropped because it rejected legal edits and hid the duplicate-year confirmation flow. The orchestrator reran the full green suite: 52 files, 1026 tests. | PR #54, merged `a84ece9`                                  |
| **The 2026 season is live in production.** The owner authorized the import after reviewing the reconstruction. The production dry-run matched `docs/import-2026.md` field-for-field, the real run matched the dry-run, and an immediate rerun created nothing and found everything.                                                                                                                                                                           | `docs/operations/season-import-2026-09-03.md`             |
| The post-import archive passed integrity verification with 1 season, 25 venues, 33 acts, 53 contacts, 36 assignments, and 0 outbox entries; it was encrypted and copied off-site.                                                                                                                                                                                                                                                                             | `docs/operations/season-import-2026-09-03.md`             |
| The owner chose fix-forward for the E6 rain-plan correction. Venue id 9 changed `rainBackup` from true to false and version 1 to 2, with an organizer annotation in the same transaction; rerunning the correction reports `changed: false`.                                                                                                                                                                                                                  | PR #55, merged `ec0151d`; `scripts/ops-e6-rain-backup.ts` |
| The import and correction evidence, plus the idempotent E6 operations script, landed on main.                                                                                                                                                                                                                                                                                                                                                                 | PR #55, merged `ec0151d`                                  |

## Production state (verified, not claimed)

- The 2026 season is live. The dry-run, real import, idempotent rerun, E6
  correction, and post-import archive are recorded in
  `docs/operations/season-import-2026-09-03.md`.
- The app is healthy over HTTPS.
- The public map remains **unpublished** and displays "No map." This is the
  correct state because publication is a deliberate organizer action.
- The encrypted post-import archive was copied off-site after its integrity and
  record counts were verified.

## Open items, in order

1. **SMTP is owner-gated and is the only shakedown blocker.** The owner chose a
   Gmail app password with a dedicated alias on the event domain as the From
   address. Two steps are the
   owner's alone: create the app password after enabling 2-Step Verification,
   and add the `hello` alias at the event domain as a verified Gmail **Send mail
   as** sender.
   The alias can be verified because Cloudflare Email Routing has a catch-all
   forwarding domain mail to the owner's mailbox; participant replies land
   there too. The owner then pastes the app password into the prepared
   paste-safe one-liner. The SMTP adapter supports AUTH PLAIN and LOGIN only,
   not XOAUTH2 (`packages/email/src/smtp.ts`), so Gmail OAuth tokens elsewhere
   on the machine cannot be reused; this was checked, not assumed. Configuration
   keys are `PORCHFEST_SMTP_HOST`, `PORCHFEST_SMTP_PORT`,
   `PORCHFEST_SMTP_FROM`, `PORCHFEST_SMTP_USERNAME`,
   `PORCHFEST_SMTP_PASSWORD`, `PORCHFEST_SMTP_SECURE`, and
   `PORCHFEST_SMTP_STARTTLS`, with `PORCHFEST_SMTP_PASSWORD_FILE` also
   supported. Optional and non-blocking: SPF is currently inbound-only
   (`v=spf1 include:_spf.mx.cloudflare.net ~all`) and there is no DMARC record;
   adding `include:_spf.google.com` and a `p=none` DMARC policy is
   production-visible and requires owner authorization.
2. **The shakedown wave is the owner's to generate, not an agent task.** Follow
   `docs/deploy.md`, section "SMTP shakedown wave (operator only)": use only
   organizer-controlled addresses, have the owner review every stored subject,
   body, and recipient, have the owner trigger every send, and record the result
   outside the repository.
3. **`sapporchfest-site#2` (U12)** remains for the owner to merge after the Sept
   16 event.
4. **Deferred UAT residue:** rerun the NOT-EXECUTABLE stories against a
   published map, and rerun S7.1 with live Turnstile configuration. S7.1 remains
   covered by the unit suite.
5. **Cockpit reconciliation:** the freeze sentinel remained present through
   2026-09-04, so this run wrote no board or on-deck entries and read no events
   log. Reconcile after the thaw.

## Traps worth carrying forward

- `deploy/archive.sh --no-restart` quiesces the app and **leaves it stopped**.
  On an already healthy deployment, the plain form is correct. If `--no-restart`
  is used, immediately run `docker compose up -d app`; missing that restart cost
  about a minute of downtime in this run.
- The runtime image contains no `scripts/` except `organizer-link.ts`. The
  importer and any one-off operations script must be bind-mounted read-only into
  a `docker compose run --rm --no-deps` container; `docker compose exec` fails
  with `ERR_MODULE_NOT_FOUND`.
- Venue address lookups encounter supersession pairs that may differ only by a
  trailing period. The canonical row has `canonicalVenueId` set to null. An
  operations script must exclude superseded rows and refuse ambiguity.
