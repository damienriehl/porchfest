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
- `deploy/archive.sh`
- `deploy/common.sh`
- `deploy/compose.external-proxy.yaml`
- `deploy/deploy.sh`
- `deploy/offsite.sh`
- `deploy/preflight.sh`
- `deploy/restore.sh`
- `deploy/rollback.sh`
- `docs/deploy.md`
- `scripts/container-smoke.sh`
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
  retains the running image as `:prev`, runs containerized SQLite integrity, and records six
  non-sensitive counts.
- `archive.sh` stops only `app`, streams a tar of the whole volume to a deploy-user-owned `0600`
  file, records SHA-256 and schema metadata, restarts and health-checks the app, and prunes local
  archives by modification time.
- `offsite.sh` verifies the local SHA-256, encrypts with a public age recipient, copies the encrypted
  archive and evidence sidecars in one manifest-driven rclone operation, verifies the remote
  listing, and prunes by remote modification time. Missing recipient or remote values fail closed.
- `restore.sh` accepts a plain archive or an age-encrypted archive plus an operator-supplied identity,
  creates a fresh named volume, boots an app-only throwaway Compose project, and requires integrity,
  row-count, and schema-journal agreement before printing PASS. The restored volume is retained for
  inspection.
- `rollback.sh` compares the last Drizzle journal entry in the configured image and `:prev`. Equal
  entries force-recreate `app` from `:prev` without a build. A newer current schema requires a
  matching archive, takes a fresh safety archive, removes only the exact app container and pinned
  volume, rehearses restore with `:prev`, then starts the normal project. It never runs
  `docker compose down -v`.
- `deploy.sh` ships only `git archive HEAD`, preserves the host `.env` and deployment-root sentinel,
  runs the gates on the host, rebuilds only `app`, compares pre/post counts, and checks external
  HTTPS status, HTTP redirect, and sign-in cookie flags. Its dry run performs no command.

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
- “Matching counts” means exact equality for `seasons`, `venues`, `acts`, `contacts`, `assignments`,
  and `outbox_messages`. Counts are queried together through `sqlite3` in a pinned throwaway image.
  Contents, recipient addresses, message bodies, configuration values, and tokens are never printed.
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
- Authentication tokens, CSRF values, and the probe cookie are passed to curl in `0600` temporary
  config files, not command-line arguments. Every external curl has a bounded connect and total
  timeout. The probe session is signed out on success.
- The overlay removes Caddy with Compose's `!reset null` override. The app keeps its internal default
  network for ordinary Compose behavior and also joins the external proxy network; it only exposes
  port 9398 to Docker networks.
- `PORCHFEST_TRUSTED_PROXY_HOPS=1` is the documented single-Traefik topology. A second trusted CDN
  hop requires an explicit increase and proxy trust configuration; otherwise per-IP rate limiting
  collapses into one apparent client bucket.
- The SMTP port default is empty in Compose. This preserves no-provider boot: the SMTP adapter may
  apply its port default only after an SMTP host enables that provider.
- The CI rollback intentionally covers the requested same-schema path with two tags of one image.
  A schema-moving rollback needs a real older image and its matching archive, so that destructive
  path remains a documented real-host rehearsal rather than a fabricated CI result.

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

The cross-model route was not used because the assignment explicitly routed the worker to Codex.
No repository context was sent to another provider or over the network.

## Verification commands and exact results

Every requested executable gate used Node v24.13.0 and exited 0.

| Gate                              | Exact result                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`               | `tsc --noEmit -p tsconfig.json`; exit 0                                                                                                                 |
| `npm run lint`                    | exit 0; 0 errors and the two pre-existing unused-argument warnings in `packages/core/src/access.ts` at lines 244 and 275                                |
| `npm run format:check`            | `All matched files use Prettier code style!`; exit 0                                                                                                    |
| `npm test`                        | `Test Files 47 passed (47)`; `Tests 842 passed (842)`; duration 31.73s; exit 0                                                                          |
| `npm run check:boundaries`        | both boundary checks printed `OK`; exit 0                                                                                                               |
| `bash scripts/container-smoke.sh` | clean boot/TLS, archive, restore, exact counts, integrity, same-schema rollback, external-proxy config, dotenv safety, and off-site shim passed; exit 0 |

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

Nothing was pushed or merged. This report is intended for one final focused documentation commit.
