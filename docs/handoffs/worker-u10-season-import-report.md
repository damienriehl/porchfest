# U10 Goal-1 season import report

Date: 2026-08-29

Branch: `u10-season-import`

Status: implemented, verified, and committed locally; not pushed or merged

## Outcome

U10 now imports the 2026 Goal-1 artifacts through a one-way, transactional,
idempotent core workflow. The importer creates the season, signup records,
placeholder records, supersession graph, approved slate, hold, supplied geocodes,
and organizer annotations without making a network request. A second run finds
the imported records without changing record versions.

The command-line entry point supports an explicit artifact directory or
`PORCHFEST_GOAL1_ARTIFACTS`, an optional data directory, a rollback-only dry run,
and caller-supplied locality bounds. It rejects a missing directory or any missing
required artifact before opening the application database.

CI exercises the same importer against a generated synthetic corpus with the real
artifact shape and structural counts. The generated data contains invented names,
addresses, prose, and in-box coordinates; every email uses `example.invalid`.

## Files changed

- `packages/core/src/import/goal1.ts`
- `packages/core/src/import-keys.ts`
- `packages/core/src/annotations.ts`
- `packages/core/src/geocoding.ts`
- `packages/core/src/records.ts`
- `packages/core/src/season.ts`
- `packages/core/src/storage/schema.ts`
- `packages/core/src/index.ts`
- `packages/core/drizzle/0016_right_microbe.sql`
- `packages/core/drizzle/meta/0016_snapshot.json`
- `packages/core/drizzle/meta/_journal.json`
- `packages/core/test/import.test.ts`
- `packages/core/test/import-cli.test.ts`
- `packages/core/test/schema.test.ts`
- `packages/core/test/fixtures/season-synthetic/**`
- `scripts/import-goal1.ts`
- `scripts/clean-room-scan.mjs`
- `scripts/clean-room-scan.test.mjs`
- `docs/import-2026.md`
- `package.json`
- `docs/handoffs/worker-u10-season-import-report.md`

`behavior_changed`: `true`

Implementation commits before this report:

- `4d061db` — `feat(import): add the Goal-1 season importer`
- `30b50a6` — `test(import): prove synthetic season fidelity`

## Judgement calls and mappings

- Natural keys use the new `import_keys` table rather than deterministic record
  IDs. The unique `(season_id, source, natural_key)` tuple names the source row
  while the stored record type and ID point at the ordinary Porchfest record.
  This preserves normal database identities and gives re-runs an indexed lookup.
- The importer retains superseded submissions as physical rows and calls the core
  supersession APIs for venues, acts, and contacts. Resolving either side therefore
  reaches the canonical identity while keeping historical source records intact.
- A source `same_as` slot becomes a second physical assignment for the same
  canonical act in the immediately adjacent slot. The core API accepts this only
  when the caller identifies the adjacent source assignment; its general
  one-assignment-per-act rule remains unchanged.
- The act-side hold resolves its placeholder venue, decide-by instant, and fallback
  venue before writing. A missing fallback produces a warning and skips the hold
  instead of creating a weakened hold with a null fallback.
- Virtual records use the ordinary placeholder APIs. Reach-via references resolve
  through the imported contact graph. Manual contacts are ordinary contact rows;
  sources that identify a prior-season tab receive a provenance annotation. A
  withdrawn virtual venue is created first and then withdrawn so lifecycle history
  is preserved.
- `listen` and `websites` are tokenized for HTTP(S) URLs, de-duplicated, and stored
  in the newline-delimited links format already validated by the signup path.
  Useful non-URL residue goes to notes, while pure placeholders are dropped.
- Performer overrides are applied only when their declared original value still
  matches the imported record. Act/contact updates use normal versioned writes,
  and every applied reason is stored as an annotation. Existing selection-detail
  notes are retained when an override also changes notes.
- Known gear, drink, amenity, amplification, and lending tokens map onto existing
  enums. Unknown or mixed free text is retained in notes rather than discarded.
