# U9 venues-map schema v1.2.0 report

- Date: 2026-08-29
- Branch: `u9-map-schema-v1-2-0`
- Status: implemented, reviewed, verified, and committed locally; not pushed

## Outcome

The platform now carries the pinned `venues-map.v1` contract that U9's map route
will assert before validation. The imported schema is v1.2.0 and permits exactly
the Goal-1 producer and the platform map route as `generated_from` values. The
schema filename stays in the v1 family; its `schema_version` const is the
compatibility boundary.

The implementation is commit `2c6a1c1` (`feat(map): pin the venues-map v1.2.0
contract (U9)`). It was based on the task's stated `d4ee645` baseline. During
the commit check, `origin/main` was one commit ahead of this branch; the branch
was not rebased or otherwise widened beyond the requested baseline.

## Changes

- Added `packages/map/schemas/venues-map.v1.schema.json` with only the two
  requested changes from the supplied v1.1.0 bytes:
  `schema_version.const` is `1.2.0`, and `generated_from.const` is the ordered
  enum `porchfest/tools/render.py`, `packages/web/src/routes/map.ts`.
- Added the sha256sum-format pin
  `packages/map/schemas/venues-map.v1.sha256` with a bare filename.
- Added `packages/map/src/contract.ts` with version/provenance constants,
  document types, schema and pin paths, raw source and pin readers, and digest
  assertion. A mismatch error names both expected and received digests.
- Re-exported the contract surface from `packages/map/src/index.ts` without
  changing `VenuesMapV1` or its browser-asset consumers.
- Added `packages/map/test/contract.test.ts` with direct pin, mutation,
  draft/version/provenance, required-key, definition, and type-shape checks.
- Added `packages/map/schemas/README.md` with ownership, temporary-version, exact
  copy, re-pin, and catch-up instructions for the producer and site copies.
- Extended the existing imported-artifact block in `.prettierignore` with
  `packages/map/schemas/` so formatting cannot silently change canonical bytes.

No dependency, route wiring, lockfile change, producer-repository change, or
public-site change was made.

## Proof-first and drift evidence

Before `contract.ts` existed, the focused test ran and failed 4/4 because
`readVenuesMapSchemaSource` was not a function. After the implementation it
passed 4/4. The review fix added the fifth compile-time/runtime type fixture;
the final focused result was 1 file and 5/5 tests passing.

Reversing only the two authorized schema edits in memory reproduced the supplied
v1.1.0 SHA-256 exactly:

```text
81881306242799df1d3f5d15025b5a1ed954cdb2336e4117e54449657d2c22a9  -
```

That check confirms the imported schema differs from the supplied canonical
v1.1.0 bytes only in the version const and provenance declaration.

## Judgment calls

- Used the enum in the owner-approved order and compared the parsed schema array
  to the readonly tuple exactly, including order. A free-form string would
  discard the provenance guarantee the owner wanted to retain.
- Hashed the raw UTF-8 source string before `JSON.parse`. The loader does not
  normalize, format, or serialize the schema.
- Parsed the first sha256sum field and required exactly 64 lowercase hexadecimal
  characters. The assertion error reports `expected <pin>, received <actual>`.
- Kept `VenuesMapV1` unchanged. The new `VenuesMapDocument` has its own nested
  types because the canonical schema makes `act.note` and `link.label` optional,
  while the legacy browser shape requires them.
- Used only structural schema assertions. No JSON-Schema validator or substitute
  general validator was added.
- Kept the schema's `venues-map.v1` filename while moving its semantic version to
  1.2.0. This is an additive minor version inside the v1 contract family.
- Ignored the entire imported schema directory in Prettier as directed. The
  canonical JSON remains intentionally unlike Prettier's preferred formatting.
- Kept all documentation paths repository-relative and used only synthetic,
  redacted test values.

## Simplification and review

