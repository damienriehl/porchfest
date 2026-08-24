# Recover an organizer after their session expires

A deployment with one organizer can become locked out when that organizer's
session reaches its absolute lifetime. Normal sign-in links come from another
signed-in organizer, while first-run bootstrap deliberately stops once any
organizer account exists. Recovery therefore requires shell access to the
deployment; it is not exposed as an HTTP route.

Run this inside the application container with the same `PORCHFEST_DATA_DIR`
and `PUBLIC_BASE_URL` environment that the application uses. For the reference
Compose deployment, whose application service is named `app`, that is:

```bash
docker compose exec app npm run organizer:link
```

The image pins `PORCHFEST_DATA_DIR=/data` and Compose passes `PUBLIC_BASE_URL`
from `.env`, so `docker compose exec` inherits both; a deployment that never set
`PUBLIC_BASE_URL` must supply it (`docker compose exec -e PUBLIC_BASE_URL=…`),
or the command refuses rather than print a link that points nowhere. In a
development checkout, run the script directly with the same environment:

```bash
npm run organizer:link
```

With exactly one active organizer, the command selects that account and prints a
fresh single-use sign-in URL for its registered email address. Open it before
its one-hour expiry. With several active organizers, the command refuses to
guess and lists their IDs and addresses. Select one explicitly:

```bash
npm run organizer:link -- --organizer organizer@example.invalid
```

An organizer ID may replace the address. Deactivated organizers cannot receive
recovery links. An unknown organizer, a missing data directory, or a missing
`porchfest.db` file exits non-zero with an explanation. If no organizer exists
yet, the command prints a first-run bootstrap URL and reminds the operator that
normal application boot also prints one to the container log; that URL expires
in one hour.

The printed link is a bearer credential to the whole participant contact
database. Read it directly from the operator's terminal and open it there. Do
not paste it into chat, a support ticket, or any other retained system. It works
once, but until redemption or expiry anyone holding it can sign in as the named
organizer.
