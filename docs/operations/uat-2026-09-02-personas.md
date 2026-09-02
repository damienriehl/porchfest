# Porchfest UAT — personas and user stories (2026-09-02)

Grounded in the Product Contract's actors (A1–A5) and requirements (R1–R35) of
`docs/plans/2026-08-20-0830-feat-porchfest-platform-plan.md`. Each story cites
the requirement(s) it exercises; the UAT run records pass/fail per story with
evidence. Failures route to ce-debug (small) or a ce-plan doc (extensive).

## Personas

- **P1. Dana — founding organizer-deployer** (A1+A5). Stood up the instance;
  technical; owns first-run setup, season lifecycle, retention, backups.
- **P2. Marge — Tuesday-night co-organizer** (A1). Invited by Dana;
  non-technical; works the queue on a laptop after dinner; the plan's
  "organizer other than Damien" test subject.
- **P3. Hal — host** (A2). Neighbor offering a porch; fills the long venue form
  on his phone; later corrects his address; wants to know what's public.
- **P4. Priya — performer** (A3). Fronts a two-person act; her bassist also
  plays in another act; messy links field; later requests an availability
  change and eventually withdraws.
- **P5. Wes — attendee** (A4). No account; opens the public map on his phone on
  event day while walking.
- **P6. Sam — stranger deployer** (A5/R20). Found the repo; deploys for a
  different neighborhood from the README alone; no email provider at first.
- **P7. Mallory — adversary** (no legitimate actor). Scripts form spam, replays
  tokens, spoofs headers, probes enumeration, injects markup.

## User stories

### P1 Dana (founding organizer-deployer)

- S1.1 First-run setup: from empty DB through `/admin/setup` to a season that
  accepts a public signup (R34).
- S1.2 Bootstrap auth: sign in from the log-printed bootstrap URL; second
  bootstrap attempt refused once she exists (R9).
- S1.3 Invite Marge by generated link with no provider configured (R9).
- S1.4 Open another season for a new year; duplicate-year confirmation on
  create and on edit (R2, R21, review items).
- S1.5 Edit event details with dependent data present: refusal names clearable
  blockers only; bounds-only change re-checks coordinates with an accurate
  reason (review items 2/4).
- S1.6 Season lifecycle: open → matching → locked → event day → archived; each
  transition names what it stops allowing; archived records read-only (R28).
- S1.7 Retention/deletion: delete a participant; contact fields gone from
  records, archives, annotations, send history (R35).
- S1.8 Publish the map for the active season by explicit act; draft/archived
  seasons serve nothing (R16).

### P2 Marge (Tuesday-night co-organizer)

- S2.1 Accept invite, sign in, reach the queue (R9).
- S2.2 Queue triage: new signups and participant edits appear; her dismiss
  clears items for her only — Dana still sees them (R5).
- S2.3 Fix a typo in a venue record; original submission stays readable (R6).
- S2.4 Assignment: venue-first view, ranked reason-bearing suggestions; mutual
  requests rank first; amplified act not suggested to a powerless porch ahead
  of an acoustic one (R7, R8).
- S2.5 Double-booking and shared-member conflicts blocked by name; the
  shared-member block overridable only by recorded explicit override (R7).
- S2.6 Ties between equal candidates carry the per-venue explanation (review
  item 9).
- S2.7 Concurrent edit: her stale save is refused, names the conflict, keeps
  her typed values on the form (R32/AE11, review item 5).
- S2.8 Generate a wave; edit one message; underlying record change marks it
  stale with edits intact (R10, R30/AE8).
- S2.9 With no provider: outbox offers review/copy/export only, nothing sends
  (R12/AE1). With SMTP configured (prod shakedown): send is Damien-only.
- S2.10 Mark a matched act withdrawn: slot reopens, act leaves the regenerated
  map, email history intact (R6, R16/AE2).
- S2.11 Placeholder lifecycle: create placeholder act reached via its host;
  promote the real submission into it; assignment and email history survive
  (R26/AE7). Supersede a resubmission; it leaves the queue (R27).
