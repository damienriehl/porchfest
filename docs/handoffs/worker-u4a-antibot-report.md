# U4a anti-bot adapter report

Date: 2026-08-22  
Branch: `feat/u4-signup-forms`  
Status: implemented and locally verified; intentionally uncommitted

## Outcome

- Added the explicit `unavailable` anti-bot outcome. `AntibotResult` is now a discriminated union: `passed` has no reason, while `failed`, `not-configured`, and `unavailable` require a non-empty reason at the shared contract boundary.
- Added `TurnstileAntibotAdapter` using Node's platform `fetch` and Cloudflare's siteverify endpoint. The adapter sends the secret, challenge token, resolved client IP, and a server-generated idempotency key as form data.
- Turnstile transport exceptions, non-2xx responses, malformed JSON/bodies, and the explicit five-second default timeout return `unavailable`. Provider challenge rejection returns `failed`; neither path can become `passed`.
- Added atomic single-use token claiming. The adapter SHA-256 hashes tokens before passing them to the injectable `SingleUseTokenStore`; the default in-memory store never retains the raw challenge token. A token is claimed before the network call, so concurrent replay and replay after an unavailable call cannot silently pass.
- Added a no-configuration guard combining a sliding-window per-IP cap and honeypot refusal. Defaults are five attempts per 60 seconds.
- Added directly testable client-IP resolution. With proxy trust unset (or zero), `X-Forwarded-For` is ignored. With a positive trusted-proxy hop count, resolution walks from the right side of the forwarded chain; an absent peer or an insufficient chain falls back to a stable, non-bypassable peer/`unknown` key.
- Kept `NullAntibotAdapter` unchanged and honest: `configured === false` and verification returns `not-configured` with a reason.
- Added no runtime dependency and did not touch `packages/web/**` or the protected U3 core files.

## Files changed

- `packages/core/src/ports/antibot.ts`
- `packages/antibot/src/index.ts`
- `packages/antibot/src/turnstile.ts`
- `packages/antibot/src/ratelimit.ts`
- `packages/antibot/test/contract.ts`
- `packages/antibot/test/turnstile.test.ts`
- `packages/antibot/test/ratelimit.test.ts`
- `docs/handoffs/worker-u4a-antibot-report.md`

`behavior_changed`: `true`

## Existing tests and conventions inspected

- `packages/antibot/test/contract.ts`
- `packages/antibot/test/null.test.ts`
- `packages/antibot/src/index.ts`
- `packages/core/src/ports/antibot.ts`
- `packages/core/src/ports/index.ts`
- `packages/core/src/index.ts`
- `vitest.config.ts`
- `scripts/check-core-boundary.test.mjs`

The existing anti-bot contract was extended rather than replaced or duplicated.

## Tests added or changed

- Extended `packages/antibot/test/contract.ts` to admit all four statuses and require a populated reason for every non-passing result.
- Added `packages/antibot/test/turnstile.test.ts` covering:
  - successful siteverify request and response;
  - provider rejection and missing token;
  - transport failure, non-2xx response, malformed JSON, malformed body, and timeout as `unavailable`;
  - raw-token exclusion from the replay store;
  - sequential and concurrent replay refusal;
  - the shared port contract.
- Added `packages/antibot/test/ratelimit.test.ts` covering:
  - burst rejection, window expiry, and independent IP buckets;
  - clean and honeypot submissions through the real unconfigured guard chain;
  - ignored spoofed forwarding when trust is unset;
  - configured one- and two-hop resolution;
  - insufficient forwarding chains, missing peers, and invalid hop counts.
- Kept `packages/antibot/test/null.test.ts` unchanged and used it through the strengthened contract.

Scenario completeness: happy paths, input and timing edges, downstream/error paths, and package-level integration through real guard/store objects are covered. The `unavailable -> no persistence` assertion belongs to `packages/web/test/signup.test.ts`; no persistence API exists in the owned package seam, and `packages/web/**` was explicitly out of scope.

## Proof-first red observations

Tests were written before production changes.

- `npm run typecheck` exited 2. The intended contract failure was `Type '"unavailable"' is not assignable to type '"passed" | "failed" | "not-configured"'`; TypeScript also correctly reported that a non-passing result's optional `reason` could be undefined. The new adapter and guard imports were absent, as expected.
- `npx vitest run packages/antibot/test/null.test.ts packages/antibot/test/turnstile.test.ts packages/antibot/test/ratelimit.test.ts` exited 1 with 21 failed and 2 passed. Every new Turnstile and rate-limit test failed because the expected exports/classes/functions did not yet exist (`TurnstileAntibotAdapter is not a constructor`, `resolveClientIp is not a function`, and equivalent missing implementation failures). The pre-existing null-adapter tests remained green.

After implementation, the same focused run passed 23/23.

## Verification results

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: passed with 15 test files and 176 tests; the core-boundary, route-boundary, and clean-room self-tests also passed.
- `npm run format:check`: passed.
- Focused anti-bot run: 3 files, 23 tests, all passed.

The first sandboxed `npm test` attempt completed Vitest at 176/176 and both boundary checks, then the clean-room self-test could not spawn its temporary `git init` (`EPERM`). The identical rerun with temporary-repository permission passed in full.

## Integration notes and spec comparison

- No code/spec disagreement was found.
- `status !== "failed"` remains an unsafe caller check: it treats both `not-configured` and `unavailable` as if they were verified. The port's discriminated union makes the four cases explicit and makes every non-passing reason mandatory, but TypeScript cannot prevent that particular boolean comparison. The web consumer must switch exhaustively: `passed` proceeds; `not-configured` proceeds only after the unconfigured guard passes; `failed` and `unavailable` refuse without storing anything.
- KTD10's signed-cookie form mint is an HTTP concern for the web-owned signup route. This package supplies the server-generated siteverify id, token-hash claim seam, replay guard, IP resolver, cap, and honeypot decision, but does not set or parse cookies because the core port contains no HTTP surface and `packages/web/**` is owned by the other unit.
- The replay store is injectable so the composition root can replace the in-memory default without changing the adapter or core port.

No staging, commit, push, merge, or branch change was performed. All work is left uncommitted for the orchestrator.