The required reuse, quality, and efficiency simplification lenses made no code
change. One lens suggested Node's newer one-shot hashing helper; it was not
adopted because `createHash` matches the repository's established crypto pattern
and makes the independent test calculation conventional and explicit.

Structured review run `20260829-090653-7352f5d0` completed with correctness,
testing, maintainability, API-contract, in-process adversarial, and institutional
learnings coverage. An external cross-model launch was denied before egress, so
no repository content left the machine; the adversarial lens ran locally.

Four independent review lenses found the same P1 issue: the first
`VenuesMapDocument` draft reused `VenueMapVenue[]`, which rejected schema-valid
documents that omit optional act notes or link labels. The fix added dedicated
document-side nested types and a sparse type fixture while preserving
`VenuesMapV1`. Independent validation confirmed the finding.

The testing lens also proposed a mock-based test for malformed pin-file text.
Independent validation rejected it as a coverage preference rather than a
demonstrated defect: the shipped pin format and digest are checked directly, and
mocking `node:fs` would not strengthen the required exact-byte contract. No
actionable review residual remains.

## Verification

Every required command used Node v24.13.0 and exited 0 in the final verification
run.

| Gate                                                           | Exact result                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                            | `tsc --noEmit -p tsconfig.json`; exit 0                                                                                       |
| `npm run lint`                                                 | exit 0; 0 errors and 2 warnings in unchanged `packages/core/src/access.ts` at lines 244 and 275 for unused `stamp` parameters |
| `npm run format:check`                                         | `All matched files use Prettier code style!`                                                                                  |
| `npm test`                                                     | `Test Files 39 passed (39)`; `Tests 610 passed (610)`; exit 0                                                                 |
| `cd packages/map/schemas && sha256sum -c venues-map.v1.sha256` | `venues-map.v1.schema.json: OK`                                                                                               |

`npm test` printed all six required gate lines:

```text
OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
```

The suite also printed the existing Node TLS ServerName deprecation warning from
the SMTP tests. The first sandboxed full-suite attempt failed only because the
sandbox refused the existing SMTP tests' `127.0.0.1` listener with `EPERM`; the
required suite was rerun with local-listener permission and passed. No test was
suppressed and stderr was left visible.

Final schema pin:

```text
ead84ab74207bbe615e2297fdc8f793e451294161cdd8edf889e1163e7f8f5e4  venues-map.v1.schema.json
```

The baseline was 38 files and 605 tests. The final result is 39 files and 610
tests: one new test file and five new tests.

## Findings to carry forward

### Goal-1-specific consts block general FOSS deployments

The schema still hardcodes `date: 2026-09-16`, `time: 6-8 PM`,
`city: Saint Paul`, `state: MN`, and the Saint-Anthony-Park latitude/longitude
box. A second neighborhood's otherwise-correct map cannot satisfy this contract.

Options for an owner decision include:

- make the public contract deployment-neutral and validate event values and the
  configured geographic box at runtime;
- generate and pin a deployment-specific schema from season configuration; or
- split a generic document schema from a pinned event-specific profile/overlay.

This task does not choose among them and leaves every const and bound unchanged.

### U9 still needs a JSON-Schema validation decision

This repository has no JSON-Schema validator. U9's route can assert the pinned
digest using this work, but it cannot yet validate emitted data against the
schema. An owner must file a decision on whether to add a maintained validator,
where validation runs, and how it is gated. Hand-rolling a general validator is
not an acceptable substitute.

### Local pins do not prove cross-repository parity

Each pin proves only that its adjacent schema has expected bytes. It does not
prove that the producer, platform, and site all carry the same bytes. During the
documented transition, the platform is intentionally v1.2.0 while the other two
repositories remain v1.1.0, and v1.1.0 documents fail the platform schema.

After catch-up, a future owner should decide whether a release checklist,
cross-repository parity job, or artifact publication mechanism should enforce
the three-copy invariant. A future session should also verify whether the site's
`static/data/` and `public/data/` paths are generated aliases or two physical
copies; if they are physical copies, the arrangement has four byte-bearing files
despite three ownership roles.

