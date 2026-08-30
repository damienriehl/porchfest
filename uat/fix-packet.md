# Porchfest organizer UAT fix packet — 2026-08-30

This packet turns the consolidated observer findings in
`docs/operations/organizer-uat-2026-08-30-result.md` into one branch-sized fix
set. Priority follows the UAT rule: broken or assisted task paths outrank
cosmetic polish. Items 1–11 are the proposed branch scope; larger product and
schema work is parked under **Later**.

## Fix in this branch

1. **Replace stale first-run setup with atomic first-season creation and a
   seasons page (D1).**

   - **Lives in:** `packages/core/src/setup.ts`,
     `packages/web/src/routes/admin.ts`,
     `packages/web/src/views/admin-shell.ts`,
     `packages/core/test/season.test.ts`, `packages/web/test/setup.test.ts`, and
     `packages/web/test/app.test.ts`.
   - **Expected behavior:** `/admin/setup` is first-run-only. After a season
     exists, GET redirects to `/admin/seasons`, and a stale POST cannot create a
     row. The seasons page lists existing seasons and offers an explicit
     **Open another season** route whose language and domain command make clear
     that it creates rather than edits. The first-season domain operation must
     combine “no season exists” and insert in one transaction; a route-level
     `needsFirstRun()` check alone is not sufficient.
   - **Proof:** create one season, revisit and POST `/admin/setup`, and assert
     `seasonCount()` remains 1. Submit two first-run requests from the same
     starting state and assert only one succeeds. Follow **Open another season**
     and assert its distinct route intentionally creates season 2. Cover signed
     out, wrong-origin, missing-CSRF, repeated stale-submit, and two-tab cases.

2. **Add a versioned event-details editor with explicit dependent-data rules
   (D2, F2, F3).**

   - **Lives in:** `packages/core/src/setup.ts`,
     `packages/core/src/season.ts`,
     `packages/web/src/routes/admin.ts`,
     `packages/web/src/views/admin-shell.ts`,
     `packages/web/src/views/season-lifecycle.ts`,
     `packages/core/test/season.test.ts`, `packages/web/test/setup.test.ts`, and
     `packages/web/test/app.test.ts` (the existing season version is in
     `packages/core/src/storage/schema.ts`; no new column is required).
   - **Expected behavior:** `/admin/seasons/:id/edit` reads back and saves the
     display name, event date, city/region, timezone, signup dates, locality and
     decimal-degree bounds, slots, public site/map URLs, and sender
     name/address. Reuse core setup validation rather than creating a second web
     validation vocabulary. Save is one transactional compare-and-swap on the
     season version; stale forms overwrite nothing. For this branch, refuse
     date/timezone/slot changes after participant, venue-slot, hold, assignment,
     or outbox data exists. Refuse locality/bounds changes once coordinates or a
     published map exist. Explain the dependent state that must be cleared
     instead of silently reinterpreting stored instants or map data.
   - **Proof:** edit every field on an empty season and assert stored and
     rendered read-back. Submit an old version and assert an actionable 409 with
     no partial update. Delete the version predicate in a mutation check and
     prove the stale-write test fails. Add validation cases for invalid timezone,
     partial/out-of-range bounds, malformed URLs/email, and slot replacement;
     then add populated-season cases for signups, venue slots, holds,
     assignments, coordinates/publication, and outbox messages, asserting unsafe
     schedule or bounds edits are refused atomically.

3. **Make the participant audience contract match the notification behavior
   (D3, F6).**

   - **Lives in:** `packages/web/src/views/signup-view.ts`,
     `packages/web/src/views/host-form.ts`,
     `packages/web/src/views/performer-form.ts`,
     `packages/core/src/outbox.ts`, `packages/core/src/waves.ts`,
     `packages/web/test/signup.test.ts`, and
     `packages/core/test/outbox.test.ts`.
   - **Expected behavior:** use three explicit audiences everywhere:
     **Public map**, **Shared with a confirmed match**, and **Organizer-only**.
     Label each field before submission and repeat the same classification on
     the receipt. Contact details and host notes that the match notification
     shares must say so; fields labelled Organizer-only must never enter a
     message to another participant. The full street address must explicitly say
     it is public. Rain-backup and amenity help must explain what a “No” or a
     checked item means.
   - **Proof:** drive host and performer data from form through receipt and a
     generated match notification. Assert every field appears only in its
     declared audience, contact/host-note sharing is disclosed before submission,
     and no Organizer-only field reaches the other participant. Use a canonical
     classification table or equivalent assertions so form and receipt cannot
     drift together while both remain wrong.

