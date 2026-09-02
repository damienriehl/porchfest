# PR #44 review-fix packet report

- Date: 2026-09-02
- Branch: `uat-persona-run`
- Starting head: `54c7aaa`
- Delivery state: all 11 items implemented and targeted/static verification green; commit and two sandbox-sensitive parts of `npm test` are blocked by the current execution policy
- Push state: not pushed

## Item-by-item result

| Item | Change                                                                                                                                                                                                                                                                                   | Files                                                                                                                                                                                                                                                                 | Proving test                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | Both the server receipt preview and live progressive preview now take participant values only through fields whose canonical audience is `public`. Host space/power/rain and performer duration/amplification stay out of the public card.                                               | `packages/web/src/views/signup-view.ts`; `packages/web/assets/signup-preview.js`; `packages/web/test/signup.test.ts`                                                                                                                                                  | `signup.test.ts`; changed-surface run passed                                    |
| 2    | Bounds edits now re-check verified coordinates against the new box. Only outside verified points become `needs-review / out-of-bounds`; inside points and existing `not-found`/`refused` reasons remain unchanged. Locality-only edits and bounds removal do not invalidate coordinates. | `packages/core/src/setup.ts`; `packages/core/test/season.test.ts`                                                                                                                                                                                                     | `season.test.ts`; changed-surface run passed                                    |
| 3    | Moving a season into a year already used by another season now requires the edit form's explicit duplicate-year confirmation. The transactional check excludes the season being edited.                                                                                                  | `packages/core/src/setup.ts`; `packages/core/test/season.test.ts`; `packages/web/src/routes/admin.ts`; `packages/web/src/views/admin-shell.ts`; `packages/web/test/setup.test.ts`                                                                                     | `season.test.ts`, `setup.test.ts`; changed-surface run passed                   |
| 4    | Schedule refusals name only assignments and holds as organizer-clearable actions. Protected participant/outbox data and derived venue slots can still enforce the guard, but are no longer enumerated as blockers or presented as removable.                                             | `packages/core/src/setup.ts`; `packages/core/test/season.test.ts`; `packages/web/src/views/admin-shell.ts`; `packages/web/test/setup.test.ts`                                                                                                                         | `season.test.ts`, `setup.test.ts`; changed-surface run passed                   |
| 5    | A stale event-details save keeps attempted values in the form, shows each differing attempted/stored pair, stores only the winning edit, and uses the current version for a deliberate retry.                                                                                            | `packages/web/src/routes/admin.ts`; `packages/web/src/views/admin-shell.ts`; `packages/web/test/setup.test.ts`                                                                                                                                                        | `setup.test.ts`; changed-surface run passed                                     |
| 6    | Hono's application-level unexpected-error handler reports the error through an injectable reporter and returns a minimal no-store HTML 503 without error or stack details.                                                                                                               | `packages/web/src/app.ts`; `packages/web/test/app.test.ts`                                                                                                                                                                                                            | `app.test.ts`; changed-surface run passed                                       |
| 7    | Organizer signup URLs are live anchors only when core says signup is legal. Other configured states show copyable URL text labelled with the human and raw season state; an unconfigured base and the public-map link remain independent.                                                | `packages/web/src/routes/admin.ts`; `packages/web/src/views/admin-records.ts`; `packages/web/src/views/public-season-links.ts`; `packages/web/src/views/season-lifecycle.ts`; `packages/web/test/admin-records.test.ts`; `packages/web/test/season-lifecycle.test.ts` | `admin-records.test.ts`, `season-lifecycle.test.ts`; changed-surface run passed |
| 8    | Documented what the outbox `source_fingerprint` covers, why unused render-context changes can conservatively churn it, and exactly which message states regeneration may rewrite.                                                                                                        | `README.md`                                                                                                                                                                                                                                                           | Documentation-only; format gate passed                                          |
| 9    | Act-first equal-best detection is now per venue. Venue-first and act-first views render at most one explanation before each ranked list instead of repeating it on tied candidates.                                                                                                      | `packages/core/src/matching.ts`; `packages/core/test/matching.test.ts`; `packages/web/src/views/assign-act.ts`; `packages/web/src/views/assign-venue.ts`; `packages/web/test/assign.test.ts`                                                                          | `matching.test.ts`, `assign.test.ts`; changed-surface run passed                |
| 10   | Removed the branch-introduced, unused exports from the signup audience label/type implementation while retaining the audience tables consumed by the forms.                                                                                                                              | `packages/web/src/views/signup-view.ts`                                                                                                                                                                                                                               | Typecheck and lint passed                                                       |
| 11   | Made the branch-introduced season list/new/edit route constants module-private; repository search found no external consumer.                                                                                                                                                            | `packages/web/src/routes/admin.ts`                                                                                                                                                                                                                                    | Typecheck and lint passed                                                       |

The final changed-surface proof was:

```text
Test Files  8 passed (8)
     Tests  229 passed (229)
  Duration  12.53s
```