## Handoff state

The implementation is committed locally as `2c6a1c1`. This report is the only
file intended for a second focused handoff commit. Nothing was pushed or merged.

## Review fixes (2026-08-29)

All ten verified PR #31 review findings were addressed on top of `bc2f0a3`.
The schema JSON was not edited, its digest remains
`ead84ab74207bbe615e2297fdc8f793e451294161cdd8edf889e1163e7f8f5e4`, no
dependency was added, and `package-lock.json` was not touched.

### Numbered fixes

1. **One type hierarchy.** Moved the shared `VenueMapActSlot`, link, act, and
   venue types into `contract.ts`; made link labels and act notes optional;
   removed the three private document-side copies; changed
   `VenuesMapDocument.venues` to `VenueMapVenue[]`; and derived `VenuesMapV1`
   with `Pick<VenuesMapDocument, "venues">`. `index.ts` now has the only module
   edge and re-exports the contract. The document comment records the pending
   owner decision about the wider season, event, and schedule fields.
2. **Digest exact bytes.** `readVenuesMapSchemaSource` now reads a `Buffer` and
   decodes it separately. The exported `computeVenuesMapSchemaDigest` hashes a
   `Buffer | string`, and both the assertion and tests reuse it.
3. **Verified-once loader.** Added `loadVerifiedVenuesMapSchema`, which reads the
   schema bytes once, verifies those bytes against the pin, decodes and parses
   them, caches the `{ source, digest, schema }` result, and returns the same
   object on later calls. Schema URLs and cache state remain module-private.
4. **Pin parser hardening.** The parser now accepts upper- or lowercase hex,
   requires the first line to name exactly `venues-map.v1.schema.json` after an
   optional `*`, and reports the expected `sha256sum` format plus the quoted
   offending first line on failure.
5. **Checkout-invariant bytes.** Added root `.gitattributes` with
   `packages/map/schemas/* -text`, preventing checkout line-ending conversion
   from changing the pinned bytes.
6. **Narrow Prettier exemption.** Replaced the directory-wide ignore with
   `packages/map/schemas/*.json` and `packages/map/schemas/*.sha256`, then ran
   Prettier on the schema README; it was already formatted.
7. **Contract tests.** The test module reads schema bytes, source, and parsed JSON
   once; uses exact generated-from keys; replaces the runtime optionality
   tautology with a `satisfies VenuesMapDocument` compile-time fixture; covers a
   wrong pin filename, uppercase digest, and loader memoization; and passes the
   already-read source explicitly to the assertion. The focused suite is 7/7.
8. **Propagation README.** Removed the generated and gitignored `public/data/`
   site path, replaced the temporary-transition section with a four-step
   change-agnostic procedure, folded re-pinning into step 3, and retained one
   dated current-status sentence.
9. **Container workspace.** Added only the missing
   `COPY packages/map/package.json ./packages/map/package.json` line beside the
   other workspace manifests. `scripts/container-smoke.sh` completed and proved
   the image builds, migrates an empty volume, contains the workspaces, serves
   TLS health, and passes image/tree clean-room scans.
10. **Plan amendments.** Added the exact dated bracketed amendment after both
    stale U1 and U9 sentences without rewriting their original text.

The required standalone Node command exposed a pre-existing mismatch in
`packages/map/test/porchfest-map.test.js`: despite being described as a
`node:test` file, it had imported `test` from Vitest since before this branch.
The test cases and browser asset remain unchanged; the test now selects Vitest
under Vitest and `node:test` under the direct Node command. Both runner paths
pass (Vitest reports 84 tests for the file; direct `node --test` exits 0).

### Commits

- `c7d5976` — `fix(map): unify and verify the venues map contract`
- `4e0cab2` — `fix(map): preserve and document contract bytes`
- `5a05f4a` — `fix(container): install the map workspace manifest`
- `96831b4` — `docs(plan): amend the map contract cutover`
- `45ad6b2` — `test(map): support the node test runner`

