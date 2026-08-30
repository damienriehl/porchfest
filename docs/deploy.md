# Deploy and restore Porchfest

This runbook is for one Porchfest instance on a Docker host that already runs Traefik v3. All names
below are placeholders. Replace them on the host; never commit the real host alias, domain, backup
remote, age identity, IP, or credentials.

## Host and instance preparation

Install Docker with Compose v2, `age`, `rclone`, `sha256sum`, and `tar`. The deploy scripts use the
app image's installed `better-sqlite3` for read-only integrity and count checks; the host does not
need `sqlite3` or a third-party SQLite image. The source machine that ships releases also needs Git,
SSH, rsync, and tar.

Create the target directory, its deployment-root sentinel, and a backup directory outside it. Give
the deploy user ownership. The sentinel fences the later `rsync --delete` to this dedicated tree:

```sh
ssh deploy-host.example
mkdir -p /srv/porchfest-neighborhood /var/backups/porchfest-neighborhood
touch /srv/porchfest-neighborhood/.porchfest-deploy-root
chmod 0700 /var/backups/porchfest-neighborhood
```

Connect the existing Traefik container to an external Docker network such as `proxy-network`. Copy
`.env.example` to `/srv/porchfest-neighborhood/.env` and replace every placeholder. These identity
values are especially important:

```dotenv
PORCHFEST_COMPOSE_PROJECT=porchfest-neighborhood
PORCHFEST_APP_IMAGE=porchfest-neighborhood:current
PORCHFEST_DATA_VOLUME=porchfest-neighborhood-data
PORCHFEST_DOMAIN=porchfest.example
PORCHFEST_PROXY_NETWORK=proxy-network
PORCHFEST_TLS_RESOLVER=letsencrypt
PUBLIC_BASE_URL=https://porchfest.example
PORCHFEST_TRUSTED_PROXY_HOPS=1
PORCHFEST_ARCHIVE_DIR=/var/backups/porchfest-neighborhood
PORCHFEST_ARCHIVE_KEEP=7
PORCHFEST_DEPLOY_OFFSITE=1
PORCHFEST_BACKUP_AGE_RECIPIENT=age1replace-with-a-real-public-recipient
PORCHFEST_BACKUP_REMOTE=remote-name:porchfest-neighborhood
PORCHFEST_BACKUP_KEEP=30
PORCHFEST_EXTERNAL_CONNECT_TIMEOUT=5
PORCHFEST_EXTERNAL_MAX_TIME=20
```

The repository example intentionally leaves `COMPOSE_FILE` commented so copying it verbatim boots
the reference Caddy topology. On an external-Traefik host, uncomment the example only in that
host's untracked `.env` so the deploy scripts use both files. For every manual Compose command,
name the overlay explicitly with `-f compose.yaml -f deploy/compose.external-proxy.yaml`; do not
depend on implicit file selection while validating the topology.

Use a literal, per-instance data volume such as `porchfest-neighborhood-data`; never reuse the
reference `porchfest-data` name between instances. Leave `PORCHFEST_SESSION_SECRET` empty to create
a unique `0600` secret in that volume, or set a unique high-entropy value. The public age recipient
may live on the server. Its private identity must live only on the separate restore machine.

The override removes Caddy, publishes no app port, joins `app` to the named external network, and
sets Traefik's HTTP redirect and HTTPS router/service labels. `PORCHFEST_TRUSTED_PROXY_HOPS=1` is
correct because Traefik is the sole trusted hop. Raise it only when a second trusted proxy, such as
a CDN proxy, is intentionally placed in front and Traefik is configured to trust that hop. Putting
a CDN proxy in front without that trust configuration makes every visitor appear to have one IP and
collapses per-IP signup limiting into one shared bucket.

Validate interpolation before first boot:

```sh
cd /srv/porchfest-neighborhood
docker compose -f compose.yaml -f deploy/compose.external-proxy.yaml config >/dev/null
docker compose -f compose.yaml -f deploy/compose.external-proxy.yaml up -d --build app
docker compose -f compose.yaml -f deploy/compose.external-proxy.yaml ps
docker compose -f compose.yaml -f deploy/compose.external-proxy.yaml logs app
```

Open the bootstrap URL printed once in the app log. Create the first organizer, then complete
`/admin/setup`. When the log link expires, run `docker compose exec app npm run organizer:link`.

## KTD9 deploy gate

On the source checkout, dry-run without contacting the host:

```sh
export PORCHFEST_DEPLOY_HOST=deploy-host.example
export PORCHFEST_DEPLOY_DIR=/srv/porchfest-neighborhood
bash deploy/deploy.sh --dry-run
```

The live entrypoint packages `HEAD` with `git archive`, rsyncs only tracked files, preserves the
on-box `.env`, and invokes the gate on the host:

```sh
bash deploy/deploy.sh
```

For an already-shipped tree, the exact component commands are:

```sh
cd /srv/porchfest-neighborhood
bash deploy/preflight.sh
bash deploy/archive.sh
bash deploy/offsite.sh
docker compose up -d --build app
```

`deploy.sh` performs those steps in order, with off-site copy controlled by
`PORCHFEST_DEPLOY_OFFSITE=1`, then waits for health and runs the post-checks. It does not rebuild or
restart the proxy. The gate is successful only when all of these invariants hold:

