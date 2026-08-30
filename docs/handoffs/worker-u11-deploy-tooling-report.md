# U11-a deploy tooling report

Date: 2026-08-30

Branch: `u11-deploy-tooling`

Status: implemented, reviewed, verified, and committed locally; not pushed or merged

## Outcome

U11-a now has a scripted KTD9 deployment gate: pinned-volume preflight, quiesced full-volume
archives, encrypted off-site copies, clean-volume restore rehearsal, schema-aware rollback, and a
tracked-tree deploy entrypoint. The reference Caddy topology remains available, while a Compose
override supports an operator-owned Traefik v3 edge without publishing an app port.

The container gate creates synthetic state, archives it, restores it into a fresh named volume,
compares all six archive-time counts, checks SQLite integrity, forces a same-schema image rollback,
validates the Traefik override, and tests off-site encryption with an isolated rclone shim. It makes
no request to a real host, credential, domain, backup remote, SMTP server, or geocoding provider.

No npm dependency was added. `package-lock.json` was not changed. `npm rebuild` was not run.

## Files changed

- `.env.example`
- `README.md`
- `compose.yaml`
- `Dockerfile`
- `deploy/archive.sh`
- `deploy/common.sh`
- `deploy/compose.external-proxy.yaml`
- `deploy/deploy.sh`
- `deploy/offsite.sh`
- `deploy/preflight.sh`
- `deploy/probe.sh`
- `deploy/restore.sh`
- `deploy/rollback.sh`
- `docs/deploy.md`
- `scripts/container-smoke.sh`
- `scripts/deploy-common.test.sh`
- `scripts/deploy-failure-paths.test.sh`
- `scripts/deploy-probe.test.sh`
- `scripts/restore-rehearsal.sh`
- `docs/handoffs/worker-u11-deploy-tooling-report.md`

`behavior_changed`: `true`

Implementation commits before this report:

- `4e1148d` - `feat(deploy): add the KTD9 release gate (U11)`
- `9f07844` - `test(deploy): rehearse restore and rollback in containers (U11)`
- `023e612` - `docs(deploy): document the U11 operator and stranger paths`

## What was built

### KTD9 scripts

- `preflight.sh` proves that the running app mounts the configured literal named volume at `/data`,
  retains the running image under a Compose-project-scoped previous tag, runs SQLite integrity with
  the app image's installed `better-sqlite3`, and records six non-sensitive counts.
- `archive.sh` stops only `app`, streams a tar of the whole volume to a deploy-user-owned `0600`
  file, records SHA-256 and schema metadata, and prunes local archives by modification time. Normal
  runs restart and health-check the app; `--no-restart` leaves it stopped for rollback incidents.
  Failures report the restart attempt and resulting app state.
- `offsite.sh` verifies the local SHA-256, encrypts with a public age recipient, copies the encrypted
  archive and evidence sidecars in one manifest-driven rclone operation, verifies the remote
  listing, and prunes by remote modification time. Missing recipient or remote values fail closed.
- `restore.sh` accepts a plain archive or an age-encrypted archive plus an operator-supplied identity,
  creates a fresh named volume, boots an app-only throwaway Compose project, and requires integrity,
  row-count, and schema-journal agreement before printing PASS. It refuses the production Compose
  project name, removes the throwaway network with `compose down` without `-v`, and retains the
  restored volume for inspection.
- `rollback.sh` compares the last Drizzle journal entry in the configured and scoped previous image.
  Equal entries force-recreate `app` without a build. A newer current schema first rehearses the
  matching archive in a fresh volume, then takes an exactly identified no-restart safety archive,
  replaces only the pinned volume, and restores the chosen archive. Any destructive-phase failure
  automatically restores the safety archive and reports whether the app also restarted. It never
  runs `docker compose down -v`.
- `deploy.sh` ships only `git archive HEAD`, preserves the host `.env` and deployment-root sentinel,
  runs the gates on the host, binds the deploy to the exact archive it created, rebuilds only `app`,
  compares the quiesced archive counts to post-deploy counts, and checks external HTTPS status,
  HTTP redirect, and sign-in cookie flags. Its dry run performs no command.

