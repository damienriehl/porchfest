Porchfest U3 hygiene report

Handoff path change

Before:
plan:<home>/worktrees/woodshed-porchfest/docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md  (operator home path redacted for this committed copy)

After:
plan:2026-08-20-0830-feat-porchfest-platform-plan.md  # porchfest platform plan in its own worktree

The rest of the handoff contains no other absolute home-directory path or path outside this repo. The conventional ~/Coding\ Projects/porchfest references on lines 7 and 26 were reviewed and intentionally left unchanged as directed.

Schema table set

The tables declared in packages/core/src/storage/schema.ts are: acts, annotations, assignments, contacts, email_log, seasons, slots, and venues. No table besides email_log was missing. expectedTables now matches this eight-table set exactly.

Gate results

npx vitest run packages/core/test/schema.test.ts: PASS (1 file, 5 tests).
npm run typecheck: PASS.
npm run lint: PASS.
npm test: PASS (11 files, 128 tests, core boundary checks, and clean-room scan). The first sandboxed attempt passed all Vitest tests and boundary checks but scripts/clean-room-scan.test.mjs could not spawn git for its temporary fixture (EPERM). A permitted rerun passed. That initial failure was attributable to the execution sandbox, not schema.test.ts, these changes, or another worker's file; no worker-owned test failure occurred.
