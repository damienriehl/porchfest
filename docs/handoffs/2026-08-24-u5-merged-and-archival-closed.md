---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-24T03:00:00Z"
title: "U5 merged, the archival gate merged, and archived records are read-only"
summary: "All six U5 PRs plus #18 and #21 are on main at 450 tests. U5 still is not Done: its Definition of Done is a human UAT no agent can perform. U6 is next."
keywords:
  ["porchfest", "u5", "u6", "withdrawal-gate", "archival", "r33", "gh-auth"]
resume_focus: "U6 — assignment and deterministic suggestions — then the human UAT that closes U5"
repository: "porchfest"
branch: "main"
head: "34d40d0f183db13e0ad782e56351b5f2050ea277"
---

# U5 is merged, archival is closed off, and archived records read as records

## Where this stands

Nothing is blocking. Both PRs opened and merged after `gh` was re-authenticated:

| PR      | Contents                                                                      | Merge commit |
| ------- | ----------------------------------------------------------------------------- | ------------ |
| **#18** | The archival gate, and four admin paths that name a refusal instead of 500ing | `2e27a12`    |
| **#21** | The archived record page is read-only, per Damien's decision-sheet answer     | `34d40d0`    |

`main` is at **450 tests / 30 files**, six `OK:` lines, clean-room scan green.

## What landed on main

| PR      | Contents                                                     | Merge commit |
| ------- | ------------------------------------------------------------ | ------------ |
| **#13** | R26 placeholders, R27 supersession, R33 change requests      | `77c214e`    |
| **#17** | R35 retention, anonymization, receipts, self-enforcing sweep | `8381988`    |

#17 was rebased onto the new `main` after #13 squash-merged, re-verified, and
merged clean. `main` is at 436 tests.

**U5 is code-complete and merged, but still not Done.** Its Definition of Done is
a human UAT — an organizer _other than Damien_ completing the Tuesday-night loop
unaided on a local instance. No test count substitutes for it and no agent can
perform it.

## The withdrawal-gate branch

Four commits, pushed, **445 tests / 30 files**, all six `OK:` lines, clean-room
scan green over working tree and history.

`setRecordStatus` was the only mutation in the season repository without a
correction gate — verified against all the others, which assert first. So an
archived season still accepted a status change from two directions, and because
withdrawing reopens the slot the record held, that reached the schedule, not just
the record. The gate resolves the row for its season id and asserts before either
half of the transaction. KTD7 is untouched: the version predicate stays inside
the update statement and the verdict is still the affected-row count.

Four admin paths that could reach a lifecycle refusal now answer a named 409
instead of a bare 500 or a silent success. See the PR body for the before/after
table.

## What review caught, in order — this is the part worth reading

Three high-effort rounds. Each round found something the previous one did not,
and the first two found defects a passing suite did not.

1. **The field edit still 500'd.** And this branch had made that worse: the
   refusal page it added renders the edit form, so the page telling an organizer
   their records were left unchanged handed them a form whose next click was a 500. Reproduced empirically by the reviewer.
2. **The address request walked around the gate entirely.** Archiving does not
   bump record versions, so `applicable` stayed true: Apply redirected into the
   editor, the organizer reviewed the proposed address, hit Save, and _only then_
   met the 409. Withdrawal and availability refused at the click.
3. **No correctness bug.** Round three instead confirmed the gate against the
   regression that would have mattered — that nothing legitimately writes to an
   archived season — by checking `retention.ts` writes its tables directly and
   never goes through the season repository.

Every finding from rounds one and two is closed. Round three's are residuals,
recorded in the PR body and, for the two that need a decision, on the board.

## Open decisions on the board

Ask `porchfest-2026-08-24-0253-…-archived-season-affordances`, two questions,
neither blocking:

- **What an archived season's record page should offer.** The gate is
  server-side only; the views have no season-state awareness, so the refusal page
  re-offers the action it just refused with a live CSRF token. Correct on the
  server, contradictory on the screen. What an archived record page _should_ look
  like is a design call.
- **Whether the address change-request gate belongs in core** rather than the
  route.

Its publication hit degraded mode ("URL to follow"), so the board picks it up on
its next sync; `cockpit-decide sweep` reconciles the receipt afterward.

## Two residuals nobody has decided yet

- **`changeRequests.record()` has no season gate.** Both signup creators assert
  `"signup"` legality; `record()` checks only that the target matches. Now that
  the apply side refuses, a withdrawal filed after archival enters the queue and
  can never be applied — the organizer's only exit is `reject`, which files a
  participant's withdrawal as refused. Unreachable today (no route calls it);
  reachable the moment the participant portal lands.
