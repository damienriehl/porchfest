---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-23T14:35:00Z"
title: "Porchfest U4 — reviewed, remediated, pushed"
summary: "fb83eef's review gate is closed. Four adversarial review lenses plus browser verification found eleven defects; all are fixed on feat/u4-signup-forms, six gates green, 249 tests, pushed to origin. No PR opened."
keywords:
  [
    "porchfest",
    "u4",
    "signup-forms",
    "code-review",
    "timezone",
    "antibot",
    "ktd10",
    "ktd2",
  ]
resume_focus: "Open the PR when ready, or start U5 — first-run setup now edits seasons.timezone rather than introducing it"
repository: "porchfest"
branch: "feat/u4-signup-forms"
---

# Porchfest U4 — reviewed, remediated, pushed

## Where this stands

`feat/u4-signup-forms` is pushed to `origin` for the first time. **No PR is open** —
that was Damien's call, so he sees the diff first.

- `6bfc3c3` — the remediation. 28 files, +5139/-271.
- `8dc15b7` — the owner-approved plan rebaseline.
- `66b7082` — a map fix from a **concurrent session** that landed mid-work. Zero file
  overlap with the remediation; the gates ran green with it present.

All six gates pass: `typecheck`, `lint`, `format:check`, `check:boundaries`,
`check:clean-room`, `test` (249 tests, up from 206).

## What the review found

fb83eef was committed on evidence rather than a clean worker exit and had never been
read line by line. Four Codex reviewers ran in parallel — KTD conformance, security,
plan conformance, correctness — plus browser verification through chrome-devtools.
**No P0. Eleven real defects, every one confirmed rather than suspected.** Three
reviewers independently found the same top three, which is why they are worth trusting.

The two that needed Damien's call, and his answers, are on the Decision Sheets
`porchfest-2026-08-23-1340-u4-review-decisions` and
`porchfest-2026-08-23-1355-u4-followup-decisions`.

## The two that mattered most

**Availability was stored five hours off.** `datetime-local` submits a timezone-free
wall clock; the parser appended `Z`. A performer in Saint Paul typing 2:00 PM had
9:00 AM stored. Reproduced in a real browser against real SQLite before the fix, and
again after: typed 2:00 PM now stores `19:00Z` and reads back as 2:00 PM Central.
The old test pinned a hardcoded epoch computed from the same wrong assumption, which
is exactly why the suite was green while the behaviour was wrong.

**The anti-bot adapter could not be switched on.** `createAdapterSet` always built the
null adapter; no env var selected Turnstile, so R3's "fails closed when configured"
branch was unreachable outside tests — and even wired, the form rendered a bare text
box no human could complete, with a CSP that would have blocked the widget anyway.

## Constraints that must survive

- **KTD7 is unchanged and still pinned.** The remediation touched neither CAS function.
  `.changes` remains 13 in `records.ts` and 6 in `season.ts`; every `.returning()` is
  on an INSERT.
- **KTD2's seam is now load-bearing in a new place.** The adapter publishes an
  `AntibotClientChallenge` descriptor — script URL, mount element, CSP origins — and
  `web` renders it blind. `grep -riE 'cloudflare|turnstile' packages/web/src` returns
  only `composition.ts`, which is the composition root and the correct place. **Do not
  put a provider name in a view.** That is the whole point of the descriptor.
- **The CSP is assembled from that descriptor**, so it widens by exactly what a
  configured provider asks for and is self-only otherwise. Verified both ways.
- **`PORCHFEST_TRUSTED_PROXY_HOPS=1` in `compose.yaml` is topology-specific.** It is
  correct for the checked-in single-Caddy stack and **wrong for a direct deployment**,
  where a spoofed forwarded header would defeat the per-IP cap. The application default
  stays unset on purpose.
- **Both Turnstile values are required together.** Configuring one alone is a startup
  refusal, not a silent downgrade — a deployment that believes it enabled protection
  must not quietly run without it.
- **Validation runs before verification.** Reordering these re-creates the bug where
  fixing a named field and resubmitting failed as a replay.

## Verification standard met

`docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`. Both
headline guards were mutation-tested: neutralize the season-timezone conversion and
three named tests fail; neutralize the always-on per-IP cap and three different named
tests fail. Both files restored byte-identical, confirmed by `sha256sum`.

Browser verification at 1440px and 390px covered the timezone round trip, the widget
mounting with the CSP permitting it, the public/private receipt, 44px touch targets,
`:focus-visible`, and a clean console.

## Accepted residual

**One P1 was deliberately not fixed.** The KTD-lens reviewer flagged that
`packages/web/test/signup.test.ts` reaches into core's SQLite file with raw SQL,
which is a KTD2 smell in a web-package test. It is left in place, and the new
`signup-hardening.test.ts` does the same in two places, because the plan's
Verification Contract explicitly requires assertions against a real database and core
exposes no test-support seam to read availability rows through. Closing it properly
means adding that seam — a core change worth doing deliberately in U5, not smuggled
into a review remediation. Production code is unaffected: `web` writes no SQL.

## Also worth knowing

Two questions on the older ask `porchfest-2026-08-22-1648-u3-open-decisions` were
retired rather than answered: `cd2c975` had already threaded the transaction handle
through (`CoreExecutor = CoreDatabase | CoreTransaction`), and the plan had already
moved into this repo in `4553bb0`. Both were verified against the tree before the ask
was closed.
