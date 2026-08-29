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
