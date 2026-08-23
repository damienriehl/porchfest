---
module: packages/map
date: 2026-08-23
problem_type: convention
component: testing_framework
severity: high
related_components:
  - browser_module
  - test_fixtures
tags:
  - hand-rolled-fake
  - test-harness
  - swallowed-exception
  - vacuous-assertion
  - false-negative
  - dom-semantics
applies_when: "A suite substitutes a hand-rolled fake for a real API -- a fake DOM, a fake fetch, a fake storage or clock -- and the code under test may call a method the fake never implemented, or pass an argument the real API would reject."
related:
  - "docs/solutions/logic-errors/css-important-discards-the-geometry-a-js-library-writes-inline.md"
  - "docs/solutions/logic-errors/wall-clock-input-needs-an-owning-timezone.md"
  - "sapporchfest-site: tools/test-porchfest-map.js"
---

# One missing method in a fake fails as fifteen unrelated tests, and leniency in a fake fails as none

## Context

This happened in the `sapporchfest-site` repo, whose `tools/test-porchfest-map.js` is
the sibling of `packages/map/test/porchfest-map.test.js` — the same suite, ported.

The suite ships its own fake DOM (`class TestNode`) rather than jsdom. It implemented
`appendChild`. It never implemented `insertBefore`.

Then a commit moved the map's filter controls so they sit between the map and the
venue list (`static/js/porchfest-map.js:466`):

```js
listSection.parentNode.insertBefore(controls, listSection);
```

The suite went from **81 pass / 0 fail to 66 pass / 15 fail in that single commit**.

The call threw `TypeError: listSection.parentNode.insertBefore is not a function`. The
module's own `init()` ends in a `.catch()` that turns any throw into the generic
"The interactive map could not be loaded" error state
(`static/js/porchfest-map.js:753-758`), so the throw was swallowed on the spot and the
controls were simply never constructed.

The 15 failures presented as **six apparently unrelated areas**: layout relayout
scheduling, resize debouncing, hour filters, genre chips, sorting, and accessibility.
Nine were null dereferences of a control lookup; six were layout tests seeing a module
that had bailed before `watchVenueLayout` ever ran. Nothing in any failure message
mentioned `insertBefore`, the harness, or the fake.

Adding `insertBefore` alone fixed all six layout failures without touching anything
else. **Root cause was one missing method, not fifteen problems.**

## Why the harness was never a suspect

Three properties lined up, and each is general:

1. **A fake fails where it is called, not where it is defined.** The gap was in
   `TestNode`; the symptom was a genre chip test.
2. **A catch-all in the code under test converts a harness fault into a product
   symptom.** `init()`'s `.catch()` is correct for production — a visitor should see an
   error state, not a blank page — and it is exactly what erased the diagnosis. The
   test saw the module's honest failure mode and had no way to tell it apart from a
   real one.
3. **The failure count was proportional to the surface, not to the cause.** Fifteen
   failures reads as a broken commit. It was one absent method, and the count only
   measured how much of the page hung off the controls.

## The leniency measurement

This is the part worth remembering, because it says something a failure count cannot.

The **first** version of the fake silently appended when `reference` was non-null but
not a child of the node — where a real browser throws `NotFoundError`. That is not a
hypothetical divergence: pointing the module at such a reference breaks the real page
completely, rendering nothing but the error state.

With the lenient fake, that mutation left **82 of 84 tests passing**. Nine of them
cheerfully asserted button labels, `aria-pressed` state, and click-driven relayouts on
a control tree **no visitor would ever see**.

After making the fake throw `NotFoundError` instead, the same mutation fails **15**
tests.

> A total production failure showed up as a two-test failure. Leniency in a fake does
> not lose a little precision; it converts the loudest possible defect into noise.

The generalization: **the value of a fake is capped by its strictness.** A fake that
accepts input the real thing rejects has silently widened the contract every test in
the suite is written against, and every one of those tests now certifies behaviour that
cannot occur.

## The second-order finding: an assertion that had gone vacuous

While repairing the suite, one assertion turned out to be asserting nothing — and it
had never failed.

It located the status element by comparing its index against the controls' index inside
the full-bleed block:

```js
// roughly, before:
assert.equal(
  fullbleed.children.indexOf(status),
  fullbleed.children.indexOf(
    fullbleed.querySelector(".porchfest-map-controls"),
  ) + 1,
);
```

