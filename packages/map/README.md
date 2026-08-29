# `@porchfest/map`

`@porchfest/map` packages the browser module and styles for the interactive
Porchfest venue map. Its TypeScript entry exports the `venues-map.v1` data
contract, a runtime validator backed by `ajv` and `ajv-formats`, and absolute
paths to the browser assets. The browser module remains the UI implementation
and depends only on Leaflet at runtime.

## Venue data

The module fetches `/data/venues-2026.json`. That file follows the
`venues-map.v1` shape:

```json
{
  "venues": [
    {
      "title": "Willow Porch",
      "address": "Redacted fixture location",
      "lat": 44.98,
      "lng": -93.19,
      "schedule": "6–8 pm",
      "acts": [
        {
          "slot": "6-7",
          "slot_label": "6–7 pm",
          "slot_start": "18:00:00Z",
          "slot_end": "19:00:00Z",
          "name": "Sample Quartet",
          "genre": "Jazz",
          "description": "An upbeat neighborhood set.",
          "links": [
            {
              "label": "Artist site",
              "url": "https://artist.example"
            }
          ],
          "note": "All ages"
        }
      ]
    }
  ]
}
```

Since v1.3.0, `slot`, `slot_label`, and `schedule` accept any non-empty string
without surrounding whitespace. Optional `slot_start` and `slot_end` fields use
JSON Schema's RFC 3339 `time` format. When both are present, the browser uses
their interval to match overlapping hour chips; otherwise matching falls back
to exact `slot_label` equality. Coordinates are numbers, and `links` and `acts`
are arrays. The `schedule` field remains part of the contract, although the
current venue band does not render a separate schedule line.

## Validate venue data

The TypeScript validator verifies the pinned schema digest, applies the draft
2020-12 schema with `ajv` and `ajv-formats`, and enforces the supported v1
minimum version:

```ts
import { validateVenuesMapDocument } from "@porchfest/map";

const result = validateVenuesMapDocument(candidate);
if (!result.ok) {
  console.error(result.errors);
}
```

Install the package's runtime dependencies when consuming this entry point;
`ajv` and `ajv-formats` are not optional. Successful results contain the typed
document, while failures contain stable JSON-pointer paths and messages.

## Mount the assets

Import the exported on-disk paths in the server package and serve them at public
URLs. For example, with an Express-compatible server:

```ts
import {
  porchfestMapScriptPath,
  porchfestMapStylesheetPath,
} from "@porchfest/map";

app.get("/assets/porchfest-map.js", (_request, response) => {
  response.sendFile(porchfestMapScriptPath);
});
app.get("/assets/porchfest-map.css", (_request, response) => {
  response.sendFile(porchfestMapStylesheetPath);
});
```

Load Leaflet and its stylesheet on the page, mount the expected map markup, then
load `porchfest-map.css` and `porchfest-map.js`. The browser module needs Leaflet
on the page and has no other dependency.

## Behaviour

The interface provides hour and genre filters. Matching venues receive a
highlighted state, while non-matches collapse to a compact performer peek with a
masked fade instead of fading in place. Venue cards are sorted south to north
initially, with a control to reverse the order.

Each venue band shows the venue name and address without a schedule line. Its
**Map** button sits in the top-right corner, navigates to the matching pin, and
opens the popup. Venue bands have three visual states: neutral, filter-match,
and collapsed non-match.

On wider viewports, the module places each card in whichever lineup column is
currently shorter, avoiding dead space below short cards while preserving a
reading order that runs across the columns. Consumers must allow the module to
manage the lineup container's layout and must not apply CSS grid to it.

## Relationship to the sapporchfest.org copy

This module is a **port**, not the original. The version running in production
lives in the separate private `sapporchfest-site` repository as
`static/js/porchfest-map.js`, `static/css/style.css`, and
`tools/test-porchfest-map.js`. Both copies exist on purpose right now: the site
serves the live 2026 map today, and this package is mountable but not yet
mounted.

There is deliberately **no automated sync** between them. The two are scheduled
to converge rather than to coexist indefinitely: once the platform serves its
own map data and the site points at that endpoint, one of these copies stops
existing. Building a diff gate for a seam with a planned retirement date would
be the wrong investment, and it could not run anyway -- the site repository has
no CI, and this repository's CI cannot reach a separate private repo.

What that costs, and what to do about it: a fix in one copy does not reach the
other, and drift is silent. When you change either copy, port the change by hand
in the same session and keep the two test-name lists identical -- they are the
cheapest drift detector available. As of the last sync both suites had the same
84 test names. Two defects have already had to be fixed twice by hand; see
`docs/solutions/logic-errors/css-important-discards-the-geometry-a-js-library-writes-inline.md`
and
`docs/solutions/conventions/a-hand-rolled-fake-must-mirror-the-real-api-or-fail-loudly.md`.

The known intentional differences are the module system and tooling (this copy
is ESM on vitest and reads `../assets/`; the site copy is CommonJS on
`node:test` and reads `static/`), and the stylesheet scope (this package ships a
self-contained `porchfest-map.css`, while the site's rules live inside its full
`style.css`). Everything else should match.

## License

MIT, consistent with the repository `LICENSE`.
