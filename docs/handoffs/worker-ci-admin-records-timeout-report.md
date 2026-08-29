# CI admin-records timeout investigation report

- Date: 2026-08-29
- Branch: `ci-admin-records-timeout`
- Baseline: `010ff5491d93e4b547e423a05ea43c086a7f53fa`
- Delivery state: evidence report committed locally; not pushed or merged

## Outcome

The two CI timeouts did not reproduce, and the investigation found no leaked
request, timer, server, database, or other per-test work to fix. No production
code, test, Vitest configuration, dependency, or lockfile was changed.

The evidence points to a transient hosted-runner stall or resource slowdown,
not to one slow operation in `admin-records.test.ts`:

- run `32712015538` timed out in the first test in the file, before any previous
  test could leave work behind;
- run `33262541911` slowed many tests in the file and unrelated later files at
  once;
- the successful reruns cut the file and full-suite times sharply without a
  relevant code change; and
- twenty contended local runs completed without a timeout. The slowest test was
  72 ms, and the slowest suite was 1.88 s.

The logs cannot distinguish CPU scheduling from filesystem or disk latency on
the hosted VM. That narrower infrastructure cause remains uncertain. Because
there is no source defect or reproducible legitimate greater-than-five-second
workload, raising `testTimeout` would only mask the unobserved runner stall and
was deliberately not done.

## What `boot()` does for every test

`packages/web/test/admin-records.test.ts:32-109` performs a complete isolated
application setup for each test:

1. `mkdtemp()` creates a new `porchfest-admin-*` directory under the operating
   system temporary directory and records it for cleanup.
2. `createTestingRuntime()` receives that directory and a fixed test session
   secret.
3. `packages/web/src/composition.ts:268-326` creates the directory, loads the
   configured secret, constructs null adapters, opens a fresh `porchfest.db`,
   creates the core and Hono app, runs the boot retention sweep, and announces
   the bootstrap organizer link.
4. `packages/core/src/storage/connection.ts:19-30` opens the new SQLite file,
   enables foreign keys, and synchronously applies all 14 migration files.
5. `boot()` performs two in-process sign-in GET/POST pairs, creates a season,
   creates a second organizer invite and session, and creates a host signup.

The test file does not use `packages/core/test/support/db.ts`. That helper is
also isolated: it creates its own temporary directory, opens a fresh SQLite
file, applies the same migration directory, and exposes a `close()` that closes
SQLite before removing its directory.

The only module-level mutable values in `admin-records.test.ts` are
`temporaryRoots` and `runtimes` at lines 20-21. `afterEach` at lines 23-30
drains both arrays, synchronously closes every runtime's SQLite connection, and
awaits recursive deletion of every temporary root. Tests are not declared
concurrent, and `vitest.config.ts` sets `fileParallelism: false`.

## HTTP and open-work audit

There is no listening server or ephemeral port in this suite.
`packages/web/src/app.ts:107-110` returns Hono's bound `request` function, and
Hono's test request path constructs a Web `Request` and directly dispatches it
through the app's `fetch`. The `https://porchfest.example` value is request
metadata for origin and CSRF behavior; it is never resolved through DNS and
never reaches a socket. Consequently there is no `localhost` versus
`127.0.0.1` choice, keep-alive agent, network default timeout, or server handle
to close. `packages/web/src/server.ts` is not imported by the test.

The promise/timer audit was:

```bash
rg -n "await (get|post|boot|runtime\\.request)|(?<!await )\\b(get|post|boot|runtime\\.request)\\(" \
  packages/web/test/admin-records.test.ts --pcre2
rg -n "setTimeout|setInterval|queueMicrotask|new Promise|\\.then\\(|fetch\\(" \
  packages/web/test/admin-records.test.ts packages/web/src/composition.ts \
  packages/web/src/app.ts packages/web/src/router \
  packages/web/src/routes/admin-records.ts packages/core/src -g '*.ts'
```

The first command listed the definitions and awaited callers; it found no
unawaited `boot`, `get`, `post`, or `runtime.request` call. The second command
printed no match in those paths. Some tests intentionally do not read a
returned response body, but the response is already an in-memory Hono
`Response`, not a live network body.

`packages/web/src/retention-sweep.ts` does contain a `queueMicrotask` default,
but it does not survive these requests. `onBoot()` runs synchronously and stamps
`lastAttemptAt`; organizer requests made immediately afterward are inside the
six-hour throttle and do not queue the deferred branch.

## CI evidence

The current run view shows the successful rerun, so attempt 1 was queried
explicitly and its original job log was streamed by job id:

```bash
gh api repos/damienriehl/porchfest/actions/runs/32712015538/attempts/1/jobs \
  --jq '.jobs[] | [.id,.name,.conclusion,.started_at,.completed_at] | @tsv'
gh api repos/damienriehl/porchfest/actions/runs/33262541911/attempts/1/jobs \
  --jq '.jobs[] | [.id,.name,.conclusion,.started_at,.completed_at] | @tsv'
```

Relevant output:

```text
97385247268  verify     failure  2026-08-24T09:31:32Z  2026-08-24T09:32:33Z
99126849635  verify     failure  2026-08-29T16:17:15Z  2026-08-29T16:19:05Z
```

Filtering those two job logs produced:

