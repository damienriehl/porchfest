# Smoke assertion hardening report

## Change

- `scripts/container-smoke.sh:105-117` now captures the empty-database probe's
  combined output, distinguishes success from failure under `set -euo pipefail`, and
  accepts the intended failure only when the output contains the exact
  `Missing migrated tables:` diagnostic naming all eight domain tables. A failure
  without that diagnostic now stops the smoke test with an infrastructure-failure
  message and the captured probe output. The positive assertion at
  `scripts/container-smoke.sh:95` is unchanged.

## Acceptance observations

1. **True negative.** The deliberately empty database made the hardened probe fail
   for the expected schema reason, and the captured output printed this exact line:

   ```text
   Missing migrated tables: acts, annotations, assignments, contacts, email_log, seasons, slots, venues
   ```

   Because the failure status and the exact diagnostic were both present, the smoke
   test continued.

2. **True positive.** The real boot database passed the unchanged positive assertion
   at line 95. The complete `bash scripts/container-smoke.sh` run exited `0` and ended
   with:

   ```text
   OK: container migrates an empty data volume, contains all workspaces, and serves TLS health
   ```

3. **Infrastructure failure is caught, not swallowed.** I temporarily changed only
   the empty-database probe call to use `${container}-missing`. The smoke test exited
   `1` and printed:

   ```text
   ERROR: schema readiness probe failed for a non-schema reason while checking an empty database
   Probe output:
   Error response from daemon: No such container: porchfest-empty-config-smoke-20260822154953-2434240-missing
   ```

   I then restored the temporary mutation. Before and after the experiment,
   `sha256sum scripts/container-smoke.sh` was identical:

   ```text
   1da22f1fb2dda6e09b6f6604dc30f6623bc1a8af5abc3aaa0cf7a3b397acb48c
   ```

   After restoration, `git diff -- scripts/container-smoke.sh` showed only the
   intended assertion hardening.

## Verification

- `bash scripts/container-smoke.sh` — exit `0`.
- `npm run typecheck` — exit `0`.
- `npm run lint` — exit `0`.
- `npm test` — exit `0`; `12` test files passed and `138/138` tests passed. The core
  boundary, route boundary, and clean-room self-tests also passed.
- `bash -n scripts/container-smoke.sh` — exit `0`.
- `git diff --check` — exit `0`.

The first sandboxed smoke attempt could not access the local Docker socket, and the
first sandboxed aggregate test attempt could not run `git init` in its temporary
directory. Both required commands were rerun with the corresponding local permissions;
the successful results above are from those complete reruns.

## Spec comparison

No code or behavior contradicted the task specification. The only modified paths are
the owned smoke script and this explicitly requested report. Nothing was committed,
staged, pushed, or branched by this work.
