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

## Review-fix commits

- Items 1–2 → `7e80aba` (`fix(geocoding): preserve verified import boundaries`)
- Item 3 → `0ec1026` (`fix(import): preserve invalid coordinate idempotence`)
- Items 4–5 → `993213a` (`fix(import): fail closed on geocache ambiguity`)
- Item 6 → `2212702` (`fix(import): honor timezone hold deadlines`)
- Item 7 → `b0d74f5` (`fix(import): parse event dates deterministically`)
- Item 8 → `5a2c004` (`fix(import): refresh superseded record caches`)
- Items 9–10 → `c7db1c5` (`fix(import): stabilize review annotations`)
- Item 11 → `5442cd7` (`fix(import): resolve forward continuation slots`)
- Item 12 → `1169e47` (`feat(assignments): mark continuation slots`)
- Item 13 → `5f47f91` (`fix(import): parse content answers conservatively`)
- Item 14 → `47c9bbd` (`fix(clean-room): remove fixture scanner exceptions`)
  and `23c844f` (`chore(format): preserve generated fixture bytes`)

Item 14 uses `synthetic.submissions.json`, `slate.synthetic.json`, and
`synthetic.geocache.json`. This differs from the requested suffix-first names
because `main`'s unchanged private-filename patterns still match
`submissions.synthetic.json` and `geocache.synthetic.json`; the prefix-first
names produce zero current-tree findings without an allowlist. The scanner
itself now matches `origin/main` exactly, and its self-test explicitly scans the
repository fixture directory.

The functional suite passes 47 files and 833 tests. Typecheck, lint (0 errors;
the same two pre-existing warnings), format check, boundary checks, the
clean-room self-test, and a current-tree clean-room scan all exit 0. The required
full `npm test` reaches and passes the first five `OK:` gates, then fails only in
the final history scan: commits `30b50a6` through `5f47f91` still contain the old
synthetic fixture paths. Making the sixth `OK:` line pass while using `main`'s
unmodified history scanner and no allowlist requires rewriting those ancestor
commits. No rewrite was performed because this assignment expressly forbids
rebase, amend, and squash.

### Post-review audit commits

A fresh local review of the completed diff found several consumers that still
assumed one assignment per act, plus three import-boundary gaps. Those findings
were resolved in the following focused commits:

- `c8432d9` (`fix(assignments): honor continuation families`) makes withdrawal
  deletion continuation-safe, rejects act corrections that would split a
  continuation family, includes every continuation in performer outbox text,
  and checks every linked-act assignment for overlap.
- `1c37385` (`fix(geocoding): reject invalid imported distances`) fails closed
  for negative or non-finite imported cross-check distances.
- `7c415b5` (`fix(import): close atomicity and note gaps`) makes the exported
  importer own its transaction and dry-run rollback, and derives composite
  performer notes from the fully overridden row.

The review's proposed split of the new importer file was not applied. It is a
one-time migration surface, the recommendation was structural rather than a
behavioral defect, and splitting it after the behavioral review would widen this
fix-only assignment substantially without changing the shipped contract. The
external cross-model route was again unavailable because transmitting repository
context to that provider was not approved; the adversarial pass ran locally and
its actionable findings were included above.

After these commits, the exact verification chain reported 47 passing files and
842 passing tests. Typecheck, lint (0 errors and the same two pre-existing
warnings), format check, all five pre-history `OK:` gates, a separate boundary
check, the scanner self-test, and the current-tree clean-room scan exit 0. The
full `npm test` still exits 1 only at the final history scan for the immutable
ancestor paths described above; obtaining its sixth `OK:` line still requires a
forbidden history rewrite or a forbidden scanner exception.

## Fidelity shapes (U10-b)

This follow-up is implemented in `389db04` (`fix(import): match Goal-1 fidelity
shapes`). The real artifacts were not opened or imported. All fixture values and
test mutations remain invented, and all synthetic contact domains remain
`example.invalid`.

### Shape coverage and decisions

- **Virtual-performer reach-via.** `manual_contact` resolves the named manual
  contact. `host` scans venue slots for the virtual key and uses that venue's host
  contact. Timestamp-shaped host and performer lookups remain as the legacy
  fallback. An unresolved non-manual lookup emits a warning naming the virtual
  key; an available manual contact still creates the placeholder, otherwise the
  entry is skipped. The fixture has both token forms, the timestamp fallback,
  exactly two `virtual_performer` slots, and a note on one of those slots.