### Proxy topology and CI

`deploy/compose.external-proxy.yaml` resets the `caddy` service to null, gives `app` no published
port, joins the configured external network, and declares Traefik v3 HTTP redirect, HTTPS router,
TLS resolver, service-port 9398, and Docker-network labels.

`scripts/container-smoke.sh` now invokes `scripts/restore-rehearsal.sh` after the existing clean boot
and TLS checks. The rehearsal seeds one invented season, archives/restores it, verifies exact counts
and integrity, proves rollback recreates the app container, and validates the rendered proxy
Compose configuration. When age tools are installed, it generates a throwaway keypair and uses a
fake rclone that validates the destination and all four copied evidence files; it also proves empty
backup settings and a failed remote listing stop the gate. If age is unavailable, the script prints
an explicit skip.

## Judgement calls

- The image schema is the final object in `/app/packages/core/drizzle/meta/_journal.json`, read with
  the image's Node runtime. The persisted schema is `max(created_at)` from the repository's actual
  `__drizzle_migrations` table. Preflight requires equality; restore permits an older archive only
  when the chosen image can migrate it forward.
- The authoritative deploy baseline is captured inside the archive quiesce. `seasons` must remain
  equal; every other table may increase but never decrease, and increases print `+N <table> during
the window`. Restore and rollback checks remain exact. Counts use `better-sqlite3` in the app image;
  contents, addresses, message bodies, configuration values, and tokens are never printed.
- Archive records use `porchfest-deploy-evidence/v1` JSON beside each tarball. They contain UTC time,
  commit, image IDs/tags, literal volume, integrity result, six counts, schema timestamp/tag, archive
  path/SHA/mode, and no database contents. The SHA sidecar uses the ordinary sha256sum format.
- A full-volume tar is used rather than copying only `porchfest.db`; this preserves SQLite sidecars,
  the generated session secret, and future volume-resident state. Tar streams to a host-created file
  so rootless Docker cannot leave it owned by the container user.
- Archive paths are canonicalized and rejected when they are inside the Compose project tree.
  Source shipment requires an absolute, non-root remote directory containing both `.env` and the
  operator-created `.porchfest-deploy-root` sentinel before `rsync --delete` is allowed.
- Compose `.env` is not sourced as shell. A small allow-listed parser imports only deployment values
  that are not already in the process environment, preserving literal shell metacharacters and
  rollback overrides. Compose itself remains responsible for provider-secret dotenv parsing.
- Authentication tokens, CSRF values, and the probe cookie are passed to curl in a `0700` temporary
  directory with `0600` files, not command-line arguments. Every external curl has a bounded connect
  and total timeout. Once a session cookie exists, an EXIT cleanup signs it out on all success and
  failure paths and refuses to treat an HTTP error as a successful sign-out.
- The overlay removes Caddy with Compose's `!reset null` override. The app keeps its internal default
  network for ordinary Compose behavior and also joins the external proxy network; it only exposes
  port 9398 to Docker networks.
- `PORCHFEST_TRUSTED_PROXY_HOPS=1` is the documented single-Traefik topology. A second trusted CDN
  hop requires an explicit increase and proxy trust configuration; otherwise per-IP rate limiting
  collapses into one apparent client bucket.
- The SMTP port default is empty in Compose. This preserves no-provider boot: the SMTP adapter may
  apply its port default only after an SMTP host enables that provider.
- The container CI rollback uses two tags of one image for the same-schema path. A deterministic
  failure-path test separately proves live-project refusal, partial-stop restart, exact safety
  recovery reporting, and the app-start failure distinction. A real schema-moving rollback still
  needs an actual older image and matching archive for the operator's clean-machine rehearsal.

## Review findings resolved

The structured review ran correctness, security, reliability/adversarial, testing, and
maintainability lenses. Eight actionable findings were fixed and then revalidated by their
specialists:

