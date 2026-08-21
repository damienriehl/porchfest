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
highlighted state, while non-matches collapse to a small performer peek instead
of disappearing. Venue cards are sorted south to north initially, with a control
to reverse the order. A card's **Show on map** control navigates to its matching
pin and opens the popup. Venue bands have three visual states: neutral,
filter-match, and collapsed non-match.

## License

MIT, consistent with the repository `LICENSE`.
