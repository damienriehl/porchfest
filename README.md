# Porchfest

Porchfest is an MIT-licensed platform for running your own neighborhood porchfest: signups,
organizer review, performer-to-porch matching, participant communication, and a public event map.
It is designed to stay portable and self-hostable instead of requiring a particular cloud vendor.

The repository contains the complete single-instance application: first-run season setup, signups,
organizer review, matching, an immutable review-before-send outbox, participant changes, retention,
and a publishable public map.

## Reference deployment

The portable application is one Node 24 container with SQLite persistence under `/data`. The
reference Compose project adds Caddy as a small TLS edge in front of that application container.
There is no database service, queue, SPA runtime, or cloud-only dependency.

Requirements:

- Docker Engine with the Compose plugin
- A host whose ports 80 and 443 are reachable (for a public deployment)
- A DNS name pointing at that host (for publicly trusted TLS)

### From clone to first season

The shortest stranger path uses the reference Caddy topology and its local development certificate:

```sh
git clone https://github.com/example/porchfest.git
cd porchfest
cp .env.example .env
# The copied file already leaves COMPOSE_FILE and PUBLIC_BASE_URL unset for this path.
docker compose up --build -d
curl --insecure https://localhost/health
docker compose logs app
```

Caddy uses its local certificate authority for `https://localhost`, so the command deliberately
accepts that development certificate. A successful response is:

```json
{ "ok": true, "service": "porchfest" }
```

On the first boot, the app log prints a one-hour, single-use bootstrap sign-in URL. Open it, enter
the first organizer's name and email, and submit. The app sends a deployment with no season to
`/admin/setup`; that form creates the event, timezone, slots, signup window, locality, public URLs,
and sender identity. If the log has rotated, `docker compose exec app npm run organizer:link`
issues a replacement without direct database access.

For a public host with its own proxy, follow [the deployment runbook](docs/deploy.md). For the
reference Caddy topology:

1. Copy `.env.example` to `.env`.
2. Replace `PUBLIC_BASE_URL` with the canonical HTTPS origin whose DNS points at the host.
3. Leave `PORCHFEST_SESSION_SECRET` commented (recommended, so first boot creates one in the data
   volume) or set it to a unique high-entropy value.
4. Keep `COMPOSE_FILE` commented for Caddy and run `docker compose up --build -d`.

The application refuses to start when the configured session secret is still the public example
placeholder. With the variable absent or empty, first boot creates a unique key at
`/data/session-secret` with mode `0600`; later boots reuse it.

If the only organizer's session expires, an operator with shell access can print a fresh
single-use sign-in link with `docker compose exec app npm run organizer:link` — no HTTP surface
and no direct database access involved. The full procedure is in
[docs/operations/organizer-recovery.md](docs/operations/organizer-recovery.md).

## Zero-configuration provider mode

The app boots without SMTP credentials, an anti-bot account, a geocoding provider, or a public base
URL. The built-in fallback behavior and provider-dependent features are explicit:

| Capability               | Works unconfigured                    | Provider configuration                                                     |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------------------- |
| Organizer outbox         | Review, copy-paste, and `.eml` export | SMTP enables server-side send and participant magic links                  |
| Public signup protection | Honeypot and per-IP rate limit        | Turnstile site and secret keys add the external challenge                  |
| Venue coordinates        | Manual organizer entry and review     | `GEO_PROVIDER=osm` plus a deployment-specific user agent enables geocoding |

`PUBLIC_BASE_URL` is required when SMTP or magic links are enabled. The no-provider mode is a real
operating mode, not a demo mode: signup, review, matching, export, and map publication remain usable.

Provider credentials must come from an environment variable or mounted file, never source control
or an image. SMTP, Turnstile, and OpenStreetMap geocoding implementations are selected by the
environment in `packages/web`'s composition root.

### Email delivery (SMTP)

Email is hybrid per deployment. Set none of the `PORCHFEST_SMTP_*` variables and the outbox stays
in copy-paste/export mode. Set a host and a from address and the platform submits over SMTP itself
— the client is built directly on Node's `net` and `tls`, so enabling delivery adds no dependency.