- S2.12 Holds: held slot blocks assignment and stays off the map; past
  decide-by it surfaces as releasable; release offers the fallback (R25/AE6).

### P3 Hal (host)

- S3.1 Phone signup with every 2026 field; values round-trip (R1) at 375px.
- S3.2 Validation failure re-renders with everything he typed intact and the
  failing field named (U4 contract).
- S3.3 Receipt: confirmation states what happens next, shows a durable
  reference, honest no-email notice when unconfigured; preview shows ONLY
  public-labelled fields (review item 1).
- S3.4 The form states plainly that an accepted venue's address becomes public
  (R16).
- S3.5 Magic link (provider configured): edit contact/descriptive fields;
  assignment/slot/status/coordinates read-only; his own notes never touch
  organizer annotations (R14).
- S3.6 Address correction as change request: queued, assignment stands until an
  organizer applies it (R33); edit appears in queue (R15).
- S3.7 Expired link refused with reissue offer; reissue throttled per record;
  known vs unknown address indistinguishable (R31).

### P4 Priya (performer)

- S4.1 Performer signup with messy links text → structured links plus note
  residue; genres, gear, slots, shared-member flag captured (R1).
- S4.2 Shared member surfaced in both acts' views; same-slot assignment
  refused without override (R7).
- S4.3 Availability change request queues for approval (R33).
- S4.4 Withdrawal: her magic link is revoked after processing (R31); slot
  reopens (AE2).
- S4.5 Her `javascript:` link is rejected at submit; markup in her description
  renders inert everywhere it appears (U4 XSS contract).

### P5 Wes (attendee)

- S5.1 Public map page loads fast on a phone, one pin per performing venue,
  popups show acts/slots/genres/links (R16); no console errors at 375px.
- S5.2 Venue with two acts shows both with slots in one popup.
- S5.3 No contact info, annotations, or non-public fields anywhere in the map
  JSON (R22).
- S5.4 Withdrawn act absent; held slot produces no act (R16, R25).
- S5.5 Unpublished/draft/archived season → map serves no venue data (R16).

### P6 Sam (stranger deployer)

- S6.1 `docker compose up` on a clean machine → health endpoint, no env (R19).
- S6.2 README path: bootstrap login → first-run setup → open season, without
  asking anyone (R20).
- S6.3 Unconfigured mode is honest: rate limit + honeypot still guard signup;
  outbox exports; self-serve hidden; public map serves (verification contract).
- S6.4 Boot with the `.env.example` placeholder secret refuses to start (KTD15).
- S6.5 Docs say which features need a provider (R20).

### P7 Mallory (adversary)

- S7.1 Configured challenge timeout → submission refused, nothing stored
  (R3/AE5); replayed challenge token refused.
- S7.2 Unconfigured: burst from one IP rate-limited; honeypot dropped (R3).
- S7.3 Spoofed `X-Forwarded-For` doesn't reset the cap with proxy trust unset
  (KTD10).
- S7.4 Hostile `Host`/`X-Forwarded-Host` on reissue still yields
  `PUBLIC_BASE_URL` links (KTD16).
- S7.5 Magic link for one record can't read/write another; revoked link dead
  (R31).
- S7.6 Cross-origin cookie-authenticated write refused (KTD14).
- S7.7 Unauthenticated admin route refused; route without trust tier fails
  closed (R9, KTD16).
- S7.8 Unexpected route error → honest 5xx catch-all, no stack trace (review
  item 6).

## Execution notes

- Local instance: fresh container, synthetic fixture season for structure plus
  scripted signups; SMTP catcher (mailpit or the repo's harness) for
  provider-configured stories; no real addresses, no real sends.
- Prod smoke (after deploy): S5.x against app.sapporchfest.org, S6.1 health,
  cookie flags, HTTPS redirect — read-only; no participant-facing writes
  beyond a throwaway test season? NO — prod carries the real season; prod
  checks are read-only only.
- Browser stories (phone-width, console, focus states) run in the Chrome
  DevTools MCP per repo convention.
