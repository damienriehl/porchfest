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
  and `public/data/` so the public map can validate the data it receives.

These are deliberately copies rather than three authorities. Their schema bytes
and pins must agree after a coordinated contract change.

## Temporary v1.2.0 transition

This repository's copy is now v1.2.0, while the Goal-1 producer and
`sapporchfest-site` copies are still v1.1.0. This is a known, temporary state
during the U9 rollout. A v1.1.0 document fails this v1.2.0 schema because
`schema_version` remains a `const`; widening `generated_from` did not make schema
versions interchangeable.

To catch up the other copies:

1. Copy `packages/map/schemas/venues-map.v1.schema.json` byte-for-byte to
   `porchfest/schemas/venues-map.v1.schema.json` and to the consumer's matching
   `static/data/` and `public/data/` paths. Do not parse and re-serialize it:
   formatting is part of the digest.
2. Make `porchfest/tools/render.py` emit `schema_version: "1.2.0"`.
3. Re-pin each copied schema in the directory that contains it, using its bare
   filename:

   ```bash
   sha256sum venues-map.v1.schema.json > venues-map.v1.sha256
   ```

4. Run each producer and consumer's digest assertion and contract checks before
   treating the transition as complete.

Within this repository, regenerate the platform pin from the repository root
with:

```bash
cd packages/map/schemas && sha256sum venues-map.v1.schema.json > venues-map.v1.sha256
```

`packages/map/schemas/` is listed in `.prettierignore` on purpose. Prettier would
change the imported canonical bytes and therefore its digest; changes should
remain directly diffable against the producer's source of record.

The v1.2.0 provenance widening records the owner decision from ask stem
`porchfest-2026-08-24-0045-u9-geocoder-and-map-schema`, qid
`q2-map-schema-generated-from`.