### Verification

Every final required command used Node v24.13.0 and exited 0.

| Gate                                                           | Result                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                            | `tsc --noEmit -p tsconfig.json`; exit 0                                                                           |
| `npm run lint`                                                 | exit 0; 0 errors and the same 2 warnings in unchanged `packages/core/src/access.ts` for unused `stamp` parameters |
| `npm run format:check`                                         | `All matched files use Prettier code style!`                                                                      |
| `npm test`                                                     | `Test Files 39 passed (39)`; `Tests 612 passed (612)`; all six required `OK:` lines printed                       |
| `cd packages/map/schemas && sha256sum -c venues-map.v1.sha256` | `venues-map.v1.schema.json: OK`                                                                                   |
| `node --test packages/map/test/porchfest-map.test.js`          | exit 0                                                                                                            |
| `bash scripts/container-smoke.sh`                              | exit 0; final line `OK: container migrates an empty data volume, contains all workspaces, and serves TLS health`  |

The first sandboxed full-suite attempt could not open the existing SMTP tests'
local listener and was stopped; the complete chain was rerun with local-listener
permission and passed with stderr visible. The existing SMTP TLS ServerName
deprecation warning also printed. The container build printed existing npm audit
and install-script warnings plus host IPv4-forwarding warnings, but every smoke
assertion passed.

The simplification pass found no reuse, quality, or efficiency change worth
making. Structured review run `20260829-105723-d96ad339` returned `Ready to
merge` with no actionable findings. Its attempted external adversarial launch
was denied before egress by the environment safety reviewer, so the adversarial
lens ran locally. No required work was left undone. Nothing was pushed, rebased,
amended, or merged.

## v1.3.0 (2026-08-29)

### Outcome and changes

This pass implements all three answers from
`porchfest-2026-08-29-1558-u9-map-contract-decisions`:

- **q1:** `packages/map` now depends on Ajv 8 and `ajv-formats`. The new
  `validateVenuesMapDocument` uses draft 2020-12, loads only the digest-verified
  schema, compiles it once on first use, caches the validator, returns typed
  success documents or stable path/message errors, and applies the code-level
  minimum-version check after JSON-Schema validation.
- **q2:** `venues-map.v1.schema.json` is deployment-neutral at v1.3.0. Season,
  event, coordinate, schedule, slot, and slot-label consts/enums are now the
  requested types and general bounds. Provenance remains the unchanged
  two-value enum, and the existing required lists, definitions, and
  `additionalProperties` rules remain strict.
- **q3:** `schema_version` now accepts the v1 semantic-version pattern. The
  exported minimum is `1.1.0`, enforced by the dependency-free
  `isSupportedVenuesMapVersion` comparison.

The browser hour control now derives first-seen, distinct `slot_label` values
from the document and adds its own All option. Filtering compares the exact raw
label string. The exact-string rule also keeps a schema-valid label named
`all`, labels that differ only in surrounding whitespace, and a whitespace-only
label distinct from the internal All sentinel.

Tests cover v1.1.0 producer compatibility, deployment-neutral v1.3.0 values,
every requested rejection and failing path, one-time compilation, dynamic
two-slot labels, exact de-duplication, raw-label identity, and malformed date
format enforcement. All fixture addresses and coordinates are synthetic.

The schema README documents the v1.3.0 changes and propagation: the Goal-1
producer emits `schema_version: "1.3.0"` while retaining its deployment values;
the site copies the schema bytes to `static/data/` and re-pins; and the site's
`tools/verify-map-data.py` needs no change when it validates against that copied
schema.

### Schema digest

The schema was re-pinned from its exact bytes after the schema content edit:

```text
fe161c1a397f4174741a9dbc5a77948888a59f3d0b3ce218dca597cbe80de6a9  venues-map.v1.schema.json
```

### Dependency and lockfile delta

