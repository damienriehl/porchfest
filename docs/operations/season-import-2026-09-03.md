# 2026 season production import — 2026-09-03

This record captures the authorized production import of the 2026 season, its
verification evidence, and the E6 rain-plan correction applied immediately
afterward. The source artifacts remain machine-local and are not part of this
repository.

## Provenance and authorization

The corrected 2026 Goal-1 artifacts were lost with a deleted worktree. Recovery
was exhausted. The import artifacts were reconstructed by re-applying the
2026-08-22 correction inventory to the surviving pre-correction backup.

Under the importer at commit `ce0f450`, the reconstruction reproduced the
2026-08-30 fidelity record line-for-line. Under the current importer, it passed
the gate in `docs/import-2026.md` exactly. Some values were reconstructed rather
than recovered: some timestamps-of-day, one submitter identity, two OSM
references, and some prose. The reconstruction's machine-local changelog
enumerates those values. The owner reviewed the reconstruction and authorized
the production import on 2026-09-03.

## Pre-import gate

The local dry-run matched `docs/import-2026.md` exactly:

| Gate item               | Result                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| Slate venues            | 22                                                                                |
| Approved act entries    | 25                                                                                |
| Placeholder acts        | 6                                                                                 |
| Placeholder venues      | 2                                                                                 |
| Holds                   | 0                                                                                 |
| Supersessions           | 3: 2 venue, 1 act                                                                 |
| Imported coordinates    | 20                                                                                |
| Geocache                | 20 hits, 3 misses                                                                 |
| Coordinate review queue | Exactly 3; all `nominatim-house` / `cross-check-missing`                          |
| Reach-via warnings      | 0                                                                                 |
| Warnings                | Exactly 1: `Canonical venue has no geocache entry` for the single unmatched venue |

The physical-record report was:

| Record type | Result                |
| ----------- | --------------------- |
| Season      | 1 created             |
| Venue       | 25 created            |
| Act         | 33 created            |
| Contact     | 53 created            |
| Slot        | 50 created            |
| Assignment  | 39 created, 5 skipped |
| Coordinate  | 20 created            |
| Annotation  | 132 created           |

## Production execution and idempotence

The runtime image does not contain `scripts/import-goal1.ts`; the `Dockerfile`
copies only `scripts/organizer-link.ts` into the runtime image's `scripts/`
directory. The import therefore ran in a one-off
`docker compose run --rm --no-deps` application container. The machine-local
artifacts and `scripts/import-goal1.ts` were bind-mounted read-only, while
`PORCHFEST_DATA_DIR=/data` selected the deployment's Compose data volume.

The production dry-run matched the local gate report field-for-field. The real
run matched that production dry-run. An immediate real-run repeat reported zero
records created and every record found. This is the retained proof that the
production import obeyed the idempotence contract documented in
`docs/import-2026.md`.

## Post-import archive

The application was quiesced and the resulting archive was verified with these
counts:

| Check            | Result |
| ---------------- | -----: |
| SQLite integrity |     ok |
| Seasons          |      1 |
| Venues           |     25 |
| Acts             |     33 |
| Contacts         |     53 |
| Assignments      |     36 |
| Outbox messages  |      0 |

The 36 current assignment rows are the expected 39 created rows minus the three
canceled-then-unassigned rows. That difference is the documented importer
behavior, not lost data. The verified archive was encrypted and copied
off-site.

`deploy/archive.sh --no-restart` stops the app to take a quiesced archive and
then deliberately leaves it stopped. For an already-running deployment, use
the default restarting form:

```bash
bash deploy/archive.sh
```

If `--no-restart` is required, restart the application explicitly afterward:

```bash
docker compose up -d app
```

Using `--no-restart` here without the immediate explicit restart caused roughly
one minute of downtime.

## E6 rain-plan correction

The correction inventory's E6 item never reached the 2026-08-22 finals. The
reconstruction therefore faithfully omitted it, leaving the imported host
answer overstating rain safety. The owner authorized a forward correction after
the import.

`scripts/ops-e6-rain-backup.ts` changed venue id 9 in season 1 from
`rainBackup: true` to `rainBackup: false` and moved its record version from 1 to 2. The same transaction added an organizer annotation recording why the answer
was corrected. Re-running the correction reported `changed: false`.

The venue belongs to a supersession pair whose two rows share an address prefix.
The corrected canonical row is the row whose `canonicalVenueId` is null.

## One-off E6 operator script

`scripts/ops-e6-rain-backup.ts` is a one-off operator surface, not part of the
application. It opens the existing database and reports the selected venue's
state. Without `--apply`, it writes nothing. With `--apply`, it changes
`rainBackup` to false and adds the organizer annotation in one transaction. If
the value is already false, it reports `changed: false` and does not update the
record again, making the operation idempotent.

The script accepts:

- `--venue-id <n>` to select a venue directly;
- `--address <prefix>` to select by address prefix when no venue id is given;
- `--data-dir <dir>` to override `PORCHFEST_DATA_DIR`; and
- `--apply` to authorize the database write.

When `--venue-id` and `--address` are both supplied, the address is an assertion
against the selected row rather than a second lookup. Address matching without
a venue id ignores superseded venues and requires exactly one canonical match.

Because the runtime image does not include this script, run it from the deployed
project checkout in a one-off application container with the script
bind-mounted read-only. First inspect the row without `--apply`:

```bash
docker compose run --rm --no-deps \
  --volume ./scripts/ops-e6-rain-backup.ts:/app/scripts/ops-e6-rain-backup.ts:ro \
  --env PORCHFEST_DATA_DIR=/data \
  app node_modules/.bin/tsx scripts/ops-e6-rain-backup.ts \
  --venue-id 9
```

Confirm the season, venue id, canonical-row marker, current value, and record
version in the JSON output. An address prefix may be supplied as an additional
assertion:

```bash
docker compose run --rm --no-deps \
  --volume ./scripts/ops-e6-rain-backup.ts:/app/scripts/ops-e6-rain-backup.ts:ro \
  --env PORCHFEST_DATA_DIR=/data \
  app node_modules/.bin/tsx scripts/ops-e6-rain-backup.ts \
  --venue-id 9 --address "<expected-address-prefix>"
```

Apply only after reviewing the report-only output, then run the same apply
command once more to prove it reports `changed: false`:

```bash
docker compose run --rm --no-deps \
  --volume ./scripts/ops-e6-rain-backup.ts:/app/scripts/ops-e6-rain-backup.ts:ro \
  --env PORCHFEST_DATA_DIR=/data \
  app node_modules/.bin/tsx scripts/ops-e6-rain-backup.ts \
  --venue-id 9 --apply
```
