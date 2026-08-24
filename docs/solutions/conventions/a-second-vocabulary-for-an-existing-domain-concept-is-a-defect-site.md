---
module: packages/geo
date: 2026-08-23
problem_type: convention
component: input_validation
severity: high
related_components:
  - data_model
  - map_markers
tags:
  - bounding-box
  - duplicate-vocabulary
  - domain-model
  - coordinate-validation
  - wiring-seam
  - zero-area-box
  - single-source-of-truth
applies_when: "Defining a new type, DTO, or validation gate for a domain concept another module already owns and validates -- especially at a wiring seam where the two shapes must translate, such as coordinate bounds, dates, money, or identifiers."
related:
  - "docs/solutions/logic-errors/css-important-discards-the-geometry-a-js-library-writes-inline.md"
  - "docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md"
  - "docs/solutions/logic-errors/wall-clock-input-needs-an-owning-timezone.md"
---

# A second name for a concept the schema already names is duplication, even when there is no function to call

## Context

`packages/geo/src/verify.ts` (PR #15, merged as `e4ad380`) is the gate that decides
whether a geocoded point is trustworthy enough to publish on the public venue map. Its
R17 neighborhood check needs a bounding box, so the module defined one:

```ts
// as first written
export interface BoundingBox {
  readonly minLatitude: number;
  readonly maxLatitude: number;
  readonly minLongitude: number;
  readonly maxLongitude: number;
}
```

`core` already owned that concept, in the two places that are the durable evidence of
what this project calls the thing:

- **The boundary validator.** `createSeasonSetup` accepts `bounds.north / south / east /
west` (`packages/core/src/setup.ts:43-48`) and validates the four numbers at
  `packages/core/src/setup.ts:255-286`.
- **The persisted columns.** They land as `bounds_north`, `bounds_south`, `bounds_east`,
  `bounds_west` (`packages/core/src/storage/schema.ts:95-98`, added by migration
  `packages/core/drizzle/0007_past_klaw.sql:20`).

A deployment's actual box comes from season setup. So the parallel shape would have
forced a `north` → `maxLatitude` translation at the wiring seam — four hand-written field
mappings between the row that stores the neighborhood and the gate that enforces it. A
slip there silently displaces every pin, which is precisely the failure this gate exists
to catch. **The module invented a second name for the very quantity whose misreading it
was built to prevent.**

The module was not even isolated from core's vocabulary. `packages/geo/package.json`
already declares `"@porchfest/core": "*"`, and `packages/geo/src/verify.ts:1` already
imports `Coordinates` from it (`packages/core/src/ports/geo.ts:5`). The file spoke core's
language for the two-number concept on line 1 and invented its own for the four-number
one on line 36.

### They also disagreed on a real case

`core` rejects a degenerate zero-area box. Both comparisons are `<=`:

```ts
// packages/core/src/setup.ts:270-285
if (bounds.north > 90 || bounds.south < -90 || bounds.north <= bounds.south) {
  throw new SeasonSetupError(
    "bounds.north",
    "The north edge must be above the south edge.",
  );
}
if (bounds.east > 180 || bounds.west < -180 || bounds.east <= bounds.west) {
  throw new SeasonSetupError(
    "bounds.east",
    "The east edge must be right of the west edge.",
  );
}
```

The new validator used `min > max`. That accepts `min === max`. Two validators for one
concept, differing on whether a zero-area box is legal: `core` refuses the season outright,
`geo` would have taken the box and then admitted only the points on a single line.

### How it was nearly missed

A code-reuse reviewer **did** notice the parallel validation logic in `setup.ts`, and
explicitly dismissed it as _"coincidental parallel logic, not duplication."_

Its reasoning was locally correct on all three counts:

1. **Different field names.** `north/south/east/west` against
   `minLatitude/maxLatitude/minLongitude/maxLongitude` — no textual overlap to match on.
2. **No named symbol.** Core's bounds validation is an unexported inline block inside
   `createSeasonSetup`, and core has no name for the shape either: `setup.ts:172` refers
   to it as `SeasonSetupInput["bounds"]`, and `packages/core/src/index.ts:80-87` exports
   `SeasonSetupInput`, `SeasonSetupError`, `SeasonSetupRepository`, `SeasonSetupResult`,
   and `TimeSlotInput` — no bounds type among them.
3. **A different error contract.** `SeasonSetupError` with a field path and a
   human-facing message (`setup.ts:275-279`) against a `RangeError` thrown from a pure
   function.

There was genuinely no shared _function_ to call, and extracting one would have been the
wrong fix: the two error contracts differ for good reasons — one is talking to an
organizer filling in a form, the other to a deployment that misconfigured itself.

But the duplication was of the **concept and its vocabulary**, not of code. Reuse review
hunts for callable symbols; a vocabulary collision has none, so it slips through a review
that is working exactly as designed. That is the transferable insight, and it is why this
one nearly shipped.

## Guidance

**Before defining a type for a domain concept, grep for the concept's existing
vocabulary.** Not for a function to reuse — for the _words_ the project already uses. In
order of durability:

1. **Persisted column names.** These are the strongest evidence of what a project calls a
   thing, because they survive refactors that rename types: a column rename costs a
   migration, so the name outlives every type that ever mapped to it.
2. **The validator at the boundary** where the concept enters the system.
3. **Exported types**, last — a concept can be fully owned by a codebase without ever
   having been given a type name, which is exactly the case here.

**When two validators exist for one concept, they must agree on every case, degenerate
ones included.** Enumerate the degenerate cases explicitly and check them one at a time:
zero-area, inverted, a single point, wrapped. A disagreement about a case neither
validator's happy path exercises is invisible until a deployment hits it.

**Align vocabulary and rules; do not force a shared helper.** The fix here renamed the
geo type to core's `north/south/east/west` and matched core's strict zero-area rule — on
the geo side only. `core` was left untouched: it owns the concept, and another session had
files open nearby. The result is the interface at `packages/geo/src/verify.ts:36-41`, with
the reason recorded where the next person will read it (`verify.ts:24-35`):

```ts
/**
 * The neighborhood sanity box (R17). Named for core's season bounds, which is
 * where a deployment's box comes from -- `bounds.north` in `createSeasonSetup`,
 * persisted as `bounds_north` and friends. A second vocabulary for the same
 * four numbers would put a north-to-maxLatitude translation at the wiring seam,
 * and a slip there displaces every pin, which is the failure this gate exists
 * to catch.
 * ...
 */
export interface BoundingBox {
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
}
```

and the matching comparison at `packages/geo/src/verify.ts:395-401`:

```ts
// Strict, matching createSeasonSetup: a zero-area box would admit only points
// on a single line, so it is always a misconfiguration rather than a filter.
if (box.north <= box.south || box.east <= box.west) {
  throw new RangeError(
    "A bounding box needs north above south and east above west; it may not wrap the antimeridian.",
  );
}
```

**Name the test after the other validator, so the link is findable from either side.**
`packages/geo/test/verify.test.ts:222` is `"refuses a zero-area bounding box, as
createSeasonSetup does"`. A grep for `createSeasonSetup` from the core side now reaches
the geo test that pins the agreement, which no comment inside `geo` would have done.

**"There is no shared helper to call" is not the same as "there is no duplication."** When
a reviewer dismisses parallel logic on the grounds that the names differ and there is no
common symbol, that phrasing is the tell, not the all-clear: it describes a vocabulary
fork rather than ruling one out.

## Why This Matters

**A translation at the seam is an unreviewable coin flip, four times over.** `geo` consumes
what `core` persists. With parallel names, wiring the gate means writing `north →
maxLatitude`, `south → minLatitude`, `west → minLongitude`, `east → maxLongitude` by hand.
Each of those is locally plausible in either direction, and a reader of the seam has
nothing to check it against — the two sides use disjoint words, so a swapped pair reads as
fine. Swap `north` and `south` and every pin moves. That is the same class of defect as
`docs/solutions/logic-errors/css-important-discards-the-geometry-a-js-library-writes-inline.md`,
where a correct CSS file and a correct JS file combined into a 300-metre displacement:
neither side is wrong, the defect lives in the join. A gate that requires an error-prone
translation to invoke has spent part of the guarantee it exists to provide.

**Two validators that disagree on a degenerate case are worse than either alone.** Under
the original `min > max`, a season whose bounds `core` refused outright could still produce
a box `geo` accepted. `boundingBoxContains` would then admit only the points on a single
line of latitude or longitude, and every real venue would be rejected with code
`out-of-bounds` (`verify.ts:79`) — a rejection that names the venue's coordinate as the
problem when the deployment's configuration is. The disagreement converts a loud
misconfiguration into a quiet, mislabeled mass rejection.

**Reuse review is symbol-shaped, and so is the tooling around it.** Duplicate-code
detectors, "extract this helper" review passes, and dependency graphs all key on callable
things. A concept that exists as four field names in a schema and an inline `if` in a
validator is invisible to all of them. The only instrument that finds it is a grep for the
vocabulary, run _before_ the second name exists — after that, the two names no longer
match each other and the grep returns nothing.

## When to Apply

- **Before adding any type whose fields map onto persisted columns.** A DTO, a validated
  input shape, a view model. Grep the schema first.
- **When a new package consumes data another package owns.** `geo` depended on `core`
  already; the dependency edge is the signal that the vocabulary is inherited, not free.
- **Whenever a second validator for an existing concept appears.** Two is the number at
  which agreement must be asserted, not assumed — and the degenerate cases are where they
  will differ.
- **When a reviewer dismisses parallel logic as coincidental.** Re-ask the question in
  vocabulary terms: _does this codebase already have words for these numbers?_ That is a
  different question from _is there a function to share?_, and only the second one has been
  answered.

Do **not** read this as a mandate to extract a shared helper. Where the error contracts
genuinely differ, one function serving both callers is worse than two. The unit being
deduplicated is the **name and the rule**, not the code.

## Examples

**The grep that would have caught it**, run at `origin/main`:

```
$ git grep -nE "bounds_(north|south|east|west)|boundsNorth" origin/main -- packages/core/src
origin/main:packages/core/src/setup.ts:102:        boundsNorth: validated.bounds?.north ?? null,
origin/main:packages/core/src/storage/schema.ts:95:    boundsNorth: real("bounds_north"),
origin/main:packages/core/src/storage/schema.ts:96:    boundsSouth: real("bounds_south"),
origin/main:packages/core/src/storage/schema.ts:97:    boundsEast: real("bounds_east"),
origin/main:packages/core/src/storage/schema.ts:98:    boundsWest: real("bounds_west"),
```

Five lines, one command, before a single field of the new interface was typed.

**The vocabulary fork is now closed**, and the only surviving trace of the old name is the
comment that explains why it is gone:

```
$ git grep -nE "(min|max)(Latitude|Longitude)" origin/main -- packages/
origin/main:packages/geo/src/verify.ts:28: * four numbers would put a north-to-maxLatitude translation at the wiring seam,
```

**The agreement is pinned by a test** (`packages/geo/test/verify.test.ts:222-235`), which
states the other validator by name in both the title and the comment:

```ts
it("refuses a zero-area bounding box, as createSeasonSetup does", () => {
  // core rejects north <= south and east <= west when a season's bounds are
  // set. A box that admits only a single line of points is a misconfiguration
  // either way, and the two validators must not disagree about it.
  expect(() =>
    boundingBoxContains({ ...NEIGHBORHOOD, north: NEIGHBORHOOD.south }, INSIDE),
  ).toThrow(RangeError);
  expect(() =>
    boundingBoxContains({ ...NEIGHBORHOOD, east: NEIGHBORHOOD.west }, INSIDE),
  ).toThrow(RangeError);
});
```

**Proof that the alignment mattered.** Seven mutations were run against `verify.ts`,
following the mutate/run/restore discipline established in
`docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md`. Swapping
`north` for `south` in the containment check (`verify.ts:145-150`) produced the largest
signal of any of them:

| Mutation                                              | Tests red |
| ----------------------------------------------------- | --------- |
| **swap `north` for `south` in the containment check** | **7**     |
| bounding box always contains                          | 4         |
| accept street-level precision                         | 3         |
| interpolation refusal disabled                        | 2         |
| R29 precedence disabled                               | 1         |
| drop the cross-check requirement                      | 1         |
| loosen the zero-area rule to `<`                      | 1         |

The ordering is the argument. A north/south confusion is the single most consequential
thing that can go wrong in this file — seven tests against four for the next-largest mutation —
and it is exactly the confusion a `north` → `maxLatitude` translation at the wiring seam
would have invited on every call. The alignment removes the translation, so the seam has
no place left to make that mistake.

The suite is 37 tests in `packages/geo/test/verify.test.ts` — 33 `it()` calls plus one
`it.each` covering four structural cases (`verify.test.ts:277-291`) — with the
bounding-box gate carrying six of them (`verify.test.ts:163-251`).