- Supplied geocodes pass through the same season-bounds and cross-check gate used
  by live geocoding. Imported source labels are translated to the narrow provider
  provenance enum. In-box entries become `geocoded`; out-of-box entries become
  `needs-review` with `out-of-bounds`. No lookup is performed.
- The schema has no general relationship for an artifact's additional intended
  recipient. The importer still creates the referenced contact and records that
  relationship as a venue annotation. Likewise, secondary host-contact details
  that do not have a first-class signup field remain in private notes.
- Organizer prose is stored through an idempotent annotation writer. Import report
  counts distinguish annotations created on this run from annotations found on a
  re-run, including prose attached to already-found records.
- Report fidelity counts use resolved canonical venue IDs and approved act entries.
  Raw tables are intentionally larger because source submissions, placeholders,
  and per-slot continuation assignments remain as auditable records.

## Tests added or changed

`packages/core/test/import.test.ts` names tests after the U10 plan scenarios and
covers:

- R23 structural counts, unmatched/floating records, and approved assignments;
- R23 idempotent row counts and a complete record-version snapshot;
- R26 reach-via resolution for all six placeholder acts;
- R27 supersession resolution in both directions;
- R25/R26 hold shape and clock-pinned release behavior;
- rollback when a late import failure follows many successful writes;
- R22 clean-room email domains and deterministic fixture bytes;
- R23 basis, chase, email-note, withdrawal, continuation, and recipient annotations;
- R29 geocode provenance and out-of-bounds review status;
- override validation/reasons and messy link extraction/residue handling;
- warnings and hold omission when a fallback natural key cannot resolve.

The migration/schema test now checks migration `0016`, its snapshot, the
`import_keys` uniqueness contract, and annotation/import lookup indexes. CLI tests
cover missing inputs, normal import, rollback-only dry-run, and transactional
rollback after a late failure.

## Review findings resolved

The implementation review found and fixed seven behavioral issues before final
verification: dated withdrawal objects were not recognized; `same_as` entries
were annotations rather than occupied slots; unresolved fallbacks could create a
null-fallback hold; a link override could replace existing selection-detail notes;
mixed known/free-text selections could lose the unknown text; slate venue counts
used uncanonicalized array length; and re-runs undercounted found annotations.

Additional regression coverage proves late-failure atomicity and preservation of
slot email notes. A proposed source-file split was not applied because the
independent validator found no repository size rule or behavioral defect requiring
it.

## Verification commands and results

All commands used Node 24.13.0 through the required PATH prefix.

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0 with the two pre-existing unused-argument warnings in
  `packages/core/src/access.ts` at lines 244 and 275; 0 errors.
- `npm run format:check`: exit 0; all matched files use Prettier style.
- `npm test`: exit 0; 47 files passed and 816 tests passed. It printed all six
  required success lines:
  - `OK: core boundary self-test refuses adapter imports`
  - `OK: route boundary self-test refuses direct registration`
  - `OK: core imports no adapter package`
  - `OK: web routes are registered only through the central registry`
  - `OK: clean-room self-test refuses participant-data artifacts and content`
  - `OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history`
- `npm run check:boundaries`: exit 0; both core and route boundary checks passed.
- `git diff --check`: exit 0.

The first sandboxed full-test attempt could not bind the existing SMTP tests to
loopback (`listen EPERM`). Re-running the same full sequence with loopback access
completed successfully in 32.42 seconds. No test timeout or source change was used
to bypass that environmental restriction.

## Fidelity and clean-room notes

The real-artifact fidelity command was deliberately not run. No real artifact
value was written to this repository, a report, a test fixture, or a commit
message. `docs/import-2026.md` documents the exact local-only dry-run command and
the plan's expected numeric gate.

No dependency was added, `package-lock.json` was not changed, and no rebuild was
run. The commits remain local on `u10-season-import`; nothing was pushed or merged.

## Known limitations and work not done

- The imported additional-recipient relationship remains an annotation until the
  domain has a first-class recipient edge.
- Secondary host-contact detail remains private notes because the signup schema has
  no dedicated secondary-contact fields.
- The external cross-model review route was not used because its privacy escalation
  was not approved. The same adversarial lens was run locally, and its validated
  findings were resolved.
