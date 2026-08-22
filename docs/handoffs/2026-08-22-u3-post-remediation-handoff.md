---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-22T16:35:19Z"
title: "Porchfest U3 after the remediation review"
summary: "U3 is implemented, reviewed twice, remediated twice, and fully committed on feat/u3-schema; four residual P2s and two owner decisions remain, and nothing has been pushed."
keywords: ["porchfest", "u3", "code-review", "remediation", "compare-and-swap", "mutation-testing", "boot-connection"]
cwd: "porchfest repository root"
resume_focus: "Clear the four residual P2s, get Damien's two decisions, then ship U3 or start the next unit"
repository: "porchfest"
repo_root_sha: "dbf6a6dd03fa91654c65c7364dc924cd6b4160cf"
branch: "feat/u3-schema"
head: "2c0fb70b21a757a3e61af05c7d71f1c1382e0b4f"
---

# Porchfest U3 after the remediation review

## Where this stands

U3 (season-scoped schema, season state machine, record lifecycle) is **implemented,
reviewed twice, remediated twice, and fully committed**. Seven commits sit on
`feat/u3-schema` above `7d40d23`, which is still where `main` points. **Nothing has been
pushed** — 12 commits are ahead of `origin/main`.

Working tree clean. `npm run typecheck`, `npm run lint` and `npm test` all pass;
the suite is **152 tests across 13 files**, up from 117/11 when the first review ran.
The full container smoke test passes end to end.

## What happened, in order

1. **First review** of `7d40d23..8563c2a` — ten reviewers including an independent Codex
   adversarial pass. 27 raw findings merged to 19, validator confirmed 13.
2. **First remediation** — five Codex workers closed all 13 plus one further P1 found
   during the fixing. Committed as `27b8fd5`, `1f92c52`, `85b4371`, `733a8cf`, `8dd0221`,
   `61887b3`.
3. **Second review**, of the remediation itself (`8563c2a..61887b3`) — ten reviewers
   again. This is the important one: **the fixes had introduced real defects of their
   own.** 17 findings merged to 13; the validator confirmed 8 of 9 P1s.
4. **Second remediation** — three Codex workers, committed as `ccd7223` and a follow-up.
   Note: `ccd7223` captured a green but *partial* state of the core worker, because its
   report file was mistaken for a completion signal while the process was still alive.
   The follow-up commit completes that work. A worker's report file is not a done signal;
   only the process exiting is.

The lesson worth carrying: reviewing a remediation was not ceremony. It found a guard
hole with two working reproductions, a boot path that could not start at all under a
common configuration, and a test that could not detect the thing it named.

## Verification standard used, and why it matters here

This branch's own learning doc is `docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`.
Its claim: for a guard whose failure mode is silent, a green suite is not evidence of
coverage — only breaking the guard and watching a *named* test fail is.

That standard was applied to every guard added in the second remediation: each was
neutralized, its named test observed failing, restored, and `sha256sum` confirmed
byte-identical. The `pf-fix-core` worker's report records six such observations.

**A caveat the next agent should know:** during the first remediation I told the user the
FK pragma was "proven" by observing `SQLITE_CONSTRAINT_FOREIGNKEY` on a violating insert.
That was wrong, and the second review caught it — better-sqlite3 12.11.1 ships compiled
with `SQLITE_DEFAULT_FOREIGN_KEYS=1`, so the test passed with the pragma line removed.
Fixed in `ccd7223` by also asserting the application makes the call. Treat any
"verified" claim in the earlier worker reports with that in mind.

## Residual work — four P2s, none blocking

All four were confirmed real by reviewers but deliberately not dispatched, to land the P1s
cleanly while context lasted. None is urgent.

1. **Smoke probe accepts a malformed migrated schema** — `scripts/container-smoke.sh`.
   Found only by the cross-model reviewer. The probe uses `arrayContaining` semantics, so
   it checks the eight tables are *present*, not that their columns are right. A migration
   that created a table with the wrong shape would pass.
2. **Three hand-copied table lists must move in lockstep** — `packages/core/test/schema.test.ts:7`,
   `packages/core/test/connection.test.ts:9`, `scripts/container-smoke.sh:36`. Nothing
   enforces agreement. Correctness proposed deriving them from the schema module instead.
3. **`assertCanonicalActUnassigned` re-queries per assignment** — `packages/core/src/season.ts`.
   A genuine diff-introduced N+1 on the `assignSlot`/`correctAssignment` paths. Harmless at
   porchfest scale (low hundreds of rows), and `supersedeAct` in the same file already shows
   the fix: load the season's acts once into a Map.
4. **Promotion re-points `email_log` but not `annotations`** — `packages/core/src/records.ts`.
   Both carry the same polymorphic `recordType`/`recordId` pair. Not reachable today because
   no annotation writers exist, so it will become live when they do.

## Two decisions that are Damien's, not the next agent's

Neither blocks other work. Both have been raised with him and neither was answered.

