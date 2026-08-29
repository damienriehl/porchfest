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

As of 2026-08-29, the producer and site copies are at v1.1.0.

1. Begin the coordinated change in the producer's schema and update the producer
   to emit the matching contract version and shape.
2. Copy the owner-approved schema byte-for-byte to this platform and the site's
   matching `static/data/` path. Do not parse and re-serialize it: formatting is
   part of the digest.
3. Re-pin every copied schema in the directory that contains it, using its bare
   filename. From this repository's root, the platform command is:

   ```bash
   (cd packages/map/schemas && sha256sum venues-map.v1.schema.json > venues-map.v1.sha256)
   ```

4. Run the producer, platform, and site digest assertions and contract checks
   before cutover.

The schema JSON and digest pin are listed in `.prettierignore` on purpose.
Prettier would change the imported canonical bytes and therefore its digest;
changes should remain directly diffable against the producer's source of record.

The v1.2.0 provenance widening records the owner decision from ask stem
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`, qid
`q2-map-schema-generated-from`.
