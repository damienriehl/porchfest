# `@porchfest/map`

`@porchfest/map` packages the dependency-free browser module and styles for the
interactive Porchfest venue map. Its TypeScript entry exports the
`venues-map.v1` data contract and absolute paths to the browser assets; the
browser module remains the implementation.

## Venue data

The module fetches `/data/venues-2026.json`. That file follows the
`venues-map.v1` shape:

```json
{
  "venues": [
    {
      "title": "Willow Porch",
      "address": "12 Example Lane",
      "lat": 44.98,
      "lng": -93.19,
      "schedule": "6–8 pm",
      "acts": [
        {
          "slot": "6-7",
          "slot_label": "6–7 pm",
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

Each act's `slot` is `"6-7"`, `"7-8"`, or `"6-8"`. All other text fields are
strings, coordinates are numbers, and `links` and `acts` are arrays.
The `schedule` field remains part of the `venues-map.v1` contract, although the
current venue band does not render a separate schedule line.

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

## License

MIT, consistent with the repository `LICENSE`.
