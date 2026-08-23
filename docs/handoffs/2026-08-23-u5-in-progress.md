---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-23T19:45:00Z"
title: "Porchfest U5 — four of six PRs merged, two remain"
summary: "U4 is merged. U5 is landing as a sequence of small PRs: access, first-run setup, queue and record editor, and statuses are all merged to main and green. Two remain: placeholders/supersession plus change requests, then retention with an opt-in consent field."
keywords:
  [
    "porchfest",
    "u5",
    "organizer-admin",
    "r9",
    "r34",
    "r5",
    "r32",
    "ae2",
    "r26",
    "r33",
    "r35",
  ]
resume_focus: "PR 5 of 6 — the R26/R27 placeholder and supersession surface plus R33 change requests; then PR 6, retention"
repository: "porchfest"
branch: "main"
---

# Porchfest U5 — four of six PRs merged, two remain

## Where this stands

`main` is green: six gates plus the container smoke, **325 tests** (206 when U4's
review began). Everything below is merged; nothing is in flight.

| PR  | What                                                               | Commit    |
| --- | ------------------------------------------------------------------ | --------- |
| #8  | Organizer access — bootstrap link, invites, sessions, deactivation | `04f3805` |
| #9  | First-run setup (R34)                                              | `1db7f43` |
| #10 | Activity queue and record editor (R5, R6 fields, R15, R32)         | `f4ffb23` |
| #11 | Record statuses and AE2 (R6, AE2)                                  | `a982460` |

U4 merged earlier the same day as `34144d1` (PR #6), with its learnings in
`docs/solutions/` via #7.

## What remains

**PR 5 of 6 — R26, R27, R33.** Core already has `promotePlaceholderAct`,
`promotePlaceholderVenue`, `supersedeAct`, `supersedeVenue` and `supersedeContact`
from U3, so this is largely an admin surface over existing domain functions, plus a
new `change_requests` model. R33's participant-facing submission belongs to U8; U5
owns only the queue item and the organizer's apply-or-reject.

**PR 6 of 6 — R35 retention.** Damien chose **anonymize by default, keep an opt-in
re-invite list**, which has a knock-on: the public signup forms must ask for that
consent, so U4's forms and the `contacts` schema are reopened here. He also chose
the **deletion receipt** shape: the app deletes the rows it owns, writes a durable
non-identifying deletion record for the backup rotation to consume, documents the
operator procedure, and shows the organizer which parts are done and which await the
next backup cycle. Decisions are on the sheet
`porchfest-2026-08-23-1451-u5-scope-decisions`.

## Decisions already made, so do not re-ask

All on cockpit Decision Sheets, with answers folded:

- U4: season timezone column; wire the anti-bot adapter and render its widget.
- U4 follow-ups: adapter publishes client hints; rebaseline the plan; render the full
  submission split public/private; give performers a notes field; commit and push
  without a PR; leave fonts deferred.
- U5 scope: a sequence of PRs; deletion receipt for the operator; opt-in re-invite
  list; capture everything R34 lists at first run.

## Constraints a later PR must not undo

- **KTD7 everywhere.** Status changes, record edits and link redemption all put the
  predicate inside the statement and take the verdict from the affected-row count.
  Four separate mutation tests exist across `access`, `queue`, `status` and the U4
  signup guards; each was restored byte-identical by `sha256sum`.
- **The queue's dismissal carries a VERSION.** That one column is R5's per-organizer
  worklist, R15's re-surfacing, and the guard against swallowing an edit that lands
  while an organizer reads. Do not "simplify" it to a boolean.
- **Deactivation is checked per request**, which is what makes a deactivated
  organizer's session die on its next request without hunting session rows.
- **Bootstrap links die when the first organizer exists.** A container that restarted
  twice printed the line twice.
- **CSRF tokens are path-bound.** A page with two forms carries two tokens. Test
  helpers must select a token by form action, not take the first on the page.
- **The anti-bot provider is named only in `packages/antibot` and the composition
  root.** `web` renders the adapter's client-hints descriptor blind. Verify with
  `grep -riE 'cloudflare|turnstile' packages/web/src`.
- **`PORCHFEST_TRUSTED_PROXY_HOPS=1` in `compose.yaml` is topology-specific** — right
  for the checked-in Caddy stack, wrong for a direct deployment.

## Traps this session actually hit

- **An edit that silently did not apply.** A `python` string replace missed because
  the anchor had been reformatted, so a status control rendered nowhere while
  typecheck stayed green and the route existed. No test caught it. Writing the
  rendered page to disk and reading it did. Prefer asserting on rendered output over
  assuming a view edit landed.
- **`check-core-boundary.mjs` matches any `.get(` in `packages/web/src`**, so a plain
  `FormData.get()` reads as a route registration. Both admin route files parse forms
  by iterating instead. The regex is worth tightening; it will keep catching innocent
  code.
- **Drizzle's generated migration for a new column with a CHECK constraint rebuilds
  the table** and SELECTs the new column from the old one, which fails on a populated
  database. Dropping the CHECK produced a clean additive `ALTER`. Every migration
  `0004`–`0009` is additive; verify that before committing one.
- **The browser cannot hold an admin session over plain HTTP**, because cookies are
  `Secure`. Authenticated pages were verified by capturing the rendered HTML from the
  running server and loading it with its real stylesheet. A full end-to-end browser
  run needs the Caddy TLS stack.

## Known residual, deliberately open

Web tests assert against core's SQLite file directly, which is a KTD2 smell in a
web-package test. It stays because the Verification Contract requires real-database
assertions and core exposes no test-support seam to read through. **Adding that seam
is the right first move in PR 5 or 6**, and would let `admin-records.test.ts`,
`setup.test.ts` and `signup-hardening.test.ts` all stop reaching past the seam.
