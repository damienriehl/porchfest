# Venues map schema

`venues-map.v1.schema.json` is the versioned JSON Schema contract for public
Porchfest map data. Its companion `venues-map.v1.sha256` pins the schema's exact
bytes. Producers and consumers must assert that digest before they validate a
map document, so an unexpected contract edit cannot silently change what either
side accepts.

## Copies and ownership

The contract is carried in three places:

- The Goal-1 producer owns the contract at
  `porchfest/schemas/venues-map.v1.schema.json` and its `.sha256` companion.
  Contract changes begin there.
- This platform imports the producer's contract at
  `packages/map/schemas/venues-map.v1.schema.json` and pins it beside the file.
- The `sapporchfest-site` consumer carries verbatim copies under `static/data/`
  so the public map can validate the data it receives.

These are deliberately copies rather than three authorities. Their schema bytes
and pins must agree after a coordinated contract change.

## Propagating a contract change

The v1.3.0 contract makes deployment-specific event, coordinate, schedule, and
slot values typed fields instead of Goal-1 constants. It also accepts any
syntactically valid v1 schema version while the platform validator enforces a
minimum supported version of v1.1.0 in code. The two-value `generated_from`
enum is unchanged. Review fixes add optional RFC 3339 `time` values
`slot_start` and `slot_end` to each act so consumers can determine interval
overlap without interpreting deployment-specific labels. `schedule`, `slot`,
and `slot_label` remain deployment-defined non-empty strings but now reject
surrounding whitespace. The platform publication gate also requires a valid
empty-venues document, so the top-level `venues` array permits zero items while
each published venue's `acts` array remains non-empty. This clarification
changes the pinned digest without changing the v1.3.0 shape or version.

1. Update the Goal-1 producer at `porchfest/tools/render.py` to emit
   `schema_version: "1.3.0"`. It may keep emitting its season, date, time, city,
   state, coordinate-box, and slot constants as document values.
2. Copy the owner-approved schema byte-for-byte to this platform. Do not parse
   and re-serialize it: formatting is part of the digest.
3. Copy the same schema bytes to the site's matching `static/data/` path and
   re-pin each copy in the directory that contains it, using its bare filename.
   From this repository's root, the platform command is:

   ```bash
   (cd packages/map/schemas && sha256sum venues-map.v1.schema.json > venues-map.v1.sha256)
   ```

4. Run the producer, platform, and site digest assertions and contract checks
   before cutover. The site's `tools/verify-map-data.py` needs no change if it
   validates against the copied schema.

The schema JSON and digest pin are listed in `.prettierignore` on purpose.
Prettier would change the imported canonical bytes and therefore its digest;
changes should remain directly diffable against the producer's source of record.

The v1.3.0 validator, deployment-neutral contract, and code-enforced minimum
record the owner decisions from ask stem
`porchfest-2026-08-29-1558-u9-map-contract-decisions`, qids `q1`, `q2`, and
`q3`. The unchanged provenance enum came from ask stem
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`, qid
`q2-map-schema-generated-from`.

## Browser asset catch-up

The platform mount reads its JSON endpoint from the map script tag's
`data-map-url` attribute, then from `window.PORCHFEST_MAP_DATA_URL`, with the
site's existing `/data/venues-2026.json` literal retained as the fallback. When
the platform and site copies next converge, copy this small configuration seam
and the deployment-neutral empty-state wording with the rest of the asset.
Copy the empty top-level `venues` clarification and its updated digest to the
producer and site contract copies in the same coordinated catch-up.
