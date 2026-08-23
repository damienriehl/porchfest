---
module: packages/web
date: 2026-08-23
problem_type: logic_error
component: input_validation
severity: high
related_components:
  - data_model
  - scheduling
tags:
  - timezone
  - datetime-local
  - silent-failure
  - test-coverage-gap
  - round-trip-illusion
applies_when: "Accepting a date and time from an HTML datetime-local control, or any other input that carries a wall clock with no offset, and persisting it as an instant."
related:
  - "docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md"
---

# A wall clock is not an instant, and a round-trip test cannot tell you so

## Context

U4's performer signup form collects availability windows with
`<input type="datetime-local">`. That control submits `2027-09-11T14:00` — a wall
clock with **no offset at all**. The route parsed it like this:

```ts
const date = new Date(`${value}:00.000Z`);
```

Appending `Z` declares the value to be UTC. It is not: it is whatever the person
typing it was looking at on their own wall. In Saint Anthony Park that is Central
time, so a performer who typed 2:00 PM had `2027-09-11T14:00:00Z` persisted, which
renders back as **9:00 AM Central**. Every availability window was five hours early,
and availability is what U6 matching and U7 scheduling both read.

## Why the tests were green

This is the part worth remembering. The round-trip test looked thorough — it submitted
a real form, read the real SQLite file, and asserted the stored epochs:

```ts
expect(rows).toEqual([{ startsAt: 1_938_088_800, endsAt: 1_938_091_500 }]);
```

Those numbers were **computed from the same wrong assumption the code makes**. The
test and the code agreed with each other, and neither agreed with reality. A
round-trip assertion only proves the value survived the trip; it says nothing about
whether the trip was to the right place. Encoding the expected value by running the
code under test and pasting the output makes the test a mirror, not a check.

The tell: the expected value is a magic number nobody can verify by reading it. Had
the assertion been written as `"2031-06-01T19:00:00.000Z"` next to a comment naming
the zone, the bug would have been visible in review.

## What fixed it

The domain already had the answer. R34 says a season carries a timezone, so the
question was never "which zone does the server run in" — a container runs UTC, and
guessing a locality would be worse. `seasons.timezone` (migration `0004`, default
`UTC`) makes the season the owner of the clock, and `packages/core/src/time.ts`
resolves the wall clock through it.

Converting a zoned wall clock to an instant needs no dependency. The offset of a zone
depends on the instant, and the instant is what you are solving for, so guess UTC and
correct twice with `Intl.DateTimeFormat().formatToParts()`. Two passes settle every
real zone, both DST edges included.

The replacement tests assert readable instants and cover January and July separately,
because a single hardcoded offset is right for half the year and wrong for the other
half.

## What to do next time

- **Never append `Z` to a value that did not come with an offset.** If the input has
  no zone, find the entity that owns the clock — a season, a venue, an event — and make
  it explicit. A default of `UTC` is honest; a guessed locality is not.
- **Write the expected instant as an ISO string, not an epoch integer.** If a reviewer
  cannot check the expectation by reading it, the test cannot catch a shared assumption.
- **Test two dates six months apart** whenever a zone is involved.
- **Mutation-test it.** Restore the `Z` and confirm named tests fail. They do:
  three of them, by name.