- **Reach-via fidelity risk.** The importer does not invent a host relationship
  for a key that no slot names. Under the supplied rule, five host tokens plus
  only two naming slots cannot produce six warning-free placeholders unless the
  remaining keys have another stated linkage. The orchestrator's read-only
  fidelity gate must confirm that linkage or reconcile the expected outcome.
- **Holds and unmatched IDs.** The slot hold path and its synthetic test remain.
  The current-artifact expectation is zero holds because that slot shape is not
  present. `id_for_fallback` on an unmatched venue remains an ID override and
  does not create a hold.
- **Geocache provenance.** The three recognized source labels map exactly to
  parcel, house, and street/interpolated evidence. Every other label is refused
  into review with a warning. Refs must use the stated letter/digits shape, even
  on cache misses. The three null-cross-check house entries stay in
  `needs-review` with `cross-check-missing`; this is review-queue evidence, not a
  warning.
- **Map addresses.** `map_address` becomes the venue address used by the map and
  geocache. A differing submitted address is retained only in venue notes with
  the `[host-form address]` prefix and in a matching organizer annotation. Tests
  cover exactly two mapped venues and successful cache matching.
- **Canceled slots.** Direct and continuation assignments are created first,
  then the core `unassignSlot` operation reopens the slot family. The canonical
  act becomes withdrawn. Dated reasons are annotated, impossible calendar dates
  roll back, `same_as` cancellation propagates in both directions, cycles fail
  explicitly, and superseded performer keys remain canonical and idempotent on
  rerun. The season-listing test proves canceled assignments are absent from the
  map-eligible listing.
- **Open slots and organizer prose.** Exactly five synthetic slots use
  `open: true` and remain unassigned. `band_check`, slot notes, and
  `extra_recipients` become venue-scoped organizer annotations. Physical and
  virtual dated withdrawals remain covered.
- **Supersessions.** Host and performer objects are read through the named
  `canonical` and `reason` fields. A property-order mutation test proves the
  importer does not interpret object values positionally.
- **Fixture and operator guide.** The deterministic generator now emits every
  requested shape in addition to the legacy hold case. `docs/import-2026.md`
  records 22 slate venues, 26 approved act entries (20 canonical plus 6
  placeholders), 2+1 supersessions, 2 placeholder venues, 0 current-artifact
  holds, 20 imported coordinates, 3 review-queue coordinates, and no expected
  warnings.

The explicit create-then-`unassignSlot` sequence was retained even though final
withdrawal also removes canonical-family assignments; it is the required audit
history transition. Assignment import keys intentionally survive deletion of
the live canceled assignment row, making reruns report the historical import
rather than recreate it.

### Review and verification

A six-lens local review covered correctness, testing, maintainability,
performance, reliability, and adversarial composition. It found and resolved
the missing virtual-slot note, warning-plus-manual fallback, canonical
cancellation rerun, venue-scoped annotation assertions, strict calendar dates,
and cache-miss provenance validation. The external peer route was blocked before
egress by privacy approval, so no repository content left the machine.

With Node 24.13.0, the exact requested chain exited 0:

- `npm run typecheck`: passed.
- `npm run lint`: passed with 0 errors and the two pre-existing unused-argument
  warnings in `packages/core/src/access.ts`.
- `npm run format:check`: passed.
- `npm test`: 47 files passed; 858 tests passed; all six required `OK:` lines
  printed, including the tree-and-history clean-room result.
- `npm run check:boundaries`: passed and printed both boundary `OK:` lines.

The fixture generator was rerun deterministically, and the focused importer/CLI
run passed 44 tests. Nothing was pushed or merged. The documentation and this
handoff are committed separately from the code and tests.

## Review-fix commits (U10-b)

The verified U10-b review decisions are implemented in the following local
commits. The real artifacts were not opened, imported, or quoted; every added
fixture value and mutation is synthetic.

- Items 1 and 7: `a4f7402` (`fix(import): preserve live bookings across
cancellation reruns`) limits cancellation to its slot family, withdraws only
  an act with no remaining canonical assignment, and recreates/rebinds an
  assignment after un-cancel.