- preserve child environment overrides while reading `.env`, so migration rollback really boots
  the archive with `:prev`;
- parse `.env` without shell evaluation;
- keep organizer-link, CSRF, and cookie material out of process arguments;
- fence the destructive rsync destination with an absolute non-root path and on-host sentinel;
- propagate rclone listing failure and verify the copied archive appears remotely;
- bound every external curl;
- assert the fake-rclone destination and complete four-file manifest;
- rehearse unset backup settings, listing failure, and actual rollback container recreation.

One additional local finding was fixed: image-only rollback now uses `--force-recreate`, because
retagging an unchanged Compose image string does not by itself guarantee container replacement.

The final review attempted to prepare the skill's independent cross-model route, but the external
send was denied because this assignment did not authorize repository egress. The adversarial lens
ran locally instead. No repository context was sent to another provider.

## Verification commands and exact results

Every requested executable gate used Node v24.13.0 and exited 0.

| Gate                       | Exact result                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`        | `tsc --noEmit -p tsconfig.json`; exit 0                                                                                                                |
| `npm run lint`             | exit 0; 0 errors and the two pre-existing unused-argument warnings in `packages/core/src/access.ts` at lines 244 and 275                               |
| `npm run format:check`     | `All matched files use Prettier code style!`; exit 0                                                                                                   |
| `npm test`                 | `Test Files 47 passed (47)`; `Tests 842 passed (842)`; duration 33.41s; exit 0                                                                         |
| `npm run check:boundaries` | both boundary checks printed `OK`; exit 0                                                                                                              |
| `npm run test:container`   | 11 `OK:` lines covering focused helpers, failure paths, verbatim example boot, TLS, archive/restore, rollback, proxy config, and off-site shim; exit 0 |

`npm test` printed all six required success lines:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The final container gate additionally printed:

```text
OK: deploy helpers parse dotenv/JSON safely, tolerate count growth, and derive scoped tags
OK: deploy probe normalizes origins, skips fresh installs, surfaces link errors, and signs out every established session
OK: deploy failure paths protect the live project, restart partial stops, and report safety recovery
OK: .env.example copied verbatim boots with zero-configuration values
OK: malformed table shape rejected and fixture restored byte-identically (<sha256>)
OK: clean-room scan found no participant-data artifacts in image tree
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history and container image
OK: container migrates an empty data volume, contains all workspaces, and serves TLS health
OK: deploy dotenv parsing preserves literal values without shell evaluation
OK: off-site backup encryption and rclone arguments rehearsed with an isolated shim
OK: archive restored with matching counts and integrity, same-schema rollback passed, and external-proxy Compose validated
```

`bash -n deploy/*.sh scripts/*.sh` and `git diff --check` also exited 0. Shellcheck is not installed on
this runner, so `shellcheck deploy/*.sh scripts/*.sh` could not run and reported the explicit skip
`SKIP: shellcheck is not installed`.

The stated baseline was 47 files / 842 tests. The final suite remains 47 files / 842 tests; the new
deployment coverage is a shell/container rehearsal rather than a Vitest file. Docker emitted only
the runner's existing rootless `IPv4 forwarding is disabled` and pre-created-volume warnings; the
gate still exited 0 and cleaned its test resources.

## Review-fix commits

| Item | Commit(s)            | Implemented decision or fix                                                                                                                                      |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `0fbbcd6`            | Accept optional `export`, quoted trailing comments, and literal values without shell evaluation.                                                                 |
| 2    | `8efc670`            | Parse `PUBLIC_BASE_URL` with URL-origin semantics and require a valid HTTPS URL.                                                                                 |
| 3    | `8efc670`, `e4a5d36` | Use EXIT-scoped session/temp cleanup; activate cleanup as soon as a session exists and require a 303 sign-out response.                                          |
| 4    | `8efc670`            | Never consume bootstrap links; skip organizer sign-in unless `PORCHFEST_DEPLOY_PROBE_ORGANIZER` names an existing organizer.                                     |
| 5    | `8efc670`            | Capture organizer-link stderr in a protected temporary file and surface it without printing the recovery link.                                                   |
| 6    | `41e4c0e`, `984e782` | Rehearse first, take an exact no-restart safety archive, replace the pinned volume only after PASS, and automatically restore/report safety recovery on failure. |
| 7    | `c916513`, `984e782` | Use `compose down` without `-v` for throwaway projects, reject the live project name, and never down the real project.                                           |
| 8    | `31a70b3`, `30ebc42` | Comment the session secret, `PUBLIC_BASE_URL`, and `COMPOSE_FILE`; copy `.env.example` verbatim and prove its zero-configuration app boot.                       |
| 9    | `4785774`            | Add `--no-restart`/`PORCHFEST_ARCHIVE_NO_RESTART=1`; rollback uses it so a crash-looping release need not become healthy first.                                  |
| 10   | `22cfbf7`            | Use archive-quiesce counts; keep seasons exact, reject every decrease, and print every allowed increase.                                                         |
| 11   | `4785774`, `984e782` | Make archive failures loud and recover even when `compose stop` stops the app but returns nonzero.                                                               |
| 12   | `73653bf`            | Derive tags from only the final image path component, including registry ports and existing tags.                                                                |
| 13   | `73653bf`            | Scope the previous tag as `<repository>:prev-<compose-project>`.                                                                                                 |
| 14   | `fc1e834`            | Pass empty values through Compose so application code owns the five defaults.                                                                                    |
| 15   | `fc1e834`, `a1e0702` | Add Docker's 2-second start interval and a named 150-second script health budget.                                                                                |
| 16   | `3cc74cb`, `fe45102` | Use the app image and installed `better-sqlite3` for integrity/count/schema checks; remove `PORCHFEST_SQLITE_IMAGE`.                                             |
| 17   | `0fbbcd6`            | Parse evidence JSON with Python, falling back to Node in the app image; remove regex readers.                                                                    |

Cross-item gate and cleanup commits:

- `8cc194b` - `test(deploy): gate the review-fix contracts`
- `a1e0702` - `refactor(deploy): simplify cleanup and health waits`
- `e4a5d36` - `fix(deploy): sign out every probe session`
- `984e782` - `fix(deploy): bind archives and recover failure paths`
- `30ebc42` - `fix(deploy): boot the verbatim example environment`

The item 6 ordering, item 4 organizer-only probe, item 8 example-file behavior, item 10 monotonic
count rule, and item 16 app-image SQLite choice are the requested settled decisions. The review also
closed two failure windows not explicit in the original line evidence: exact archive-to-run binding
under concurrent writers and refusal to reuse the production Compose project for a throwaway restore.

## Real-host work remaining for the operator

- Install Docker Compose v2, age, rclone, sha256sum, and tar; create the dedicated deployment and
  archive directories plus `.porchfest-deploy-root`; create/connect the existing Traefik network.
- Copy `.env.example` to the host and replace every placeholder with the instance's real literal
  volume names, Compose project, domain, proxy network/resolver, public base URL, SSH target, age
  recipient, and rclone remote. Keep the age identity off the deployment host.
- Validate the overlay, boot `app`, use the one-hour bootstrap sign-in, and complete `/admin/setup`
  with the real season configuration.
- Run `deploy.sh` and inspect its evidence. Verify DNS/TLS, HTTPS health, HTTP redirect, cookie flags,
  the expected season, current organizer queue, map publication state, and local/remote retention.
- Copy one encrypted backup plus its JSON and SHA sidecars to a clean machine, decrypt with the
  separate identity, and obtain `restore_result=PASS` before treating backups as operational.
- When an actual release advances the Drizzle journal, retain the prior image and matching archive,
  then rehearse the schema-moving rollback decision before relying on it in an incident.
- Configure SMTP only after the gate passes. Damien must manually trigger the shakedown wave to
  organizer-controlled addresses and verify per-recipient delivery state and post-send immutability.
  No deployment or CI command sends that wave automatically.

Nothing was pushed or merged. The review-fix documentation is committed locally on the branch.
