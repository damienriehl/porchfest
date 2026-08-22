# Boot Path and Core Package P1 Fix Report

Date: 2026-08-22  
Branch: `feat/u3-schema`  
Delivery state: uncommitted; nothing pushed or merged

## Outcome

All five requested fixes are implemented in the assigned surfaces, with one new regression test file. The final acceptance gates pass with 148 tests.

## Fixes

### 1. Create the data directory before secret and database initialization

`packages/web/src/composition.ts` now creates the resolved data directory recursively with mode `0o700` before calling either `loadSessionSecret` or `openCoreDatabase`.

Pre-fix reproduction was observed with `PORCHFEST_SESSION_SECRET` configured and a nonexistent data directory:

```text
Cannot open database because the directory does not exist
```

The focused regression suite also failed at `openCoreDatabase` before the production change. After the change, the same case boots and serves `/health` with status 200.

### 2. Preserve the original composition failure if cleanup also fails

The composition catch path now guards `databaseConnection.close()` with a nested `try/catch`, matching the existing connection-initialization pattern. A close-time exception can no longer replace the composition error.

Pre-fix, the regression expected `composition failed` but received `close failed`. Post-fix, the original `compositionError` object is preserved.

### 3. Export the gated season repository API

`packages/core/src/index.ts` now exports `createSeasonRepository`, `isSeasonActionLegal`, the season errors, and the public season input/result types. It also exports a named `SeasonRepository` type derived from the factory return type.

`createRecordRepository` remains internal and is not exported.

### 4. Make the gated repository the public runtime data surface

`createCore` now constructs the season repository and exposes it as `CoreRuntime.seasons`. `CoreRuntime.database` was removed.

Judgment: remove the raw handle rather than rename it as an escape hatch. Database migrations run in `openCoreDatabase` before `createCore`, and the current health endpoint does not inspect the database. No runtime caller legitimately needs unrestricted insert/update/delete access. The composition root still receives the connection's database long enough to construct the gated repository, but web application code holding `CoreRuntime` receives only `ports` and `seasons`.

### 5. Close the runtime during process shutdown

`packages/web/src/server.ts` now registers one-shot `SIGTERM` and `SIGINT` handlers after runtime/server creation. Shutdown is idempotent, stops the HTTP server, then closes the runtime connection. Server-close or runtime-close errors set a failing process exit code without preventing the other cleanup step.

## Regression coverage

Added `packages/web/test/boot-regressions.test.ts` covering:

- configured session secret plus an absent data directory;
- preservation of the original composition error when `close()` throws;
- reachability of `createSeasonRepository` through `@porchfest/core`, presence of `runtime.core.seasons`, and absence of `runtime.core.database`.

Before implementation, the focused file ran 3 tests and all 3 failed for the expected reasons. After implementation, all 3 pass.

## Verification

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — pass, 13 files and 148/148 tests; core boundary, route boundary, and clean-room self-tests pass
- `node scripts/check-core-boundary.test.mjs` — pass (also exercised by `npm test`)
- Prettier check on all owned source/test files — pass
- `git diff --check` — pass

The first sandboxed full-suite attempt completed 148/148 Vitest tests and both boundary assertions, then the clean-room test was denied permission to spawn `git init` in its temporary repository. Re-running `npm test` with the required sandbox permission completed the clean-room self-test successfully.

## Finishing checks

The behavior-preserving simplification pass covered reuse, code quality, and efficiency:

- reuse: 0 findings;
- quality: 2 test-only findings applied;
- efficiency: 1 finding, the same leaked-handle issue independently identified by the quality pass;
- skipped: 0.

The close-failure regression now invokes the real SQLite close before throwing its synthetic cleanup error, so it tests error preservation without leaking a native handle. The package-entry assertion now uses a compile-time `SeasonRepository` check and a runtime repository-shape check instead of redundant identity/property assertions. Focused tests, typecheck, lint, and the final full suite pass after those changes.

Code review: skipped (ce-code-review unavailable). The portable review workflow cannot isolate this worker's exact file scope from the other workers' concurrent unstaged changes, and this harness exposes no separate native review command. A manual final scan of the worker-owned diff found no residual correctness, reliability, public-contract, or test-coverage issues.

## Scope and repository state

Files changed by this worker:

- `packages/core/src/index.ts`
- `packages/web/src/composition.ts`
- `packages/web/src/server.ts`
- `packages/web/test/boot-regressions.test.ts` (new)
- `docs/handoffs/worker-fix-boot-report.md` (new)

The concurrently owned core implementation/test files were read for context and gate diagnosis but not edited by this worker. No commit, push, merge, or branch operation was performed.
