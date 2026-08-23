---
module: packages/map
date: 2026-08-23
problem_type: logic_error
component: map_markers
severity: high
related_components:
  - browser_module
  - vendor_integration
tags:
  - css-cascade
  - important
  - leaflet
  - inline-style
  - silent-failure
  - cross-file-defect
applies_when: "Writing CSS for a class that a JavaScript library also positions, sizes, or transforms -- Leaflet icons and panes, popper/tooltip libraries, drag handles, chart layers -- where the library expresses its geometry as an inline style."
related:
  - "docs/solutions/conventions/a-hand-rolled-fake-must-mirror-the-real-api-or-fail-loudly.md"
  - "docs/solutions/conventions/mutation-testing-for-silent-guard-failures.md"
---

# An `!important` declaration outranks an inline style, so it silently deletes the geometry a library writes there

## Context

Every venue pin on the map sat about a block southeast of its porch when the map was
zoomed out, and looked roughly right when zoomed in. Both halves of the code were
correct.

The module builds its marker as a Leaflet `divIcon` and declares where the icon's tip
is (`packages/map/assets/porchfest-map.js:601-607`):

```js
return L.divIcon({
  className: "porchfest-marker-shell",
  html: pin,
  iconSize: [44, 44],
  iconAnchor: [22, 40],
  popupAnchor: [0, -38],
});
```

Leaflet implements `iconAnchor` as an **inline style** on the icon element. From the
vendored `leaflet.js`:

```js
o && ((t.style.marginLeft = -o.x + "px"), (t.style.marginTop = -o.y + "px"));
```

