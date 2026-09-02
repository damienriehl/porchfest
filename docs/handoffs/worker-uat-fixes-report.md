# Organizer UAT fixes worker report

- Date: 2026-08-30
- Branch: `uat-persona-run`
- Starting result commit: `eb9b199`
- Delivery state: implemented, reviewed, committed locally, not pushed or merged

## Outcome

All eleven items under **Fix in this branch** in `uat/fix-packet.md` are implemented. The protected ignored `uat/` directory and the existing test instance were not modified or stopped. No dependency or lockfile changed.

| Item | Commit    | Result and proving coverage                                                                                                                                           |
| ---- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `6da8daa` | Atomic first-season creation, first-run-only setup, seasons list, explicit additional-season flow, duplicate-year confirmation, stale/two-tab/auth/Origin/CSRF tests. |
| 2    | `f9f31e9` | Versioned event-details editor, setup validation reuse, dependency refusals, coordinate re-review, published-map refusal, full readback and stale-write tests.        |
| 3    | `75eb26f` | Canonical three-audience field contract across forms and receipts; actual match-message and public-map output assertions.                                             |
| 4    | `b689731` | Match notifications use current porch title/address and neutral amplification grammar; rename/regeneration proof.                                                     |
| 5    | `de8b522` | Absolute organizer-facing signup URLs derive only from `PUBLIC_BASE_URL`; request Host cannot influence them.                                                         |
| 6    | `15330f1` | Legal open-season choices show date, locality, and human state; archived seasons are excluded; one legal season skips the picker.                                     |
| 7    | `a0873f1` | Non-secret host/performer receipt references and honest no-self-service guidance, with conditional public-site linking and secret/PII exclusions.                     |
| 8    | `7c20399` | Public `/` landing page with host, performer, and usable organizer access, covered for zero/one/multiple open seasons and signed-in/out organizers.                   |
| 9    | `1aa1113` | Equal best-score candidates receive the required explanation in both matching views without changing rank order.                                                      |
| 10   | `19505df` | Provider-disabled outbox uses review/copy/export language and clipboard-only selected-message copy without an HTTP mutation.                                          |
| 11   | `a3f9659` | Organizer-first **Close and archive the season** label with internal `archived` state secondary; lifecycle safeguards preserved.                                      |

Post-item integration work is committed separately:

- `c47c0cd` — shared redirect, timezone-date, season-label, and ranked-suggestion helpers plus stronger view types.
- `9d3f4f9` — validated review fixes and regressions: conflict-before-validation ordering, stale first-run ordering, corrected audience classifications, retryable season-creation failures, bounds-only/core-legality coverage, and clipboard in-flight protection.

## Decisions

### Item 1: first-run setup

`/admin/setup` is strictly first-run-only. Once any season exists, GET redirects to `/admin/seasons`; the page lists current seasons and offers **Open another season** at `/admin/seasons/new`. The additional-season command is distinct from editing and requires explicit confirmation for a duplicate year. Core performs the empty check and insert in one immediate transaction, so route preflight is not the race guard.

### Item 2: event details and dependent data

The editor is a server-rendered GET/POST flow with CSRF, Origin, core legality, and season-version CAS. Core rejects a stale version before validation or dependency checks, preventing stale submitted values from acquiring the winner's version token. The final SQL version predicate remains as the write guard.

Date, timezone, or slot changes are refused while participant records, venue slots, holds, assignments, or outbox data exist, with the blockers named. Locality or bounds changes re-flag coordinates as `needs-review` / `address-changed`; changes are refused while the public map is published. Bounds-only behavior now has independent regression coverage.

### Item 6: public season selection

The route asks core `isSeasonActionLegal` which seasons can accept signup; it does not reproduce season-state rules. Archived seasons are therefore never offered. With exactly one legal season the route goes directly to its form. Multiple choices show display name, formatted event date, locality, and organizer-facing state. The selected form repeats that context, and the performer form shows slots plus setup/teardown-buffer guidance.

### Item 3 review correction

The widest actual audience determines the label. Venue title/address and the documented act fields remain **Public map**. Host logistics and performer amplification are **Shared with a confirmed match** because match notifications contain them. Performer duration and planning fields are **Organizer-only**. The integration test now checks the generated match message and serialized public map, rather than allowing forms and receipts to agree on the same wrong table.

## Review

The required structured review completed with correctness, testing, maintainability, security, performance, API-contract, reliability, adversarial, frontend-race, and repository-learning lenses. The managed security policy denied the proposed external cross-model egress before a job started, so no code left the machine; the adversarial lens ran locally instead.

The independent validator confirmed four primary findings. All were applied in `9d3f4f9`; three lower-severity, concrete follow-ups were applied in the same commit. Focused post-fix verification passed 5 files / 172 tests. Review run: `20260830-100316-81fa4151` (temporary artifacts; the durable conclusions are recorded here).

One informational residual remains: the editor presents six slot controls while core can represent more. No supported production or import case with more than six templates was established, so the review did not recommend widening this packet.

## Verification

Node v24.13.0 was used. The exact commands ran in a detached snapshot at `9d3f4f9` because the live ignored `uat/` data is protected and intentionally absent from a clean verification tree.

```text
npm run typecheck       exit 0
npm run lint            exit 0 (0 errors; 2 pre-existing unused-stamp warnings)
npm run format:check    exit 0
npm test                exit 0
Test Files              47 passed (47)
Tests                   894 passed (894)
npm run check:boundaries exit 0
```

The six `OK:` lines emitted by `npm test` were:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The separately required boundary command also emitted both boundary `OK:` lines and exited 0.

Mutation proof ran only in the detached temporary snapshot. Removing both event-detail version enforcement gates (the early stale-conflict check and final SQL version predicate) made the named stale-write test fail with `expected function to throw an error, but it didn't`. The real branch retained both gates. Mutating both is the stronger current proof because the early check was added to ensure stale validation/dependency refusals take the conflict path before the final SQL CAS.

## Deferred from the packet's Later section

- Participant self-service status/correction/withdrawal remains later because it requires participant credentials and public routes beyond honest receipt guidance.
- Separate organizer-only notes and match-logistics fields remain later because they require a schema/domain split; this branch makes current sharing explicit.
- Structured performer gear needs and lendable inventory remain later because they require schema, forms, import, matching, outbox, and migration work.
- Non-URL performer references remain later pending the product decision; precise HTTP(S) validation is unchanged.
- Human browser UAT remains later because automated route/render tests do not measure real-person timing, visual hierarchy, keyboard/focus, screen-reader clarity, or phone-width touch behavior.

## Repository state

The branch contains one commit for each packet item, followed by focused simplification and review-fix commits. This report is the only remaining handoff artifact to commit. Nothing has been pushed or merged.