The approved install was run under Node v24.13.0. The final direct dependencies
in `packages/map/package.json` are `ajv@^8.20.0` and
`ajv-formats@^3.0.1`. The lockfile added entries for:

- `ajv` 8.20.0 for the map workspace and the optional `ajv-formats` peer
  resolution;
- `ajv-formats` 3.0.1;
- `json-schema-traverse` 1.0.0 under both Ajv resolutions;
- `fast-uri` 3.1.6; and
- `require-from-string` 2.0.2.

The first unversioned install resolved the repository's existing Ajv 6, which
does not provide `ajv/dist/2020`; the install was corrected with the approved
Ajv 8 major. The final dependency tree keeps ESLint's pre-existing Ajv 6 and
gives `packages/map` Ajv 8.

As anticipated in the task, npm also rewrote unrelated lockfile metadata. It
normalized `peer`, `dev`, and `optional` flags on existing entries, made the
shared `fast-deep-equal` entry non-dev, and removed an extraneous nested
`node_modules/vitest/node_modules/esbuild` block. Those npm-generated changes
were reported rather than hand-edited.

### Simplification and review

The required reuse, quality, and efficiency simplification pass made three
small improvements: first-seen labels use a `Set`, the test fixture's default
slot-label mapping is shared, and the minimum version components are computed
once. It also found and fixed a collision between the All sentinel and a valid
payload label named `all`.

Structured review run `20260829-122934-903b0111` covered correctness, testing,
maintainability, API contract, security, and local adversarial lenses. It found
one behavioral defect: display normalization was also changing filter identity,
so contract-valid labels that differed only by whitespace collapsed together.
Independent validation confirmed the finding. The implementation now keeps raw
identity for de-duplication and comparison and sanitizes only display text. The
review also prompted the malformed-date negative test. Focused verification was
2 files and 97 tests passing, plus lint with no errors.

The external cross-model launch was denied before egress, so no repository code
left the machine; the required adversarial pass and independent validation ran
locally. Security review noted informational deployment concerns for a future
route: callers remain responsible for request-size/rate limits, and published
asset size determines browser work. Route integration is intentionally a later
unit and was not widened into this task.

### Commits before this report

- `612d2a4` — `feat(map): validate deployment-neutral map contracts`
- `b204d7b` — `feat(map): derive hour filters from map payload`
- `17362b5` — `fix(map): keep payload label all filterable`
- `412cbc2` — `fix(map): preserve raw slot label identity`

### Verification

The exact required chain used Node v24.13.0 and exited 0:

```text
npm run typecheck && npm run lint && npm run format:check && npm test
(cd packages/map/schemas && sha256sum -c venues-map.v1.sha256)
```

Its exact result summary was:

```text
> tsc --noEmit -p tsconfig.json

> eslint .
0 errors, 2 warnings
packages/core/src/access.ts:244:47  'stamp' is defined but never used
packages/core/src/access.ts:275:5   'stamp' is defined but never used

> prettier --check .
All matched files use Prettier code style!

Test Files  41 passed (41)
Tests  692 passed (692)

OK: core boundary self-test refuses adapter imports
OK: route boundary self-test refuses direct registration
OK: core imports no adapter package
OK: web routes are registered only through the central registry
OK: clean-room self-test refuses participant-data artifacts and content
OK: clean-room scan found no participant-data artifacts in working tree (including ignored paths) and Git history
venues-map.v1.schema.json: OK
```

The suite printed the existing Node TLS ServerName deprecation warning from the
SMTP tests. An earlier sandboxed run could not open those tests' local listener;
the authoritative chain above ran with local-listener permission and passed
without suppressing any test or stderr.

The task's stated baseline of 39 files was stale for commit `68e5b4b`: that
commit contains 40 test files. This pass adds `validate.test.ts`, so the final
41-file result is expected. No required implementation or verification remains.

### Handoff state

All implementation changes are committed locally on `u9d-schema-v1-3-0`.
This appended report is intended for one final focused documentation commit.
Nothing was pushed, merged, rebased, or amended.