- the running `/data` mount is exactly `PORCHFEST_DATA_VOLUME`;
- SQLite `PRAGMA integrity_check` is `ok`;
- the archive-time count taken while the app is quiesced is authoritative; `seasons` stays equal,
  no other table decreases, and any increase is printed as `+N <table> during the window` evidence;
- a quiesced full-volume archive exists outside the served/project tree, is owned by the deploy
  user, has mode `0600`, and has a verified SHA-256;
- the image that was running at preflight remains tagged
  `<repository>:prev-<compose-project>`, isolated from concurrent Compose projects;
- the archive record names the last Drizzle journal entry and database migration timestamp;
- external HTTPS health returns 200, plain HTTP redirects to HTTPS, and a short-lived sign-in probe
  returns `Secure; HttpOnly; SameSite=Lax`; the probe session is immediately signed out;
- encrypted off-host retention is 30 archives and local retention is 7 archives with the values
  above.

Set `PORCHFEST_DEPLOY_PROBE_ORGANIZER` to an existing organizer email or numeric id to exercise the
recovery sign-in and session-cookie flags. When it is unset, the deploy prints a probe skip and never
issues or consumes the fresh install's bootstrap link; HTTPS and redirect checks still run. The
script never prints the selector, link token, cookie, response body, database contents, or provider
values. If organizer recovery fails, its stderr explanation is preserved for the operator.

Normal archives restart the app and require it to become healthy. Incident automation may use
`bash deploy/archive.sh --no-restart` (or `PORCHFEST_ARCHIVE_NO_RESTART=1`) to leave a quiesced app
stopped; any archive failure reports whether restart was attempted and the resulting app state.

The backup RPO is the age of the newest successful archive shown in `offsite.sh`'s evidence block.
Run the gate on every release and at least daily if a day of organizer work is the maximum acceptable
loss. Local archives and their encrypted copies are pruned independently.

## Restore rehearsal

Copy one encrypted archive, its plaintext `.sha256`, and its `.json` record from the remote to a
clean machine. Put the private age identity on that clean machine only. Use a fresh volume name:

```sh
export PORCHFEST_COMPOSE_PROJECT=porchfest-neighborhood
export PORCHFEST_DATA_VOLUME=porchfest-neighborhood-data
export PORCHFEST_APP_IMAGE=porchfest-neighborhood:current
export PORCHFEST_RESTORE_VOLUME=porchfest-neighborhood-restore-rehearsal
export PORCHFEST_RESTORE_IDENTITY=/secure/path/porchfest-backup-identity.txt
bash deploy/restore.sh /secure/path/porchfest-neighborhood-backup.tar.gz.age
```

PASS means the archive checksum matched, the app booted on a newly created named volume, health and
integrity passed, and all six non-sensitive counts matched the archive-time record. The restored
volume is retained for operator inspection; remove that exact rehearsal volume after inspection.
Archive existence or a successful `age` command alone is not a backup gate.

## Rollback decision

Run `bash deploy/rollback.sh` on the host. The script reads the last journal entry from both the
current image and the Compose-project-scoped previous-image tag:

- Equal entries: retag the previous image as the configured app image and recreate only `app` with
  `--no-build`. The data volume is unchanged.
- Current entry newer: image-only rollback is refused. The script locates the newest archive whose
  record matches the previous image, restores it into a fresh rehearsal volume, and requires every
  check to pass before touching production data. It then takes a no-restart safety archive, removes
  and recreates only the exact pinned volume, restores the chosen archive, and boots the previous
  image. If that destructive phase fails, it automatically restores the safety archive into the
  pinned volume, reports the recovery, and exits as a failed rollback.

The script never runs `docker compose down -v`; throwaway restore projects use `compose down`
without `-v`, and only caller-created rehearsal volumes are explicitly removed. If no matching
archive exists or rehearsal fails, rollback stops before touching the pinned volume and names the
failure.

## SMTP shakedown wave (operator only)

Nothing in deployment or CI sends live email. After the KTD9 gate passes:

- Configure `PORCHFEST_SMTP_HOST`, `PORCHFEST_SMTP_FROM`, port/TLS settings, and credentials or a
  `0600` password file; restart only `app` and verify health.
- Have Damien generate a dedicated shakedown wave addressed only to organizer-controlled addresses.
- Review every stored subject, text body, HTML body, and recipient before clicking send.
- Damien triggers the send. Confirm delivery at each organizer-controlled mailbox.
- In the wave UI, verify every recipient has its own successful send state, sent address, and time;
  no aggregate wave-level stamp substitutes for recipient state.
- Attempt no participant send. Verify sent message content is immutable and a corrected recipient
  address becomes eligible for an explicit resend rather than silently inheriting the old stamp.
- Record the operator/time and outcome outside the repository; do not copy addresses or bodies into
  deployment evidence.

## After every deploy

Check `docker compose ps`, HTTPS `/health`, the organizer queue and current season, the public map's
publication state, provider status, local/off-site retention counts, and the newest restore-rehearsal
date. Treat an empty-looking season, a changed volume name, one shared rate-limit bucket, missing
recipient state, or a backup that has never restored as a failed deployment even when health is 200.
