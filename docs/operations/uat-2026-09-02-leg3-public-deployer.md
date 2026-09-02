# UAT 2026-09-02 — Leg 3: attendee and deployer personas (Wes P5, Sam P6)

Executed strictly as the personas (curl + DOM inspection as the "browser"; no
direct DB writes; no code paths a real person could not discover — source
reading appears only as post-verdict diagnostics). Stories are S5.1–S5.5 and
S6.1–S6.5 from `docs/operations/uat-2026-09-02-personas.md`.

## Instances

| | |
| --- | --- |
| Wes (S5.*) | The leg-1 shared instance at `http://127.0.0.1:8912`, read-only; left running and untouched (health `200` re-verified after this leg) |
| Sam (S6.*) | A genuinely fresh boot: `git clone` of this worktree into a scratch sandbox, `cp .env.example .env`, `docker compose up --build -d` under rootless Docker, compose project `porchfest-uat3-sam`, brand-new volumes, host ports 8930/8931 |
| Sam teardown | `docker compose down -v` — containers, all three `porchfest-uat3-sam-*` volumes, and the `porchfest-uat3-sam:current` image removed; zero uat3 residue |

Harness-only deviations for Sam (recorded, not counted as README gaps by
themselves): unique project/volume/image names (documented in `.env.example`),
and host ports 8930→80 / 8931→443 because rootless Docker cannot bind 80/443.

## Tally

**4 PASS · 2 FAIL · 4 NOT-EXECUTABLE** (10 stories)

| Story | Verdict | Evidence (abridged) |
| --- | --- | --- |
| S5.1 map loads, pins, popups | **NOT-EXECUTABLE** | Requires a published map; none can exist on this instance (leg-1 finding S1.8: no geocoder, no manual coordinate UI). What is verifiable passed: `GET /map` → `200` with the honest empty state "No map is published yet. Please check back closer to the event.", both assets serve (`porchfest-map.js` 29,204 B, `porchfest-map.css` 15,937 B), CSP present. Phone-width/console sub-checks DEFERRED-TO-BROWSER (orchestrator pass) in any case |
| S5.2 two acts in one popup | **NOT-EXECUTABLE** | Same S1.8 blocker; needs a published venue with two assigned acts |
| S5.3 no contact/annotation data in map JSON | **NOT-EXECUTABLE** (published-payload half); verifiable half clean | Swept every attendee-reachable surface (`/map`, `/map/data.json`, `/map/data.json?season=1`, `?season=2`, both assets) against leg-1 seeded values (`@example.test` addresses, contact names, shared-member note text, "annotation", "phone", "email") — zero hits. Diagnostic: `packages/web/src/routes/map.ts` builds venues from named fields only (`title`, `address`, `lat`, `lng`, `schedule`, `acts`; comment at 196–198: "adding a column to Venue can never widen this public response") and acts from `slot`/`slot_label`/`slot_start`/`slot_end`/`name`/`genre`/`description`/`links` — no contact or annotation field is ever serialized |
| S5.4 withdrawn absent, held slot empty | **NOT-EXECUTABLE** | S1.8 blocker. Diagnostic: withdrawn/superseded venues filtered at map.ts:173–176, withdrawn/superseded acts at :189–191, and only `slot.state === "assigned"` emits an act (:182), so a held slot contributes nothing |
| S5.5 unpublished season serves no venue data | PASS | With an archived season (id 1) and a live `signups_open` season (id 2), neither published: `/map` → the empty-state page; `/map/data.json` → sentinel payload `{"schema_version":"1.3.1","season":2000,…,"venues":[]}` with "Not published" placeholders and no real event date; `?season=1`/`?season=2` ignored (identical sentinel); `/map/data` and `/map.json` → `404` |
| S6.1 `docker compose up` → health, no env | PASS | Clean clone, `cp .env.example .env`, `docker compose up --build -d` (exit 0); app healthy in seconds; `curl --insecure https://localhost:8931/health` → `{"ok":true,"service":"porchfest"}`; first boot printed the one-hour single-use bootstrap URL and generated its own session secret in the volume |
| S6.2 README path to an open season, without asking anyone | **FAIL (R20)** | The README's stranger path breaks at the very first mutation — see gap 1 below. Bootstrap sign-in POST → `503` "Mutation protection is not configured." Recovery required reading source, not docs. After setting `PUBLIC_BASE_URL` (plus the port-coupling fix, gap 3) the rest of the path worked end-to-end: bootstrap sign-in `303` + session; `/admin` → first-run setup form; setup POST `303`; season page's "Move to signups_open" transition (not in the README — gap 4) `303`; public host signup → `201 Created` receipt |
| S6.3 unconfigured mode is honest | PASS | Honeypot: hidden `website` field (`class="honeypot" aria-hidden="true"`, `tabindex="-1"`); filled → `400`, record never appears in the queue. Rate limit: burst → `429` "Too many signup attempts arrived from this address. Wait a minute, then try again." Queue afterwards holds exactly the one legitimate record. Outbox: "Email outbox" offers generate/copy/export only — no send control anywhere. Self-serve hidden and honest: receipt says "No confirmation email will follow because email delivery is not configured for this deployment." and "This receipt cannot be reopened to edit or withdraw your signup… Participant self-service is not available yet." Public map serves the honest empty state |
| S6.4 placeholder secret refuses to start | PASS | `PORCHFEST_SESSION_SECRET=replace-with-a-unique-random-secret` → app exits: "Error: Refusing to start: PORCHFEST_SESSION_SECRET equals the public .env.example placeholder." (`session-secret.ts:15`); container unhealthy/restarting, nothing served. Nit: today's `.env.example` no longer contains that literal value — the line ships commented out — so the message's ".env.example placeholder" wording is slightly stale (gap 6) |
| S6.5 docs say which features need a provider | **FAIL** (accuracy, R20) | The README's zero-configuration table does name provider-gated features (SMTP → send + magic links; Turnstile keys → challenge; `GEO_PROVIDER=osm` → geocoding; `PUBLIC_BASE_URL` required with SMTP/magic links). But two of its "works unconfigured" claims are false in this build: "Venue coordinates: Manual organizer entry and review" (leg-1 S1.8: no such UI exists) and, in consequence, "…map publication remain[s] usable" in no-provider mode (it is unreachable). A stranger deployer plans an event around those two sentences |