4. **Correct and complete match-notification venue content (D4, D5).**

   - **Lives in:** `packages/core/src/outbox.ts`,
     `packages/core/src/waves.ts`, `packages/core/test/outbox.test.ts`, and
     `packages/core/test/waves.test.ts`.
   - **Expected behavior:** generated match messages name the current porch title
     and address and use grammatically neutral copy such as “requires
     amplification.” Regeneration after a venue rename must use the new title
     and never the stale one.
   - **Proof:** rename a matched venue before generation; assert text and HTML
     contain the new porch name, address, and “requires amplification,” and
     assert neither the old name nor “need amplification” appears.

5. **Put absolute, copyable public URLs on organizer surfaces (F1, F3).**

   - **Lives in:** `packages/web/src/app.ts`,
     `packages/web/src/routes/admin.ts`,
     `packages/web/src/views/admin-records.ts`,
     `packages/web/src/views/season-lifecycle.ts`,
     `packages/web/src/routes/signup-paths.ts`,
     `packages/web/test/admin-records.test.ts`, and
     `packages/web/test/season-lifecycle.test.ts`.
   - **Expected behavior:** the activity dashboard and season page show absolute
     host and performer signup URLs for the selected season plus the configured
     public map URL. Build the signup links from the deployment's validated
     public base URL passed through `createApp`; do not present relative strings
     as copyable participant URLs.
   - **Proof:** boot through `createApp` with a non-default `PUBLIC_BASE_URL` and
     season 2. Assert both organizer pages visibly link to
     `<base>/signup/host?season=2`, `<base>/signup/performer?season=2`, and the
     stored map URL, and follow both signup links successfully. Assert safe HTML
     escaping for configured external URLs.

6. **Make public season choice and selected forms self-identifying (F4, F5).**

   - **Lives in:** `packages/web/src/routes/signup.ts`,
     `packages/web/src/views/signup-view.ts`,
     `packages/web/src/views/host-form.ts`,
     `packages/web/src/views/performer-form.ts`, and
     `packages/web/test/signup.test.ts`.
   - **Expected behavior:** pickers continue to include only seasons for which
     signup is legal and display name, formatted event date, locality, and
     human-readable state for each choice. A selected form repeats that context;
     the performer form also lists published slots beside required availability
     and explains whether availability should include setup/teardown buffer.
   - **Proof:** create open and closed seasons, assert only open choices render
     with date/locality/state, and assert both selected forms show the chosen
     season while the performer page shows its slots. A direct request for a
     closed season must remain a 409 with no participant form.

7. **Give receipts a reference and honest correction/withdrawal limits (F8).**

   - **Lives in:** `packages/web/src/routes/signup.ts`,
     `packages/web/src/views/signup-view.ts`,
     `packages/web/test/signup.test.ts`, and
     `packages/web/test/signup-hardening.test.ts`.
   - **Expected behavior:** both receipts show a non-secret submission reference
     derived from the created record and say how to quote it. Until participant
     self-service exists, say explicitly that the receipt cannot be reopened to
     edit, withdraw, or check status. Link a configured public site only when it
     is actually available; otherwise honestly tell participants to retain the
     reference and use the same public organizer channel that supplied the form.
     Do not expose `senderEmail` or another operational address as public support
     without an explicit product decision.
   - **Proof:** submit both forms with and without a public site configured.
     Assert distinct references and exact no-self-service guidance. Assert the
     receipt exposes no organizer session token, CSRF value, private participant
     address, operational sender address, or mutable direct-object URL.

