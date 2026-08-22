---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-22T22:10:00Z"
title: "Porchfest U4 — adapter and core seam landed, signup forms in flight"
summary: "U4a (anti-bot adapter) and U4c (R1 field model + transactional signup seam) are committed on feat/u4-signup-forms; U4b (public signup forms) is dispatched with an approved design direction. Nothing pushed."
keywords:
  [
    "porchfest",
    "u4",
    "signup-forms",
    "antibot",
    "ktd10",
    "ktd7",
    "core-executor",
  ]
resume_focus: "Verify U4b's output, then ship U4"
repository: "porchfest"
branch: "feat/u4-signup-forms"
---

# Porchfest U4 — adapter and core seam landed, signup forms in flight

## Where this stands

`feat/u4-signup-forms` carries three commits above `main`. **Nothing has been pushed.**

- `b9dcb0d` — **U4a, anti-bot adapter.** `AntibotResult` is now a discriminated union
  (`passed` with no reason; `failed` / `not-configured` / `unavailable` each requiring one).
  Turnstile maps every transport error, non-2xx, malformed body, and a 5s timeout to
  `unavailable`; only an explicit provider rejection is `failed`; no path reaches `passed`.
  Tokens are SHA-256 hashed and claimed **before** the network call, so a replay after an
  `unavailable` cannot slip through — a transient outage burns that token, deliberately.
  Per-IP limiting plus honeypot is the unconfigured default, and `X-Forwarded-For` is
  ignored entirely unless a trusted-proxy hop count is configured (KTD10).
- `cd2c975` — **U4c, R1 field model and the creation seam.** See below.
- **U4b is dispatched and running** as worker `pf-u4b-signup2`.

All six CI gates pass on the branch: `check:clean-room`, `check:boundaries`, `typecheck`,
`test`, `lint`, `format:check`. **`format:check` is the one that gets forgotten** — it is a
real CI gate and it failed a previous PR after everything else was green.

## The gap U4c filled, and why it existed

U4b was dispatched once and returned **blocked**, correctly. `core` had no creation API at
all — `createSeasonRepository` exposed update, promote, supersede, assign, and reads — and
eleven R1 fields had no storage. Reaching past the seam with raw SQL in `web` would have
violated KTD2, so the worker stopped rather than working around it.

**This is a gap in the plan, not just the code.** Record _creation_ was never assigned to
any unit: U3 built the record lifecycle, U5 covers organizer-made placeholders, U10 covers
import. U4 declares a dependency only on U3. A `ce-plan` rebaseline should add a creation
unit or fold it into U3's scope explicitly; `ce-work` forbids editing the plan body during
execution, so it was not amended in place.

## What U4c landed

- **Scalars as typed columns:** `acts.duration_minutes`, `requires_amplification`,
  `house_preference`, `can_lend_gear`; `venues.space_description`, `has_power`,
  `rain_backup`.
- **Multi-value sets as season-scoped child tables** with a unique index per owner+value:
  `venue_gear`, `venue_drinks`, `venue_amenities`, `act_availabilities`. Migration `0003`.
  They are deliberately **not** JSON blobs: R8 needs deterministic suggestions to reason
  over gear/power compatibility, R10 needs gear values byte-traceable to a record, and R14
  lets participants edit them individually.
- **`createHostSignup` / `createPerformerSignup`** on the season repository, each wrapping
  the legality check and the delegated write in one
  `db.transaction(..., { behavior: "immediate" })` built on U3's `CoreExecutor` seam.
  A new `signup` action is legal in `signups_open` and `assigning`.

## Constraints that must survive

- **KTD7 pins the compare-and-swap guard.** Predicate inside the UPDATE, verdict from the
  affected-row count. Do not restructure it, do not consolidate the per-entity CAS
  functions, do not swap `.changes` for `.returning()`. Refused five times now.
  **Verification note:** `records.ts` legitimately gained seven `.returning()` calls in
  U4c — all on INSERTs returning created rows. Check each new one's statement verb rather
  than trusting the count; `.changes` should stay at 13 in `records.ts` and 6 in `season.ts`.
- **KTD10** — `unavailable` is a refusal that stores nothing. `status !== "failed"` is an
  unsafe check because it admits both `not-configured` and `unavailable`; switch
  exhaustively on all four.
- **KTD2** — `core` owns domain and storage; `web` consumes the seam and never writes SQL.
- **Delegation is codex-first.** Dispatch via `agents/worker-wrapper.sh` **invoked from
  inside this repo** — it derives the repo from `pwd`. Never let a reporting command be the
  last in the chain (`ec=$?; echo ...; exit $ec`), or a failed launch reports success.
- **A worker's report file is not a completion signal — only process exit is.** An earlier
  commit on this line captured a green but partial state for exactly that reason.

## Verification standard

`docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`. For a guard
whose failure is silent, a green suite proves nothing — break it, watch a **named** test
fail, restore, confirm byte-identical with `sha256sum`. Every guard in U4a and U4c was
verified this way, and the headline ones were re-verified independently of the worker that
wrote them.

## What U4b must deliver

Public host and performer forms (R1, R3, R5) consuming U4a's adapter and U4c's seam, with
an approved design direction: inherit the map's existing palette; one page, never a wizard;
`fieldset`/`legend` grouping with no numbering; errors above the field plus a focusable
error summary; and a live "porch card" preview that no-ops without JS and renders
server-side on the confirmation page. Accessibility is a Verification Contract gate, not a
nicety: labels, keyboard operability, visible focus, 44x44 targets.

Deferred deliberately: self-hosting the Montserrat/Lato woff2 files (both SIL OFL 1.1,
needs a `THIRD-PARTY.md` entry). The tokens ship with a deliberate fallback stack so the
page looks intentional either way.

## Also worth knowing

The 2026 season itself is live and was updated the same day: the public map at
sapporchfest.org now carries 20 venues and 25 acts. That work is operational, not code,
and its notes live outside this repo because they contain participant PII, which the
clean-room scan and the Definition of Done both forbid here.