- **The change-request refusal is a bare fragment** with no shell, stylesheet, or
  link back to the queue. Pre-existing pattern, but this PR makes it the outcome
  of a routine click.

## Constraints a later PR must not undo

Everything in the previous handoff still holds — KTD7 everywhere, a house-level
coordinate _is_ a home address, `email_log` survives anonymization, a deletion
receipt has two states, the sweep must never break boot, the core test-support
seam is test-only, `admin.ts` keeps its own trimming `readFields`. Added by this
branch:

- **The archived wording in `lifecycleRefusal` is byte-identical on purpose.**
  The helper now reads `error.state` instead of asserting archival, but the
  archived string is unchanged because existing tests assert on that prose.
- **The non-archived branches are unreachable and deliberately kept.**
  `correction` is illegal only in `archived`, and `transitionSeason` is
  forward-only, so no route can produce them. They exist so a future widened
  catch cannot silently claim a season is archived when it is not. Their tests
  live in a `refusal copy helpers` block that says so — do not "fix" them into
  route tests, and do not delete the branches as dead code.
- **An unknown record id must keep answering 404.** The gate's existence read
  moves a missing record from the conflict class to the lifecycle class;
  `findItem` runs before the lifecycle branch so the not-found path is preserved.
  That contract shift is documented at the gate.

## How the work was done, and the trap in it

Implementation went to Codex workers through the CE cross-model controller, per
this root's `worker_route=codex`. This session orchestrated, inspected every
transport diff, and owned all verification and canonical commits.

**The first two attempts were wasted, and the cause will bite the next session.**
A controller worktree contains tracked files only, so it has no `node_modules`,
and the sandbox has no network — the worker wrote correct code and then could not
run a single gate. The full write-up, including why a `node_modules` _symlink_
does not work and why it must be removed again before `terminalize`, is in the
cockpit repo at
`docs/solutions/2026-08-24-cross-model-worker-cannot-verify-its-own-work.md`.
Read it before dispatching a worker in this repo.

Smaller one: `cockpit-decide file` prepends `<repo>-<timestamp>-` to the slug you
give it, so passing a slug that already starts with a date produces a doubled
stem. Harmless, but pass a bare slug.

Code review ran through the harness-native reviewer, because `ce-code-review`
needs subagent dispatch and this session was instructed not to spawn agents
unasked. Same call the previous session made, same caveat: a future session with
that constraint lifted should use the full CE review roster.

## Two environment traps that cost real time today

**Node 25 breaks the whole suite, and it looks like a catastrophic regression.**
This project targets Node 24 — `engines: ">=24"`, both CI jobs pin
`node-version: 24`, and the Dockerfile is `node:24-slim`. But nvm's default on
this box is v25.2.1, and `better-sqlite3`'s compiled binary is
`NODE_MODULE_VERSION 137` (Node 24) while Node 25 demands 141. Switch node and
**258 tests fail across every file**, including files nobody touched. It reads
exactly like a broken change.

The fix is `nvm use 24`, not `npm rebuild` — rebuilding would compile against
Node 25 and break parity with CI and the container. A `.nvmrc` would prevent it
outright; Damien has not been asked whether he wants one, since it is a choice
about his own tooling.

**A second agent works in this repo.** Two commits that this session did not
author — `83deeed` and `f84fef5` — appeared on its working branch mid-run,
editing the same file toward the same goal, and were pushed to
`feat/archived-season-read-only`. Damien's ruling: _that is another agent; let
them do their work, and do yours — push and merge your own work, not theirs._
So this session moved its work to `feat/archived-records-read-only` and shipped
that as #21. **`feat/archived-season-read-only` is the other agent's branch.**
Its base `0a088ba` reached `main` through #21's squash, so that branch needs a
rebase before it can land — but it is not this session's to rebase.

Practical consequence for a later session: before dispatching a worker here,
expect the canonical checkout to move under you. The controller refuses
`integrate` with "canonical HEAD advanced outside the recorded wave" and
refuses `prepare` with "canonical branch changed" — both are that, not a bug.

## Next, in order

1. **U6 — assignment and deterministic suggestions.** Double-booking guards,
   shared-member conflicts, ranked explainable suggestions, AE3. A large unit
   that deserves a fresh session with full budget.
2. **The human UAT that actually closes U5.**
3. Two residuals nobody has decided, listed above.

## References

- `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` — U5 is the
  `### U5.` section; the gates are in `## Verification Contract`.
- `packages/core/src/season.ts` — `setRecordStatus` and the gate.
- `packages/web/src/routes/admin-records.ts` — the four refusal paths.
- `docs/solutions/workflow-issues/a-green-privacy-gate-that-never-read-history.md`
  — still current: never write a realistic phone number, address, or email into
  a test or a doc.