```text
run 32712015538 attempt 1
admin-records.test.ts (47 tests | 1 failed) 15019ms
  x shows a new signup to an organizer 5093ms
  creates a host-reached act and promotes its real submission 1674ms
Test Files 1 failed | 29 passed (30)
Tests      1 failed | 444 passed (445)
Duration   41.04s (import 5.82s, tests 33.01s)

run 33262541911 attempt 1
admin-records.test.ts (53 tests | 1 failed) 19999ms
  shows a new signup to an organizer 989ms
  does not invite or arm placeholder creation after archival 939ms
  clears an item for one organizer without hiding it from another 1236ms
  brings a record back after a participant edits it 1055ms
  creates a host-reached act and promotes its real submission 1074ms
  x re-renders an archived-season placeholder with the typed values 5315ms
outbox.test.ts (14 tests) 9329ms
core/test/outbox.test.ts (23 tests) 6865ms
Test Files 1 failed | 38 passed (39)
Tests      1 failed | 611 passed (612)
Duration   88.00s (import 9.26s, tests 75.49s)
```

The matching successful-rerun extraction was:

```text
run 32712015538 rerun
admin-records.test.ts (47 tests) 1869ms
Test Files 30 passed (30)
Tests      445 passed (445)
Duration   20.45s (import 9.22s, tests 7.71s)

run 33262541911 rerun
admin-records.test.ts (53 tests) 3730ms
Test Files 39 passed (39)
Tests      612 passed (612)
Duration   45.28s (import 13.32s, tests 27.26s)
```

The first timeout cannot have been caused by a previous test because it is the
first `it` in the file. The second timeout followed `uses the signup email rule
for manually reached placeholders`, not a transition or archival test. Many
transition and archival tests before and after it completed, with no consistent
slow-successor pattern.

PR history also corrects one premise without changing the diagnosis. PR #31 did
not touch this file. PR #18 did add 257 lines to it, but neither `boot()` nor the
first failing test was changed; the additions were later archival-refusal cases
elsewhere in the file. No prior PR or issue about an `admin-records` timeout was
found.

## Local reproduction and contention results

All local commands used Node v24.13.0. A baseline verbose run was:

```bash
/usr/bin/time -f 'wall=%e user=%U sys=%S maxrss=%M' \
  npx vitest run packages/web/test/admin-records.test.ts --reporter=verbose
```

Output summary:

```text
shows a new signup to an organizer 47ms
re-renders an archived-season placeholder with the typed values 18ms
Test Files 1 passed (1)
Tests      53 passed (53)
Duration   1.40s (import 531ms, tests 789ms)
wall=1.73 user=1.93 sys=0.34 maxrss=309984
```

The file then ran twenty times. Every iteration started `npm run typecheck` in
parallel, ran Vitest with `--reporter=verbose --no-color`, waited for typecheck,
and failed the loop if either command was nonzero.

```bash
for iteration in $(seq 1 20); do
  npm run typecheck &
  typecheck_pid=$!
  npx vitest run packages/web/test/admin-records.test.ts \
    --reporter=verbose --no-color
  vitest_status=$?
  wait "$typecheck_pid"
  typecheck_status=$?
  test "$vitest_status" -eq 0
  test "$typecheck_status" -eq 0
done
```

Summary from the retained verbose output:

```text
iterations=20 failures=0
slowest test: the activity queue > shows a new signup to an organizer, 72ms
archived placeholder target maximum: 30ms
slowest archive/transition-named test: 48ms
slowest suite: 1.88s (import 725ms, tests 1.06s)
```

The slow test was consistently the first test, which pays Vitest's first-use
overhead in addition to the same fresh database setup every other boot pays. It
still remained about 69 times below the five-second limit under this contention.
No test following a season transition or archive was consistently slow.

## What changed and what was ruled out

Changed:

- added only this investigation report;
- made no timeout adjustment and no source or test change.

Ruled out by code trace and execution:

- a module-level shared database or shared temp root;
- an open TCP server, ephemeral port collision, DNS lookup, keep-alive wait, or
  missing abort signal;
- an unawaited request promise in this file;
- a `setTimeout`, `setInterval`, or promise chain in the relevant path;
- a previous-test leak as the cause of the first failure;
- season transition or archival as a consistent predecessor;
- ordinary or typecheck-contended cold-start work legitimately approaching
  five seconds locally.

## Remaining uncertainty

GitHub's job log shows the duration inflation but not hosted-VM CPU steal,
run-queue, filesystem latency, or block-device telemetry. The investigation can
therefore identify the failure as transient runner-wide starvation or stalling,
but cannot attribute it more narrowly. If it recurs, the next evidence-producing
step is CI-only timing instrumentation around `mkdtemp`, runtime creation and
migrations, fixture creation, request dispatch, and cleanup, together with host
load and disk-latency observations. A timeout increase without those timings
would remain speculative.

## Verification

The final required chain used Node v24.13.0. Its results are recorded here after
the report itself was included in formatting and clean-room checks:

- `npm run typecheck` — exit 0; `tsc --noEmit -p tsconfig.json`
- `npm run lint` — exit 0; 0 errors and the two existing unused-`stamp`
  warnings in `packages/core/src/access.ts:244` and
  `packages/core/src/access.ts:275`
- `npm run format:check` — exit 0; `All matched files use Prettier code style!`
- `npm test` — exit 0; 39 files and 612/612 tests passed in 17.85 s

`npm test` printed all six required repository gates:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The first sandboxed `npm test` attempt could not bind the existing SMTP tests'
`127.0.0.1` listeners (`listen EPERM`), so those tests waited for replies from
servers the sandbox had prevented from starting. The required suite was rerun
with local-listener permission and passed completely with stderr visible. It
printed the existing Node TLS ServerName deprecation warning from the SMTP
tests; no test was suppressed or changed.

## Handoff state

This report is the only changed path and the only path in the focused local
commit. Nothing was pushed or merged.