| Variable                       | Default | Purpose                                                                                              |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `PORCHFEST_SMTP_HOST`          | unset   | Submission host. Required to enable sending.                                                         |
| `PORCHFEST_SMTP_FROM`          | unset   | Sender address, `organizers@example.org` or `Name <organizers@example.org>`. Required with the host. |
| `PORCHFEST_SMTP_PORT`          | `587`   | Submission port.                                                                                     |
| `PORCHFEST_SMTP_SECURE`        | `false` | `true` wraps the connection in TLS before the greeting, for implicit-TLS submission on port `465`.   |
| `PORCHFEST_SMTP_STARTTLS`      | `true`  | Upgrade to TLS after `EHLO` when the server advertises `STARTTLS`.                                   |
| `PORCHFEST_SMTP_USERNAME`      | unset   | SMTP AUTH user. Must be set together with a password.                                                |
| `PORCHFEST_SMTP_PASSWORD`      | unset   | SMTP AUTH password. Must be set together with a username.                                            |
| `PORCHFEST_SMTP_PASSWORD_FILE` | unset   | Path to a mounted file holding the password. Read once at boot; wins over `PORCHFEST_SMTP_PASSWORD`. |

A half-configured provider refuses to start with an error naming the missing variable — a host with
no from address, or a username with no password. That is deliberate, and matches the Turnstile
posture: a deployment that believes it turned sending on must not quietly fall back to copy-paste
mode, because a wave that never goes out looks exactly like a wave nobody pressed send on.

The password is never logged and never written to the data volume. Prefer
`PORCHFEST_SMTP_PASSWORD_FILE` with a `0600` mount or a Docker secret over putting the credential
into the environment.

## Where data lives

Compose pins application state to the literal Docker volume named by `PORCHFEST_DATA_VOLUME`,
mounted at `/data`. Changing the checkout directory or Compose project name therefore does not
silently attach an empty replacement volume. The generated session secret, SQLite database, and
SQLite sidecar files all live there.

Caddy state uses the separately pinned `porchfest-caddy-data` and `porchfest-caddy-config` volumes.
Do not treat local volumes or archives as backups. The restore-tested, encrypted off-host backup and
two-path rollback procedure is documented in [docs/deploy.md](docs/deploy.md).

## Development

Install the declared npm workspaces with Node 24, then use the root scripts:

```sh
npm install --include-workspace-root --workspaces
npm test
npm run typecheck
npm run lint
npm run check:boundaries
npm run check:clean-room
```

### Workspace packages

- `@porchfest/core` — Domain and storage ports shared across the application.
- `@porchfest/web` — Node HTTP server, composition root, and route registry.
- `@porchfest/email` — Email provider seam, zero-configuration null adapter, and a dependency-free
  SMTP adapter the deployment environment selects.
- `@porchfest/geo` — Geocoding provider seam and zero-configuration null adapter.
- `@porchfest/antibot` — Anti-bot provider seam and zero-configuration null adapter.
- `@porchfest/map` — Interactive venue map with hour and genre filters, geographic sort, and
  card-to-pin navigation, shipped as browser assets for a server package to mount; it requires
  Leaflet on the host page and nothing else.

The platform serves the map assets and only exposes a season's venue JSON after an organizer
explicitly publishes that eligible season.

`core` owns domain and storage ports and may never import an adapter package. `web` is the only
composition root. Every HTTP route must enter through its central registry with one of three trust
tiers: `public`, `participant`, or `organizer`. Missing and unknown tiers are rejected before the
route is attached.

The clean-room check scans the current tree, all reachable Git history, and (in the container CI
job) the runtime image. It rejects raw exports, prohibited data directories, generated message
bodies, and likely participant contact data. Do not use this repository as a staging area for real
neighbor records.

## License and third parties

Porchfest is available under the [MIT License](LICENSE). Direct third-party components and their
licenses are recorded in [THIRD-PARTY.md](THIRD-PARTY.md).