## The two failures

1. **S6.2 — the README stranger path cannot create its first organizer (R20).**
   README: "The copied file already leaves COMPOSE_FILE and PUBLIC_BASE_URL
   unset for this path" and "The app boots without SMTP credentials, an
   anti-bot account, a geocoding provider, or a public base URL." Boot it does —
   but with `PUBLIC_BASE_URL` unset, EVERY authenticated-or-not POST (the
   bootstrap sign-in included) returns `503` "Mutation protection is not
   configured.", browser or curl alike. Diagnostic:
   `packages/web/src/app.ts:70–72` derives the mutation `allowedOrigin` solely
   from `options.publicBaseUrl`, and
   `packages/web/src/router/registry.ts:344–350` returns the 503 whenever it is
   null. The leg-1 instance never saw this because it exported
   `PUBLIC_BASE_URL` explicitly. No README text hints at the failure or the
   fix; the health check and the printed bootstrap link both work, so the
   deployment looks fine right up to the first submit.
2. **S6.5 — the provider table misstates the no-provider coordinate path.** The
   row "Venue coordinates | Manual organizer entry and review |
   `GEO_PROVIDER=osm` …" promises an unconfigured path that does not exist
   (cross-reference leg-1 finding S1.8), and "signup, review, matching, export,
   and map publication remain usable" overpromises map publication for the
   same reason.

## Exact README gaps Sam hit (R20 ledger)

1. **Bootstrap 503 wall** — failure 1 above. Quoted instruction that causes it:
   "The copied file already leaves COMPOSE_FILE and PUBLIC_BASE_URL unset for
   this path."
2. **Port remapping is undocumented.** `PORCHFEST_HTTP_PORT_MAPPING` /
   `PORCHFEST_HTTPS_PORT_MAPPING` exist only inside `compose.yaml`
   (lines 51–52); neither README nor `.env.example` mentions them. Any host
   where 80/443 are taken or unbindable (rootless Docker included) needs them.
3. **`PUBLIC_BASE_URL` silently doubles as Caddy's listen address.**
   `Caddyfile` line 1 is `{$PORCHFEST_ORIGIN:https://localhost}` and compose
   feeds it `PUBLIC_BASE_URL`. Setting `PUBLIC_BASE_URL=https://localhost:8931`
   (the fix for gap 1 under gap 2's port remap) moved Caddy's in-container
   listener from 443 to 8931, killing TLS (`curl: (35) … unexpected eof`) until
   the mapping was changed to `8931:8931`. Undocumented coupling; invisible on
   a standard-port host, baffling on any other.
4. **The draft → signups_open step is missing from the README.** "that form
   creates the event, timezone, slots, signup window, locality, public URLs,
   and sender identity" — but the created season is a draft, and the public
   form answers "Signups are not open for that Porchfest season." until the
   organizer finds the "Move to signups_open" transition on the season page.
   Discoverable in-app within a minute, so recorded as a gap, not a failure.
5. **Provider-table accuracy** — failure 2 above.
6. **Stale placeholder cross-reference (nit).** The refusal message and README
   both speak of "the public example placeholder", but `.env.example` now ships
   `# PORCHFEST_SESSION_SECRET=` commented with no placeholder value; the
   literal `replace-with-a-unique-random-secret` lives only in
   `packages/web/src/config/session-secret.ts:5`.

## Environment notes

- The Wes pass wrote nothing: no signups, no admin actions, no participant
  records touched on the shared instance.
- Sam's sandbox clone was at leg-1's commit `48f779a`; the burst-limit and
  honeypot observations match leg-1's (~5/min/IP, honest 429 copy) through the
  full Caddy hop with `PORCHFEST_TRUSTED_PROXY_HOPS=1` (the compose default),
  i.e. the real client IP is what gets capped behind the reference proxy.
- Honeypot-filled submissions are refused with `400` (not silently accepted and
  dropped); either behavior satisfies the contract, noting it for exactness.
