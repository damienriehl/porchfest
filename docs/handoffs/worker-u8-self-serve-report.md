# U8 participant self-serve implementation report

## Scope

- Branch: `u8-self-serve`
- Base: `a4fdc69`
- Plan: `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md`, implementation unit U8
- Requirements: R14, R15, R31, R32, R33; AE1; KD3 through KTD8 and KTD16

## Scenario coverage

|   # | Plan scenario                                                                                           | Passing test coverage                                                                                                                                                                                                                     |
| --: | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Expired link is refused and offers reissue                                                              | `packages/web/test/self-serve.test.ts` — `R31: refuses an expired link and offers a new one`; `packages/core/test/tokens.test.ts` — `stores only a hash, scopes the link, and refuses it after expiry`                                    |
|   2 | Per-record hourly reissue cap; known and unknown responses match                                        | `packages/web/test/self-serve.test.ts` — `R31: throttles one target while known and unknown responses stay identical`; `packages/core/test/tokens.test.ts` — `caps reissues per target record without coupling records on one address`    |
|   3 | Host headers cannot change the configured public link origin                                            | `packages/web/test/self-serve.test.ts` — `KTD16: ignores hostile host headers when building a reissue link`                                                                                                                               |
|   4 | Withdrawal, availability, and corrected-address proposals queue without changing a confirmed assignment | `packages/web/test/self-serve.test.ts` — `R33: queues withdrawal and availability without changing an assignment` (also covers venue-address correction in the same scenario)                                                             |
|   5 | Withdrawal revokes an existing link                                                                     | `packages/web/test/self-serve.test.ts` — `R31: refuses a revoked link after an approved withdrawal`; `packages/core/test/tokens.test.ts` — `revokes links when a record is withdrawn or superseded`                                       |
|   6 | One record's link cannot read or write another record                                                   | `packages/web/test/self-serve.test.ts` — `R31: a link cannot read or write another participant record`; `packages/core/test/tokens.test.ts` — `refuses a token for one record from writing another record`                                |
|   7 | No email provider means no minting and no self-serve routes                                             | `packages/web/test/self-serve.test.ts` — `R14 and AE1: hides routes and refuses minting without email`; `packages/core/test/tokens.test.ts` — `cannot mint any link when participant self-serve is disabled`                              |
|   8 | Participant edits enter the activity queue without changing a confirmed assignment                      | `packages/web/test/self-serve.test.ts` — `R15: returns an edit to the queue and keeps the confirmed assignment`                                                                                                                           |
|   9 | Direct writes to assignment, slot, status, coordinates, or organizer annotation are refused             | `packages/web/test/self-serve.test.ts` — parameterized `R14: refuses a direct write to read-only field ...` cases                                                                                                                         |
|  10 | Participant notes round-trip without overwriting organizer annotations                                  | `packages/web/test/self-serve.test.ts` — `R14: round-trips participant notes without overwriting organizer annotations`; `packages/core/test/tokens.test.ts` — `round-trips participant fields while leaving organizer annotations alone` |
|  11 | Stale participant edits lose the CAS race and do not overwrite organizer changes                        | `packages/web/test/self-serve.test.ts` — `R32: refuses a stale participant edit instead of overwriting`; `packages/core/test/tokens.test.ts` — `rolls an edit back when the organizer changed the record mid-session`                     |
|  12 | Every self-serve response is private and non-cacheable                                                  | `packages/web/test/self-serve.test.ts` — `KTD8: sends every self-serve response with private no-store caching`                                                                                                                            |

Additional coverage verifies labelled controls and 44-pixel phone touch targets, anti-bot refusal paths, invalid participant input, token supersession, provider-delivery failure recovery, and shared-contact record isolation.

## Key decisions

- Raw bearer values are returned only for delivery. SQLite stores SHA-256 hashes, record scope, expiry, revocation state, and delivery activation state.
- Reissue uses a pending-to-active lifecycle. A candidate cannot authenticate until delivery succeeds; successful activation supersedes earlier links, while failed delivery leaves the previous working credential intact.
- The unauthenticated reissue route uses the injected anti-bot adapter, the existing unconfigured honeypot/per-IP guard, and a persisted per-target hourly cap. HTTP responses do not reveal roster membership or provider outcomes.
- Outbound links are constructed only from `PUBLIC_BASE_URL`. The app refuses an email-enabled composition without that setting.
- Participant cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, restricted to `/self-serve`, and expire with the bearer.
- Participant writes retain integer-version CAS checks. A contact shared by multiple records is isolated before a record-scoped participant edit so one grant cannot change another record's effective contact.
- Withdrawal, availability, and address corrections use the existing R33 change-request repository. Confirmed assignments remain organizer-controlled.
- Assignment, slot, status, coordinate, and organizer-annotation data are rendered read-only and excluded from the editable allowlist.
- Self-serve routes are registered only through the central route registry and only when email plus a canonical public origin are configured.