1. **The records-repository transaction seam.** The eight season-legality wrappers in
   `season.ts` are **not atomic** with the write they delegate to: `createRecordRepository`
   binds `CoreDatabase`, while `db.transaction` yields a `BetterSQLite3Transaction` that is
   not assignable to it. Threading a transaction handle through `records.ts` would fix it
   but changes the seam KTD2 governs and that U4–U12 build on. Two independent reviewers
   confirmed the exposure is narrow today (single-process, single-connection SQLite) and
   widens with a multi-worker web tier. A worker was explicitly told to stop and report
   rather than restructure this on its own initiative, and it did.
2. **Where the platform plan lives.** The plan governing porchfest is at
   `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` **inside a worktree of a
   different repository** (its path is in the private copy). Porchfest has
   no `docs/plans/` of its own. This is the root cause of a machine-local path leaking into
   a committed handoff twice in one day, and it means a blank `ce-work` invocation cannot
   discover porchfest's own plan. Copying or moving the plan into porchfest would fix the
   leak class at its source. This is my recommendation, not his decision yet.

## Decisions Damien did make, already applied

Recorded in `briefs/qa/porchfest-2026-08-22-1356-u3-review-decisions-answers.json`
(machine-local, in the cockpit tree):

- **Boot wiring belongs in U3**, not deferred to a later unit. Built as
  `packages/core/src/storage/connection.ts`.
- **The prior-season contact re-invite may reach past the immediately preceding season.**
  Behaviour unchanged; a comment in `season.ts` records that it is deliberate.

## Constraints that must survive into the next session

- **The compare-and-swap guard is pinned by KTD7.** It stays inside the UPDATE with its
  verdict from the affected-row count. Do not restructure it, do not consolidate the
  per-entity CAS functions into a generic helper, do not swap `.changes` for `.returning()`.
  Both consolidations have now been proposed and refused three separate times; a reviewer
  raising them again is corroboration of the temptation, not a new idea.
- **Delegation is codex-first.** `agents/tier.json` sets `worker_route: codex`. Implementation
  fans out to Codex workers via `agents/worker-wrapper.sh`; the orchestrator verifies
  artifacts itself rather than trusting worker reports.
- **`worker-wrapper.sh` runs Codex in the foreground** and its `status.json` is not
  trustworthy — it read `starting` with zero tokens for sixteen minutes while a worker was
  doing correct work and had already written its report. Believe `worker.log`, `git status`,
  and the worker's own report file instead. A terminal `failed` may only mean the
  orchestrator sent TERM to a worker whose work was complete.

## Cockpit learnings, deliberately not written

Five learnings were earned during this work but belong to the **cockpit** repo, and the
user scoped this session to porchfest only. They are captured in full, with the specific
action for each, in a published artifact — ask Damien for the "Cockpit learnings handoff"
link, or regenerate from `docs/handoffs/` history.

Two things that handoff records and a cockpit agent will need:

- A worktree was prepared and left unused for that work (path in the private copy),
  branch `docs/u3-review-learnings`, off `master`. It exists so the next
  agent does not write onto `fix/shared-sync-lock-validation`, which the main cockpit tree
  is currently sitting on.
- Two cockpit convention violations were observed and **deliberately not touched**: the main
  tree is on a feature branch rather than `master`, and five worktrees live under
  the repo rather than the conventional external location. Both involve live branches; confirm with
  Damien before acting.

## Authoritative references

- **Plan** — `docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md` in the
  woodshed-porchfest worktree (machine-local). Read `### U3.`, KTD2 (package seam), KTD7
  (the pinned guard), and `## Definition of Done`.
- **The standard this branch holds itself to** —
  `docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`. Its
  `records.ts` line citations drift 1–2 lines against the current tree; the substance is
  correct.
- **Domain vocabulary** — `CONCEPTS.md`. Three entries were corrected during this session
  after a grounding validator found they described the *plan* rather than the code; trust it
  now, but verify any behavioural claim against source before relying on it.
- **Worker reports** — nine files under `docs/handoffs/worker-*.md`. Each records what one
  Codex worker changed and what it observed. `worker-fix-core-report.md` holds the six
  mutation observations from the final remediation.
- **Review artifacts** — two `ce-code-review` run directories (first review and remediation
  review), each holding the merged findings plus per-reviewer artifacts. Paths are in the
  private copy; they are OS-managed temporary storage and may already be gone.

## Plausible next steps

These are sequential rather than exclusive; the first is the smallest useful unit of work.

1. **Clear the four residual P2s** in one Codex batch — they are independent and none needs
   a decision. The table-list consolidation (2) and the smoke-probe strengthening (1) pair
   naturally since both touch `container-smoke.sh`.
2. **Get the two decisions above from Damien**, particularly the plan's location, which is a
   recurring source of leaks rather than a one-off.
3. **Ship U3** — nothing is pushed and no PR exists. `ce-code-review`'s gate has been
   satisfied twice over; the remaining question is only whether Damien wants it pushed.
4. **Or start the next unit** — U4 (public signup forms) and U5 (organizer admin) are both
   fully specified in the platform plan, so `ce-work <plan-path>` executes them directly. No
   new plan is needed; writing one would fragment the decision record.
