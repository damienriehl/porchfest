---
module: packages/web
date: 2026-08-23
problem_type: integration_issue
component: composition_root
severity: high
related_components:
  - adapters
  - security
tags:
  - adapter-seam
  - dead-configuration
  - unreachable-branch
  - test-only-path
  - fail-closed
applies_when: "Shipping a pluggable adapter behind a port, where a deployment is meant to enable it by configuration."
related:
  - "docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md"
---

# An adapter no deployment can select is not shipped, however well it is tested

## Context

U4a delivered a fail-closed Turnstile anti-bot adapter: a four-way discriminated
result, every transport failure mapped to `unavailable`, tokens hashed and claimed
before the network call so a replay after an outage cannot slip through. It was
carefully built, thoroughly tested, and exported from its package.

It could not be turned on. `createAdapterSet` read no configuration:

```ts
antibot: overrides.antibot ?? new NullAntibotAdapter(),
```

The only caller that ever passed an override was the test suite. `packages/web/src/server.ts`
calls `createRuntime()` with no arguments, so **every real deployment ran the
no-provider default**, and R3's "fails closed when configured" branch existed only
inside tests.

The second half was worse. Even with the adapter injected, both forms rendered a bare
text input asking the visitor to paste a verification response. No widget, no provider
script — and the response CSP was `default-src 'self'`, which would have blocked one.
A configured deployment would have had forms **no human could submit**.

## Why nothing caught it

Every test injected the adapter directly and set the token by hand. That is a
reasonable way to test the adapter, and it is why the adapter's own suite was green
and meaningful. What no test asserted was the path a deployment actually takes:
environment → composition root → port → rendered page. The seam was verified from the
inside out and never from the outside in.

Three independent reviewers found this within minutes of being pointed at the
_deployment_ path rather than the code path.

## What fixed it

- The environment selects the adapter, and **both** Turnstile values are required
  together. One alone is a startup refusal, not a silent downgrade: a deployment that
  believes it enabled protection must never quietly run without it.
- The adapter publishes an `AntibotClientChallenge` descriptor — script URL, mount
  element and attributes, response field, and the CSP origins it needs — and `web`
  renders it blind. The response policy is assembled from that descriptor, so it
  widens by exactly what a configured provider asks for and stays self-only otherwise.
- That descriptor is also what keeps KD2's no-lock-in promise real. `grep -riE
'cloudflare|turnstile' packages/web/src` returns only `composition.ts`, which is the
  composition root and the correct place for an adapter to be named.

## What to do next time

- **Ask "what does a deployment set to turn this on?"** before calling an adapter
  done. If the answer is "a test passes it in", it is not wired.
- **Test through the composition root**, from environment variables inward, at least
  once per adapter. A test that constructs the adapter itself cannot see dead
  configuration.
- **If a feature needs something from the browser, the port must say so.** Naming a
  provider in a view is how an adapter seam quietly stops being one.
- **Require paired credentials together.** Partial configuration that silently
  degrades to "off" is the same failure class as a fail-open check.