And the stylesheet targeting that exact class carried, at
`packages/map/assets/porchfest-map.css:187` (and the identical rule in the
`sapporchfest-site` repo's `static/css/style.css`):

```css
.porchfest-marker-shell {
  position: relative;
  width: 44px !important;
  height: 44px !important;
  margin: 0 !important; /* <- this line */
  border: 0;
  background: transparent;
}
```

In the cascade, an author inline style beats an author stylesheet rule — but **not an
`!important` one**. `margin: 0 !important` therefore won, the computed margins stayed
`0px`, and Leaflet's `-22px / -40px` was discarded. With no anchor offset, the icon's
**top-left corner** — not its tip — was placed on the venue's coordinate.

The declared anchor was not wrong. Under the stylesheet's global `box-sizing:
border-box`, the pin is a 30x30 box at `top: 4px; left: 7px` rotated `-45deg`
(`porchfest-map.css:198-205`), so its visual tip computes to **(22, 40.21)**. The
`iconAnchor: [22, 40]` matched the artwork to a fifth of a pixel. It was simply thrown
away.

**Measured in Chrome DevTools on the live page, all 20 markers:**

|        | computed margin | inline style                            | pin tip vs. projected layer point |
| ------ | --------------- | --------------------------------------- | --------------------------------- |
| before | `0px / 0px`     | `margin-left: -22px; margin-top: -40px` | 22px east, 40.2px south           |
| after  | `-22px / -40px` | unchanged                               | 0px east, 0.2px south             |

The residual 0.2px is the rotated square's tip falling at y=40.21 against a declared
anchor of 40 — i.e. the artwork, not the bug.

Because the error is a fixed **pixel** offset, its geographic size scales with zoom:

| zoom | ground error    |
| ---- | --------------- |
| 19   | 9.6 m / 32 ft   |
| 17   | 38.6 m / 127 ft |
| 15   | 154 m / 506 ft  |
| 14   | 308 m / 1012 ft |

That is the whole reported symptom — "off when zoomed out, closer when zoomed in" —
and it is why whoever last checked the map up close saw nothing wrong. At max zoom the
defect is indistinguishable from ordinary rendering imprecision.

## Why nothing caught it

**The CSS is correct in isolation and the JS is correct in isolation.** Read
`createMarkerIcon()` and the anchor is right. Read the marker rule and `margin: 0
!important` is an unremarkable reset on a library-owned element. Neither file mentions
the other, no test read both, and no reviewer had reason to hold the two open at once.
The defect existed only in the **cascade between them** — a place neither file
describes.

Two things made it durable:

- **The offset never announced itself.** Nothing threw, nothing logged, no marker went
  missing. A pin that is 22px southeast still lands on the map, still opens the right
  popup, still lists the right acts.
- **It was verified at the zoom level where it is invisible.** 9.6 m at zoom 19 reads
  as "close enough"; the same defect is 308 m at zoom 14.

And the declaration bought nothing. The stylesheet's global reset already sets
`margin: 0` for every element, so the rule was redundant in every respect **except**
the `!important` that broke the anchor.

## What fixed it

Delete the declaration — site commit `86ab172`, platform PR #5 merged as `82a6030` —
and leave the reasoning where the code used to be, because the next person to add a
reset here will be reading this file, not Leaflet's source
(`packages/map/assets/porchfest-map.css:187-196`):

```css
.porchfest-marker-shell {
  /* Nothing here may be !important. Leaflet drives this element's geometry with
     inline styles derived from iconSize and iconAnchor, and an !important
     declaration outranks an inline one -- that is how an !important margin came
     to discard the anchor and put every pin 22px east and 40px south of its
     true coordinate. The 44px below is the touch-target floor, not an override. */
  position: relative;
  width: 44px;
  height: 44px;
  border: 0;
  background: transparent;
}
```

A comment cannot fail, so the rule is also pinned by a test
(`packages/map/test/porchfest-map.test.js:2110-2120`). It reads the stylesheet, strips
comments — otherwise the explanatory comment above would itself match a `margin
... !important` pattern — and asserts no !important survives on the rule at all:

```js
const rule = stylesheetSource.match(/\.porchfest-marker-shell\s*\{([^}]*)\}/);
const declarations = rule && rule[1].replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(rule, "expected a .porchfest-marker-shell rule");
assert.doesNotMatch(declarations, /!important/);
```

Verified by mutation: reintroducing `margin: 0 !important` into the rule fails this
test by name, and removing it again returns the suite to green.

## What to do next time

- **Never `!important` a property that a library writes inline on the same element.**
  The `!important` is precisely the thing that reaches past the library's own output.
  If the value needs to be forced, the library's option is the place to set it —
  `iconAnchor`, `iconSize` — not the stylesheet.
- **For Leaflet specifically, the library owns these:** `margin-left` / `margin-top`
  (from `iconAnchor`), `width` / `height` (from `iconSize`), and `transform` /
  `position` / `left` / `top` on panes and layer elements.
- **The same flag was still on `width` and `height`, and came off too.** Removing
  only the `margin` left `width: 44px !important; height: 44px !important` in place,
  one `iconSize` change away from the identical defect, since Leaflet derives the
  inline width and height from `iconSize` in the same expression that derives the
  margins from `iconAnchor`. They were harmless only because 44px happened to match
  `iconSize: [44, 44]`. The `44px` stayed -- it is the touch-target floor an
  accessibility test pins -- and only the flags were dropped; verified in the browser
  that the shell still computes and renders 44x44 with every pin on its coordinate.
  The guard test was widened from `margin` to any `!important`, because `margin` was
  merely the property that bit first.
- **Before adding a reset, check whether it changes anything.** This one did not — the
  global reset already set `margin: 0`. A redundant declaration whose only real effect
  is its `!important` is pure downside.
- **Verify map geometry zoomed out, not zoomed in.** A constant pixel error is smallest
  where you naturally inspect it. Pick the widest zoom the page can reach and compare a
  pin against a landmark whose position you know independently.
- **When a defect lives between two files, the fix belongs in both.** A deletion leaves
  no trace of why; the comment carries the reason and the test carries the enforcement.