## Validation summary

| Gate/check                                 | Result                                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                        | Pass                                                                                                                                                                                                                                                            |
| `npm run lint`                             | Pass with 0 errors and 2 pre-existing unused-argument warnings in `packages/core/src/access.ts`                                                                                                                                                                 |
| `npm run format:check`                     | Pass                                                                                                                                                                                                                                                            |
| `npm run check:boundaries`                 | Pass                                                                                                                                                                                                                                                            |
| U8-focused Vitest run                      | Pass: 4 files, 105 tests                                                                                                                                                                                                                                        |
| Full Vitest run excluding the SMTP catcher | Pass: 49 files, 902 tests                                                                                                                                                                                                                                       |
| `npm run check:clean-room`                 | Pass: no participant-data artifacts in the working tree or Git history                                                                                                                                                                                          |
| `git diff --check`                         | Pass                                                                                                                                                                                                                                                            |
| `npm test`                                 | Environment-blocked: 49 files and 905 tests passed; only `packages/email/test/smtp.test.ts` failed (18 tests, plus 17 unhandled setup errors) because the managed sandbox rejects its localhost listener with `listen EPERM: operation not permitted 127.0.0.1` |
| Clean-room scanner self-test               | Environment-blocked: its temporary-repository fixture cannot run `git init` in this sandbox (`spawnSync git EPERM`)                                                                                                                                             |

The SMTP failures occur before any application SMTP assertion: the catcher cannot bind a loopback port. Focused U8 tests exercise the injected email-port contract without live network I/O. The production clean-room scan itself passes; only its test harness's nested `git init` is prohibited.

The structured code-review pass completed under run ID `20260902-114628-a919b51a`. Eight deduplicated findings were validated and fixed, including failed-delivery credential preservation, timing-oracle mitigation, shared-contact isolation, strict participant input validation, bounded assignment queries, unexpected database error propagation, change-request idempotency, and migration snapshot correction. The remaining operational risk is that provider delivery uses a process-local asynchronous dispatch boundary rather than a durable job queue; a process exit between the generic `202` and delivery leaves an inert pending candidate until expiry while preserving the participant's prior working link.

## Post-deploy monitoring and validation

- Window/owner: deployment operator for the first 24 hours after enabling participant self-serve.
- Access-log checks: watch `/self-serve/request-link` response counts by `202`, `4xx`, and `5xx`; investigate any `5xx` or sustained `429` increase.
- Email checks: watch provider failure outcomes and confirm a failed delivery leaves the prior active link usable; never log bearer URLs or message bodies.
- Database checks: inspect counts of pending, active, expired, and revoked participant links by record, and confirm no pending candidate remains after its delivery attempt finishes.
- Healthy signal: generic `202` reissue responses, expected email arrival, successful canonical redirect to a hardened cookie, and participant edits appearing in the organizer activity queue without assignment changes.
- Failure/rollback trigger: any cross-record data exposure, cacheable participant response, link built on an unconfigured origin, or unexpected `5xx` on reissue. Disable the email provider to hide the whole surface, retain the database for diagnosis, and roll back the application image with its schema-compatible backup path.

## Delivery status

- Push: not performed, as requested.
- Commit/clean-tree status: blocked by the managed environment. This linked worktree points at `/home/damienriehl/Coding Projects/porchfest/.git/worktrees/porchfest-u8`, which is outside the writable roots; `git add` fails while creating `index.lock`. The implementation and this report therefore remain as tracked modifications and untracked files and cannot be committed or reduced to a clean tree from this session.
- Suggested commit split once Git metadata is writable: `feat(core): add participant magic-link lifecycle (U8-a)`, `feat(web): add participant self-serve routes (U8-b)`, and `docs: record U8 self-serve handoff`.

## PR #48 review fixes

- Reissue activation now revokes prior active links and older pending candidates while preserving newer pending candidates, ordered deterministically by creation time and row ID. `packages/core/test/tokens.test.ts` proves both overlapping-delivery completion orders, including tied timestamps.
- Signup and self-serve edits now share the same 5–240-minute duration validator and rendered input bounds. `packages/web/test/self-serve.test.ts` proves 1 and 1000000 are refused without persistence and with submitted values retained, while 5 and 240 are accepted.
- Signup and self-serve edits now share one field-length policy; every submitted edit field is checked before the token repository update, with oversized values omitted from the refusal page. `packages/web/test/self-serve.test.ts` proves an over-limit participant note is named, refused, and not persisted, while a boundary-length description is accepted.