8. **Add a public landing page at `/` with a usable organizer-access path (F1).**

   - **Lives in:** `packages/web/src/app.ts`,
     `packages/web/src/views/signup-view.ts` (or a focused new public landing
     view), `packages/web/test/app.test.ts`, and
     `packages/web/test/signup.test.ts`.
   - **Expected behavior:** `/` returns 200 and offers a porch signup, performer
     signup, and **Organizer access** link to `/admin`. An organizer with a live
     session reaches the dashboard; a signed-out organizer reaches the existing
     honest instructions for obtaining a one-use link. Do not advertise bare
     `/admin/sign-in` as a usable sign-in form when it has no issued token.
   - **Proof:** assert `GET /` is public and 200 with all three links. Follow each
     link for zero, one, and multiple open seasons. Follow organizer access with
     and without a session and assert the dashboard or actionable access
     instructions—not a dead end—appears.

9. **Explain equal matching choices (F9).**

   - **Lives in:** `packages/core/src/matching.ts`,
     `packages/web/src/views/assign-venue.ts`,
     `packages/web/src/views/assign-act.ts`,
     `packages/core/test/matching.test.ts`, and
     `packages/web/test/assign.test.ts`.
   - **Expected behavior:** retain existing order and reasons, but when the best
     candidates or slots have equal scores, label them **Equally suitable based
     on recorded information** rather than implying list position is a
     preference.
   - **Proof:** construct two equal-score slots and assert both organizer views
     show the tie explanation; construct unequal scores and assert the higher
     score remains first without the tie label.

10. **Make provider-disabled outbox language and actions consistent (F10).**

    - **Lives in:** `packages/web/src/views/outbox.ts`,
      `packages/web/assets/admin.js`, and `packages/web/test/outbox.test.ts`.
    - **Expected behavior:** with no provider, headings and intro say **review,
      copy, or export** and never instruct the organizer to press send. Add a
      dedicated copy-selected action with an accessible success/failure status.
      Configured-provider pages retain send-specific wording and controls.
    - **Proof:** render both provider states and assert mutually exclusive copy;
      exercise the browser helper with selected messages and assert copied text,
      status announcement, and no network send request.

11. **Use organizer language for the end-of-year transition (F11).**

    - **Lives in:** `packages/web/src/views/season-lifecycle.ts` and
      `packages/web/test/season-lifecycle.test.ts`.
    - **Expected behavior:** present the archived target as **Close and archive
      season** while keeping `archived` as the canonical state detail. Preserve
      the existing stopped-actions explanation, held-slot warning, version
      guard, irreversible confirmation, and forward-only transition.
    - **Proof:** assert the organizer-facing label and all existing safety copy,
      and assert completion still persists `archived` and removes further
      transitions.

## Later

- **Participant self-service status, correction, and withdrawal.** The core
  change-request model already exists, but issuing participant credentials and
  public routes is larger than honest receipt guidance. Likely homes:
  `packages/core/src/change-requests.ts`, a new public web route/view, and both
  core and web change-request tests.
- **Separate organizer-only notes from match logistics.** Item 3 can make the
  current sharing honest. A later schema change can give hosts and performers
  distinct Organizer-only notes and Shared-with-match logistics fields rather
  than asking one text box to serve both audiences.
- **Structured performer gear needs and lendable inventory.** Replace the
  boolean/generic-notes workaround with itemized needed and offered gear, then
  carry those values into matching and messages. This requires schema/domain,
  form, import, matching, outbox, and migration work across `packages/core` and
  `packages/web`.
- **Non-URL performer references.** Decide whether social handles should become
  a separate private/public field. Keep the current precise HTTP(S) validation
  unless that product decision is made.
- **Human browser UAT.** Re-run all six tasks with a real organizer other than
  Damien after the fix branch. Record time, visual hierarchy, keyboard/focus,
  screen-reader clarity where available, and phone-width touch behavior; the
  Codex/curl run did not measure them.