Once the controls moved out of that block, the `querySelector` returned `null`,
`indexOf(null)` returned `-1`, and `-1 + 1` **coincidentally equalled the status
index of 0**. The assertion passed while checking nothing.

Generalize it: **`indexOf` returns `-1` for a node that is not there, and `-1` is a
perfectly good number.** Any arithmetic on it (`+ 1`, `- 1`) or any ordering comparison
(`<`) degrades to a silent pass rather than a failure. The fix is to pin the index to a
real value before relating anything to it
(`tools/test-porchfest-map.js:1189-1193, 1634-1638`):

```js
// Pin the map block's index first: indexOf returns -1 when it is not a direct child.
assert.equal(mountOrder.indexOf(run.nodes.fullbleed), 0);
assert.equal(
  mountOrder.indexOf(run.nodes.fullbleed) < mountOrder.indexOf(controls),
  true,
);
assert.equal(
  mountOrder.indexOf(controls),
  mountOrder.indexOf(run.nodes.listSection) - 1,
);
```

## What fixed it

Site commits `2cf6664` (restore the suite), `675d4d4` (define `appendChild` as the
reference-less `insertBefore`), and `2b58dff` (make the fake reject what a browser
rejects). The fake now has one insertion path, validates before mutating, and follows
the DOM pre-insert algorithm (`tools/test-porchfest-map.js:94-129`):

```js
appendChild(child) {
  return this.insertBefore(child, null);
}

insertBefore(child, reference) {
  const referenceIndex = reference == null ? -1 : this.children.indexOf(reference);
  if (reference != null && referenceIndex === -1) {
    throw new Error('NotFoundError: reference is not a child of this node');
  }
  // "If referenceChild is node, set referenceChild to node's next sibling."
  // Without this, inserting a node before itself relocates it to the end.
  const target = reference === child ? this.children[referenceIndex + 1] || null : reference;
  ...
}
```

Three structural choices, each doing work:

- **One insertion path.** `appendChild` is the reference-less case of `insertBefore`,
  so the two can no longer drift apart or be independently forgotten.
- **Validate before mutating.** The `NotFoundError` throw is what restored the 15-test
  signal above; without it the fake produces a plausible tree from an insertion the
  browser refuses.
- **A self-test for the fake itself** (`tools/test-porchfest-map.js:911-955`, _"insertBefore
  matches real DOM semantics for the fake node tree"_), pinning ordering, null-reference
  append, move-not-duplicate, reparenting, self-reference, rejected reference, and
  fragment-before-reference. Its opening comment states why it must exist: _"A gap here
  does not surface as a harness failure: the module calls insertBefore inside init(),
  whose catch turns any throw into the generic error state."_

## What to do next time

- **A hand-rolled fake must mirror the real API or fail loudly at the seam.** Implement
  the method, or make the absence self-announcing — a throwing stub, or a `Proxy` that
  raises `TestNode has no <method>` on any unimplemented property. Either way the
  failure names the harness instead of scattering into product tests.
- **Match strictness, not just behaviour.** Where the real API throws, the fake throws.
  A permissive fake is worse than a missing one: the missing one fails, the permissive
  one certifies.
- **When N failures appear in one commit across unrelated areas, suspect one shared
  dependency first.** Six subject areas failing together is a shape, and it points at
  the harness, the fixture, or the setup path — not at six regressions.
- **A catch-all in the code under test needs a harness that can see through it.** If
  `init()` swallows every throw, the suite should assert the happy path reaches its
  normal state (not the error state), so a swallowed harness fault fails on its own
  terms.
- **Never do arithmetic or ordering on a raw `indexOf`.** Pin the index to a real value
  first, or assert the node was found at all. `-1` is silent.
- **Both copies of the fake now carry it, and that was deliberate.**
  `packages/map/test/porchfest-map.test.js` ports the same fake. When it was still
  behind, its `TestNode` implemented only `appendChild` and the platform module still
  placed the controls with `fullbleed.appendChild(controls)` — the trap was armed and
  waiting for whoever ported the filter move. It has since been ported together with
  the fake's `insertBefore`, its self-test, and the hardened assertions, in one change,
  and the two suites now carry the same 84 test names. Keep it that way: porting a
  production change into a copy without porting the fake that models it is exactly how
  fifteen unexplained failures get manufactured. The two test-name lists are the
  cheapest drift detector these copies have.