### Review fixes (2026-08-29)

All ten requested review fixes are complete:

1. Acts now accept optional `slot_start` and `slot_end` values in JSON Schema
   `time` format. Hour filtering keeps exact-label matching and additionally
   matches overlapping act and chip intervals; interval-free data retains the
   exact-label fallback. Regression coverage restores the full-evening fan-out
   expectation `[true, false, true, true]` for the early chip. The final review
   also aligned the browser parser with schema-valid `+HH`, `+HHMM`, and
   `+HH:MM` offsets.
2. `schedule`, `slot`, and `slot_label` now use
   `^\\S(.*\\S)?$`. Parameterized validation tests reject both `" "` and
   `" afternoon-1 "` for every field.
3. The root manifest pins Ajv 8 as the `$ajv` override target and applies
   `"overrides": { "ajv-formats": { "ajv": "$ajv" } }`. The prescribed
   Node v24.13.0 workspace install removed both nested Ajv 8 copies and hoisted
   one shared Ajv 8 instance. The lockfile records the new root dependency,
   hoisted Ajv 8 and `json-schema-traverse` 1, nested ESLint Ajv 6 trees, and
   removal of the former map and `ajv-formats` Ajv 8 entries. A `formatMinimum`
   date test now compiles and validates through `addFormats(ajv)` without
   throwing. No `npm rebuild` was run.
4. Both hour and genre facets now share one object sentinel that cannot equal a
   payload string. A payload genre named `all` receives its own functional chip.
5. Hour chips sort directly by `slot_start` when available, including when
   `slot_end` is absent and when the first venue has only the later slot. Labels
   without start metadata use numeric `localeCompare`.
6. `packages/map/README.md` now describes deployment-neutral slot strings,
   optional intervals, the Ajv runtime dependencies, and validator usage.
7. `venuesMapVersionPattern` is exported, and the contract test asserts the
   schema pattern equals its `.source`.
8. `isSupportedVenuesMapVersion` now uses `Number` components and an explicit
   three-part comparison without BigInt or unreachable fallbacks.
9. `VenueMapActSlot` remains the public `string` alias and now documents that it
   has been deployment-defined and unconstrained since v1.3.0.
10. `packages/map/test/fixtures.ts` provides the shared
    `makeVenuesMapDocument(overrides)` fixture used by both `contract.test.ts`
    and `validate.test.ts`; the removed hand-built documents contained only
    synthetic data, and the replacement remains clean-room safe.

The schema was re-pinned after its final content edit:

```text
9e6a796eb652bbbe43ff15b728b67bde6103e28eb987e63d9a54154e42ed8834  venues-map.v1.schema.json
```

The final `npm ls ajv` output is:

```text
porchfest@0.1.0 /home/damienriehl/worktrees/porchfest-map-schema
├─┬ @porchfest/map@0.1.0 -> ./packages/map
│ ├─┬ ajv-formats@3.0.1
│ │ └── ajv@8.20.0 deduped
│ └── ajv@8.20.0 deduped
├── ajv@8.20.0
└─┬ eslint@9.39.5
  ├─┬ @eslint/eslintrc@3.3.6
  │ └── ajv@6.15.0
  └── ajv@6.15.0
```

The authoritative Node v24.13.0 verification passed against the final tree with
41 test files and 703 tests, all six required `OK:` lines, and
`venues-map.v1.schema.json: OK`.
Lint retained only the two pre-existing unused-`stamp` warnings in
`packages/core/src/access.ts`. The sandboxed test attempt could not bind the
SMTP fixtures to `127.0.0.1`; the approved local-listener rerun passed. The
initial registry-restricted install retry also required approved network access.
The final review follow-up added one browser test, bringing that focused file to
90 passing tests. Cross-model review was unavailable because the required private
source egress was not authorized, so the local reviewer roster supplied the
review receipt. Nothing requested was left undone, and nothing was pushed,
rebased, amended, or merged.
