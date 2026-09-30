---
title: Retain conditional admin-records timeout watch
type: chore
status: ready
execution: knowledge-work
date: 2026-09-30
---

# Goal

Establish whether a third matching hosted CI timeout occurred before changing diagnostics.

## Evidence and decision

The August 29 investigation (`../handoffs/worker-ci-admin-records-timeout-report.md`)
identifies runs `32712015538` and `33262541911`, twenty passing contended local runs,
and suite-wide timing inflation. It does not prove the exact runner failure cause.
Its original delivery header predates the documentation landing in PR #32.
The current `packages/web/test/admin-records.test.ts` still creates isolated temporary
runtimes, closes them after each test, and uses in-process requests.
`vitest.config.ts` disables file parallelism and does not raise the timeout.
No third recurrence is established by this offline lane; absence of local evidence
is not a no-recurrence result. Retain the Later card. No instrumentation added.

## Implementation units

1. Authorized network executor: enumerate all GitHub Actions runs and attempts
   since 2026-08-29 through the inspection time, including successful reruns of
   failed attempts. Use `gh run list --limit 100 --json databaseId,createdAt,conclusion,attempt,url`
   and paginate via the Actions API until the date boundary is covered. Inspect
   candidate attempts with `gh run view RUN_ID --attempt ATTEMPT --log-failed`.
   Record run/attempt IDs, failing test, timeout, and file/full-suite durations;
   sanitize any copied logs. Expired/missing logs leave recurrence unknown.
2. Compare against the two known runs; count distinct matching failing runs,
   not rerun attempts of the same incident. If no third run is evidenced, retain
   monitoring with the inspected date range. If a third is evidenced, add CI-only
   elapsed phase timings for mkdtemp, runtime/migrations, fixtures, dispatch and
   cleanup. Log durations and phase labels only, with no session or participant values.
3. Run admin-records plus the repository gates using Node >=24, compare failed
   and rerun timings, and obtain review before publication. Do not raise timeouts.

## Verification and acceptance

Local source inspection supports retaining the existing behavior. This checkout
has no installed Vitest and runs Node 22.22.1 (package.json requires >=24).
`npm test` exits 127, `vitest: not found`; no fresh suite pass is claimed.
The dependency-free boundary self-test and boundary check pass. Remote history
inspection is still required before this item can be closed or diagnostics changed.

## Rollback and integration

This document belongs on default main independently of the coverage branch.
Revert this document's commit if superseded. Any future diagnostic change has its
own reviewed revert commit; no code or CI setting was changed here.
