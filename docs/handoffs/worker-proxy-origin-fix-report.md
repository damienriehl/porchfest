# Proxy origin guard fix report

## Decision summary

- Route origin enforcement remains the default. `/health` alone declares the validated
  `requestOriginCheck: "exempt"` route policy so the container loopback probe is independent of
  Host and public-origin configuration.
- `PORCHFEST_TRUSTED_PROXY_HOPS >= 1` authorizes use of one canonical
  `X-Forwarded-Proto: http|https` value. The numeric hop count is the trust gate, as it is for
  forwarded client-IP handling; it is not used to index a protocol list. Missing, malformed, or
  comma-separated protocol values fail closed to the socket-visible origin.
- The trusted scheme is combined with the raw request Host authority before URL normalization.
  This preserves an explicit external port that could be the internal HTTP scheme's default.
- The route-origin guard and mutation Origin/CSRF checks stay separate. A trusted proxy can restore
  the request's external scheme, but it cannot make a cross-origin cookie-authenticated mutation
  pass the mutation Origin check.

Date: 2026-09-02

Branch: `fix-proxy-origin-guard`

Starting commit: `462b5cb79920ca8b9f243004137f60e52b56eaf4`

Delivery state: implementation and repository artifact complete; local commit blocked by the
managed sandbox's read-only Git worktree metadata; not pushed or merged

## Outcome

The configured public-origin guard now compares application requests with their effective external
origin behind a declared trusted TLS-terminating proxy. With no trusted proxy, it ignores
`X-Forwarded-Proto`, so a direct client cannot spoof HTTPS to bypass the guard.

The `/health` declaration uses a narrow route-metadata exemption. Unknown origin-check policy
values are rejected during route registration. No path string matching or global health special
case was added.

No dependency or lockfile changed. `npm rebuild` was not run. The requested install command was
invoked once against the existing workspace installation and was interrupted after it produced no
output or completion for one minute. It changed neither `package-lock.json` nor the working tree.
The requested `git checkout -- package-lock.json` could not acquire the read-only linked-worktree
index lock, but `package-lock.json` already matched `HEAD` before and after the install attempt.

## Files changed

- `packages/web/src/router/registry.ts`
- `packages/web/src/app.ts`
- `packages/web/test/app.test.ts`
- `packages/web/test/auth.test.ts`
- `docs/handoffs/worker-proxy-origin-fix-report.md`

## HTTP behavior proved

The real-app request tests cover:

- configured `allowedOrigin`, loopback `/health`, and `Host: 127.0.0.1:9398` -> `200`;
- trusted hops `1`, internal HTTP request, public Host, and `X-Forwarded-Proto: https` -> `200`;
- trusted hops `0` with the same spoofed forwarded protocol -> `421`;
- trusted hops `1` with a comma-separated ambiguous protocol value -> `421`;
- trusted hops `2` with the proxy's single canonical HTTPS protocol value -> `200`;
- trusted hops `1` with external `https://...:80` and internal `http://...:80` -> `200` without
  losing the explicit external port;
- trusted hops `1`, valid cookie and CSRF token, but a sibling-site mutation Origin -> `403`.

The last case exercises the existing sign-out mutation through the effective-proxy-origin path. It
shows that correcting the external scheme does not weaken KTD16 Origin or CSRF enforcement.

## Review

A structured review ran correctness, security, adversarial, testing, API-contract, reliability,
and repository-learnings lenses. The cross-model route could not start because the managed command
sandbox explicitly disables network egress and does not permit escalation; a local adversarial
review ran instead.

The review found one concrete edge case: changing the scheme on the already-normalized internal URL
could drop an explicit external port such as `https://host:80`. The fix reconstructs the effective
origin from the canonical trusted scheme and raw Host authority, rejects malformed authorities by
falling back to the socket-visible origin, and adds a regression test. No actionable review findings
remain.

Review run: `20260902-131542-875e711f` (temporary artifacts; durable conclusions are recorded here).

## Verification

Node v24.13.0 was used.

The changed web behavior passed its focused suite: 3 files, 51 tests.

The broad suite excluding only the SMTP listener tests passed:

```text
Test Files               47 passed (47)
Tests                    924 passed (924)
core boundary self-test  pass
route boundary self-test pass
check:boundaries         pass
check:clean-room         pass
```

The exact requested command was run against the final diff. Its result was:

```text
npm run typecheck        exit 0
npm run lint             exit 0 (0 errors; 2 pre-existing unused-stamp warnings)
npm run format:check     exit 0
npm test                 exit 1: sandbox denies listen(127.0.0.1) with EPERM
Test Files               47 passed, 1 failed
Tests                    927 passed, 18 SMTP listener tests timed out
npm run check:boundaries not reached by the && chain; passed separately
```

This environment prevents local TCP listeners. Every failure is in
`packages/email/test/smtp.test.ts` after its catcher receives `listen EPERM: operation not
permitted 127.0.0.1`. Running Vitest with that one unrelated file excluded passes all 924 remaining
tests. The clean-room self-test also cannot run in this sandbox because its nested `git init` is
denied with EPERM; the actual clean-room scan passes separately.

## Post-Deploy Monitoring & Validation

- Confirm the container remains healthy across several healthcheck intervals and Traefik keeps the
  backend in rotation.
- Request `/health` on container loopback and `/` through the public HTTPS hostname. Expected
  signals are HTTP 200 responses with no restart or routing churn.
- Search application and proxy logs for `Unrecognized request host.` and HTTP 421 responses. Any
  sustained 421s on the public hostname, container health failure, or backend removal is a rollback
  trigger.
- During the first 15 minutes after deployment, the deploy operator should also verify that a direct
  request cannot reach the private application port and that Traefik overwrites
  `X-Forwarded-Proto` with one canonical value.

## Repository state

The source and this durable handoff are present in the working tree. The managed sandbox permits
file edits but exposes the linked worktree administrative directory read-only, so Git cannot create
`.git/worktrees/porchfest-proxyfix/index.lock`. As a result, staging and the requested focused
conventional commits cannot be completed here. The branch has not been pushed or merged.
