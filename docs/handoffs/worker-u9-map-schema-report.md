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