## Decisions and ambiguity

### Item 2: coordinate scope

The conservative re-check targets stored rows that are currently `verified`, because those are the rows a new box can make newly unpublishable. A point on an edge remains inside, matching `boundingBoxContains`. Existing non-verified rows retain their more useful rejection reason. Removing a box does not create a new out-of-bounds fact, and a locality-label-only edit supplies no geometric reason to invalidate a point. The existing published-map refusal remains in force for any locality/bounds edit.

### Item 4: actionable blockers

Assignments and holds have organizer UI actions, so the refusal names `unassign` and `release`. Participant records and outbox waves remain safety blockers but have no corresponding destructive organizer action, so the message says only that dependent data exists instead of enumerating their counts or instructing the organizer to remove or clear them. Venue slots are derived from participant/template data and are not named as a second removable blocker.

### Item 5: conflict retry

The stale form's submitted values remain the editable form values. Only differing fields appear in the conflict comparison, with `Yours` and `Stored` values. The hidden CAS token advances to the current stored version so the organizer can intentionally retry after comparing the two sets.

### Item 7: legal link states

The view calls core `isSeasonActionLegal(state, "signup")`; it does not duplicate a list of states. This keeps organizer link behavior aligned with the public signup route if lifecycle policy changes later.

### Item 8: fingerprint interpretation

This item was ambiguous. `git diff main...HEAD` contains no change under `packages/map/schemas/` and no `.sha256` pin change. The recent branch change in `b689731` adds `venue_title` to the outbox render context, and the complete canonical render context feeds `source_fingerprint`. I therefore interpreted the finding as outbox fingerprint churn and documented that cause and regeneration rule in `README.md`. No schema or integrity pin was regenerated.

### Items 10–11: selected cleanups

Repository-wide symbol searches showed that `SIGNUP_AUDIENCE_LABELS` / `SignupAudience` and `ADMIN_SEASONS_PATH` / `ADMIN_NEW_SEASON_PATH` / `ADMIN_EDIT_SEASON_PATH` had no consumer outside their defining module. Removing those unnecessary exports was the clearest branch-introduced cleanup; no runtime behavior changed.

## Required gates

Node v24.13.0 was placed first on `PATH` before every npm command. `npm rebuild` was never run.

Final successful static-gate output summary (verbatim):

```text
> porchfest@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json

> porchfest@0.1.0 lint
> eslint .

/home/damienriehl/worktrees/porchfest-uat/packages/core/src/access.ts
  244:47  warning  'stamp' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars
  275:5   warning  'stamp' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars

✖ 2 problems (0 errors, 2 warnings)

> porchfest@0.1.0 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!

> porchfest@0.1.0 check:boundaries
> node scripts/check-core-boundary.mjs

OK: core imports no adapter package
OK: web routes are registered only through the central registry
```

`npm test` could not be made green inside this sandbox. The unchanged SMTP test fixture is prohibited from opening its loopback catcher, so the command stops before reaching its later boundary and clean-room commands. The relevant output was:

```text
Error: listen EPERM: operation not permitted 127.0.0.1

Test Files  1 failed | 46 passed (47)
     Tests  18 failed | 889 passed (907)
    Errors  17 errors
  Duration  144.03s
```

Running every Vitest file except the loopback-dependent SMTP file proved the rest of the suite:

```text
Test Files  46 passed (46)
     Tests  886 passed (886)
  Duration  56.00s
```

The remaining commands after Vitest were then run individually. Both boundary self-tests and the live clean-room scan passed:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration

> porchfest@0.1.0 check:clean-room
> node scripts/clean-room-scan.mjs

OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The clean-room self-test alone stopped on the sandbox operation itself:

```text
Error: spawnSync git EPERM
  code: 'EPERM',
  syscall: 'spawnSync git',
  spawnargs: [ 'init', '--quiet' ]
```

## Repository and commit state

No dependency, lockfile, or `uat/` path changed. The worktree changes are complete but cannot be committed in the present sandbox because this linked worktree's Git index is outside the writable root:

```text
fatal: Unable to create '/home/damienriehl/Coding Projects/porchfest/.git/worktrees/porchfest-uat/index.lock': Read-only file system
```

No push was attempted. Once that Git metadata path is writable, the intended focused commit groups are:

1. `fix(web): keep signup previews public-only (review item 1)`
2. `fix(setup): recheck coordinates after bounds edits (review item 2)`
3. `fix(admin): harden event-details edits (review items 3-5)`
4. `fix(web): return 503 for unexpected route errors (review item 6)`
5. `fix(admin): label signup URLs by season state (review item 7)`
6. `docs(outbox): explain fingerprint churn (review item 8)`
7. `fix(matching): scope tie explanations per list (review item 9)`
8. `refactor(web): remove unused branch exports (review items 10-11)`
9. `docs(handoff): report PR 44 review fixes`
