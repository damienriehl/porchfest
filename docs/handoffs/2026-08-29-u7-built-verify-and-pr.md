---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-29T00:00:00Z"
title: "U6 in PR #26; U7 built in the last two hours of the weekly window — verify, then PR"
summary: "U6 is ready to merge on PR #26. U7 (email waves, outbox, SMTP adapter, outbox screens) was built by Opus workers on branch u7-email-waves-and-outbox in the final two hours before the weekly quota reset; it has a review pass applied but still needs a fresh-eyes gate run, a PR, and the human UAT task 5."
keywords:
  [
    "porchfest",
    "u6",
    "u7",
    "outbox",
    "smtp",
    "waves",
    "opus-workers",
    "node-24",
  ]
resume_focus: "Finish U7: run the full gate on u7-email-waves-and-outbox, open its PR stacked on #26, then run the organizer UAT"
repository: "porchfest"
branch: "u7-email-waves-and-outbox"
head: "8bdffd6"
---

# Two branches are open. Read this before touching either.

## U6 — PR #26, looks merge-ready

`https://github.com/damienriehl/porchfest/pull/26`. CI green on `2a8e1a0`,
both Codex review threads fixed and resolved, quiet. The babysit run reported
"cautiously ready" because the Codex GitHub reviewer only reviews on PR-open or
an explicit `@codex review` comment, so it has not re-read the fix push.
Merging is Damien's call. Everything the 2026-08-29 U6 handoff said still
holds (it is the previous file in this directory, retired by this one only
where it overlaps).

## U7 — built fast, on Damien's explicit instruction, by Opus workers

At 22:5x on 2026-08-28 (03:0x UTC), Damien said: weekly limit resets in two
hours, do as much as possible with Fable orchestrating and **Opus** workers.
That overrode the standing Codex-only worker policy for that window only; the
policy is back to `worker_route=codex` afterward. U7 was decomposed and run as:

| Unit | Worker | What                                                                                                                                                                                            |
| ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U7A  | Opus   | core: `waves.ts` (six templates), `outbox.ts`, migration 0013                                                                                                                                   |
| U7B  | Opus   | `packages/email`: SMTP on `node:net`/`node:tls`, env selection, README                                                                                                                          |
| U7C  | Opus   | web: `/admin/seasons/:id/outbox`, wave review, edit, send, export                                                                                                                               |
| U7D  | Opus   | eleven verified review findings on U7A/U7B (P0 address rerouting, P1 recipient deletion on regenerate, P1 decorative send version guard, cleartext AUTH without STARTTLS, TLS upgrade crash, …) |

Workers ran in a **shared checkout** (no controller worktrees), on disjoint
file sets, and were told not to touch git; the orchestrator committed each
unit path-limited. The full `npm test` gate was green after U7A+U7B
(572 tests). Check the last commits on the branch for U7C/U7D and whether the
final gate ran — the session may have run out of quota before the tail.

What U7 decided that the plan left open:

- **Templates are TypeScript constants** ported verbatim from Goal-1 with
  `SAP Porchfest` → `{{event_name}}`; a sixth `post_event` template exists.
- **`email_log` is the immutable send history**, extended with nullable
  `address`, `outcome`, `message_id` rather than a second table.
- **Recipients are created only for contacts with an email**; `organizer_phone`
  renders blank because `seasons` has no such column (a later schema decision).
- **No new dependencies** — the SMTP client is hand-written; STARTTLS and
  implicit TLS are tested only through flags, not a live TLS handshake.
- **`.env.example` was not updated** (the worker was denied the path). Add:
  `PORCHFEST_SMTP_HOST=`, `PORCHFEST_SMTP_FROM=`, `PORCHFEST_SMTP_PORT=587`,
  `PORCHFEST_SMTP_SECURE=false`, `PORCHFEST_SMTP_STARTTLS=true`,
  `PORCHFEST_SMTP_USERNAME=`, `PORCHFEST_SMTP_PASSWORD=`,
  `PORCHFEST_SMTP_PASSWORD_FILE=` — empty except the two defaults.

## Do these next, in order

1. `source ~/.nvm/nvm.sh && nvm use 24 && npm run typecheck && npm run lint && npm run format:check && npm test` on `u7-email-waves-and-outbox`. Fix or revert anything red before reading further.
2. Read the private review findings copy (machine-local, see the private handoff) against the U7D commit; anything skipped there is a residual for the PR.
3. Open the U7 PR against `u6-assignment-and-season-transitions` (stacked) or `main` after #26 merges. Run the harness `code-review` or `ce-code-review` on it — U7C never had an independent review.
4. Update `docs/operations/organizer-uat.md`: task 5 (produce the message) is now runnable; the "Before you can run this" section still says U7 is unbuilt.
5. Run the human UAT that closes U5.

## Traps that cost time this session

- **Node 24** — every shell. **Trailer rebases break the ce-work controller's
  ancestry check** (`integrate` refused after commits were rewritten to add
  `Co-Authored-By`/`Claude-Session` trailers); add trailers at commit time.
- **A harness-native `code-review` fork can die silently**; its verifier
  transcripts under the session's `subagents/` carry the verdicts.
