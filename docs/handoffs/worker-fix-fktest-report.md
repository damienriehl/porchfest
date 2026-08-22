# Foreign-key pragma test hardening report

## Change

- `packages/core/test/connection.test.ts` now spies on
  `Database.prototype.pragma` before calling `openCoreDatabase` and asserts that the
  application invoked it with `foreign_keys = ON`.
- The existing migration, `pragma foreign_keys` state, and rejected orphan-contact
  assertions remain in place.
- The suite's `afterEach` calls `vi.restoreAllMocks()` before closing the database, so
  the prototype spy is restored even when the test fails and cannot affect another
  test.
- No production source file was modified. In particular,
  `packages/core/src/storage/connection.ts` is unchanged in the real repository.

## Required mutation proof

The proof used this isolated copy beneath the task's required scratchpad:

```text
<session scratchpad>/fk-test-proof/   (machine-local; path in the private handoff copy)
```

1. **Pragma removed in the scratch copy: FAIL.** I commented only the scratch
   copy's `sqlite.pragma("foreign_keys = ON")` line and ran:

   ```text
   npm exec -- vitest run packages/core/test/connection.test.ts
   ```

   The command exited `1`. The focused test failed at the new assertion with:

   ```text
   AssertionError: expected "pragma" to be called with arguments: [ 'foreign_keys = ON' ]

   Number of calls: 0

   Test Files  1 failed (1)
        Tests  1 failed (1)
   ```

2. **Pragma restored in the scratch copy: PASS.** I restored that exact line and
   reran the same command. It exited `0` with:

   ```text
   Test Files  1 passed (1)
        Tests  1 passed (1)
   ```

This proves the new assertion detects removal of the application-owned pragma call;
the pre-existing behavioral assertions alone could not do so with this build of
better-sqlite3.

## Verification

- Focused real-repository test — exit `0`; `1/1` passed.
- `npm run typecheck` — exit `0`.
- `npm run lint` — exit `0`.
- `npm test` — exit `0`; `13` test files and `148/148` tests passed. The core
  boundary, route boundary, and clean-room self-tests also passed. The count exceeds
  the requested `138+` because other workers added tests concurrently.
- `git diff --check` — exit `0` when checked after the final test edit.

The first sandboxed aggregate test run reached `138/138` Vitest passes but could not
spawn `git init` inside the clean-room fixture (`spawnSync git EPERM`). The required
gate was rerun with permission for that fixture; the complete successful result is the
`148/148` run reported above.

## Review and repository guidance

- Read-only scoped review verdict: **Ready to merge**, with no findings, residual
  risks, or testing gaps. Review receipt:
  `/tmp/compound-engineering-1000/ce-code-review/20260822-fktest-J8uTbj/review.json`.
- The change follows
  `docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`: a
  silent guard is covered only when removing it makes a named test fail, followed by
  restoration and a passing rerun.

## Repository state

My work is limited to the owned test file and this explicitly requested report. I did
not stage, commit, push, create a branch, or modify the real `connection.ts`. The work
is intentionally left uncommitted on the existing `feat/u3-schema` branch.