- Item 2: `eee4868` (`fix(import): find existing placeholders before resolving
reach`) restores found-first placeholder reruns and removes the unreachable
  host-only timestamp tail. The existing timestamp fallback test remains the
  reachable fallback proof.
- Item 3: `dd61a52` (`fix(import): keep host-form addresses organizer-only`)
  moves the submitted address to an idempotent organizer annotation and proves
  rendered host and act messages contain no submitted address. `e417d37`
  (`fix(import): purge legacy host-form notes`) also removes an old reserved note
  when a later artifact no longer has `map_address`.
- Items 4 and 6: `c432fe7` (`fix(import): distinguish geocache review reasons`)
  maps missing/malformed refs to `missing-ref`, unknown providers to
  `imprecise`, and restores importer-level `out-of-bounds` coverage beside
  `cross-check-missing` with publishability assertions.
- Item 5 and the malformed-pair part of item 9: `fce109c` (`fix(import): tolerate
incomplete cancellation shapes`) makes cyclic `same_as` pairs warn-and-skip
  and accepts boolean cancellation. `cbadeca` (`fix(import): skip malformed slot
pairs`) extends that behavior to absent, non-object, and non-string pair
  targets. `6487fdc` (`test(import): cover malformed and false slot flags`)
  proves malformed pairs report once and `canceled: false` preserves the live
  assignment without annotation.
- Item 8: `b63bda2` (`fix(import): validate only matched geocache entries`)
  checks address misses before validation and warns for irrelevant malformed
  entries. Matching entries remain strictly validated.
- Item 10: `554bace` (`fix(import): match exact chase-list tokens`) tokenizes on
  whitespace and punctuation except hyphen and underscore, then requires an
  exact case-insensitive token match.
- Item 11: `c0e4654` (`refactor(core): share regular-expression escaping`)
  exports one core `escapeRegex` implementation for core matching and geo.
- Item 12 is paired with `eee4868`: the dead host-only lookup was removed rather
  than preserving a second timestamp fallback path.
- Item 13: `84d2916` (`perf(import): cache canonical acts and venue slots`) adds
  run-scoped resolution caches. `561e9c2` (`refactor(import): simplify
review-fix lookup caches`) caches canonical IDs rather than mutable records,
  loads assignments once, and indexes found host reach. `f42071a`
  (`perf(import): index assignments by slot`) makes continuation and
  cancellation lookup constant-time. `6d036a0` (`fix(import): invalidate
retargeted canonical caches`) clears canonical resolution after a corrected
  supersession and proves the later cancellation uses the new canonical act.
- Supporting tests: `210938a` (`test(import): narrow rendered wave bodies`)
  makes nullable outbox bodies explicit, and `5dc198d` (`test(import): cover
import-key rebinding contract`) directly covers missing-key creation,
  same-record no-op, changed-record rebinding, and record-type refusal.

The required simplification pass applied five findings: two repeated-query
eliminations, canonical-ID caching to avoid stale versions, shared import-key
normalization, and a compile-safe supersession branch. A fresh local review then
found the legacy-note, malformed-pair, supersession-retarget, assignment-index,
and two branch-coverage gaps above. After those fixes, correctness, testing,
adversarial, and performance confirmation passes returned no findings. The
proposed large importer/test-file split was not applied because it would widen
this focused review-fix assignment without changing behavior. The matched
malformed-geocache suggestion was not applied because the explicit decision only
makes non-matching malformed entries warn-and-skip.

### Final verification

With Node 24.13.0, the exact requested chain exited 0:

- `npm run typecheck`: passed.
- `npm run lint`: passed with 0 errors and the two pre-existing unused-argument
  warnings in `packages/core/src/access.ts` at lines 244 and 275.
- `npm run format:check`: passed.
- `npm test`: 48 files passed and 875 tests passed. It printed all six required
  `OK:` lines: the two boundary self-tests, the two boundary checks, the
  clean-room self-test, and the working-tree-plus-history clean-room scan.
- `npm run check:boundaries`: passed and printed both boundary `OK:` lines.

The first sandboxed full-test attempt could not bind the existing SMTP tests to
loopback (`listen EPERM 127.0.0.1`). Re-running the same exact chain with local
loopback access passed without changing code, test limits, or timeouts.

These 17 review-fix commits and this report commit remain local on
`u10-fidelity-shapes`. Nothing was pushed, rebased, amended, squashed, or merged.
