# Importing the 2026 Goal-1 season

The Goal-1 import is an operator-only, one-way migration into Porchfest. It reads
three artifacts without copying them into this repository and never calls a
geocoder or any other network service.

## Prerequisites

- Use Node 24. The installed `better-sqlite3` binary is built for that runtime.
- Keep the Goal-1 checkout outside this repository.
- Confirm the artifact directory contains `out/submissions.json`,
  `private/matches-2026.json`, `private/geocache.json`, and (unless `--bounds`
  is supplied) `tools/geocode.py`.
- Point `PORCHFEST_DATA_DIR` or `--data-dir` at the deployment data directory.
  The command creates `porchfest.db` there when it does not exist.

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.0/bin:$PATH"
export PORCHFEST_GOAL1_ARTIFACTS="/path/to/goal1/porchfest"
export PORCHFEST_DATA_DIR="/path/to/porchfest-data"
```

There is deliberately no artifact-directory default inside the repository. The
`--artifacts` flag overrides `PORCHFEST_GOAL1_ARTIFACTS`.

## Dry-run first

Run the complete import inside a rolled-back SQLite transaction:

```bash
npm run import:goal1 -- --dry-run --event-year 2026
```

The command prints the same JSON `ImportReport` as a real run. `records` splits
each record type into `created`, `found`, and `skipped`; the report also lists
supersessions, holds, every geocache hit or miss, annotation totals, and warnings.
The database file and migrations may be created, but the dry-run leaves no season
rows behind.

If the Goal-1 geocoder source is unavailable, supply the season box explicitly as
`south,west,north,east` and optionally name the locality:

```bash
npm run import:goal1 -- --dry-run \
  --event-year 2026 \
  --bounds "44.0,-94.0,46.0,-92.0" \
  --locality "Imported season locality"
```

Those example coordinates and the locality label are illustrative, not season
data.

## Local-only fidelity gate

The real-artifact gate is never a CI test. With the environment above and a
disposable data directory outside the repository, run exactly:

```bash
npm run import:goal1 -- --dry-run --event-year 2026
```

The real artifact's display date omits its year, so the fidelity run requires
`--event-year 2026` (or `PORCHFEST_GOAL1_EVENT_YEAR=2026`). The importer never
infers that year from the current date or host timezone.

The plan's expected fidelity summary is:

- `summary.slateVenues`: 22
- `summary.approvedActEntries`: 26
- host supersessions: 2
- performer supersessions: 1
- placeholder acts: 6
- placeholder venues: 2
- holds: 1
- geocache hits: 22

The raw physical-row counts are intentionally larger than 22/26: superseded
submissions remain as rows so both identities resolve to the canonical record,
placeholder rows remain as history, and an approved act that continues into the
next adjacent slot has one assignment row per occupied slot. Do not delete those
rows to make the raw table totals resemble the fidelity summary.

If any fidelity number differs, stop before the real import. Regenerate and
validate the Goal-1 artifacts, inspect the report's warnings and skipped counts,
and reconcile the artifact with the hand-approved slate. A changed real-world
slate should update the documented expectation deliberately; it should not be
silently accepted by the importer.

## Import and idempotence

After the dry-run matches the approved slate:

```bash
npm run import:goal1 -- --event-year 2026
```

The importer stores every Goal-1 natural key in `import_keys`. Re-running the
same command is safe: existing rows report as `found`, nothing reports as newly
created, and record versions do not move. Keep the second report as the operator
proof of idempotence.

## Organizer annotations

Goal-1 prose appears as ordinary organizer annotations, readable through the
same core annotation reader used by admin surfaces. Prefixes make the source
legible: `Basis:`, `Chase:`, `Email note:`, `Address check:`, `Override`, and
`Contact sourced from 2025`. Virtual-record and supersession notes are preserved
there too. A withdrawn virtual venue is retained with withdrawn status and a
withdrawal annotation, so its history remains inspectable. Where the source
names an additional recipient but the current schema has no recipient edge, the
importer creates the contact and records the intended recipient on the venue as
an annotation. These annotations are private organizer data and never enter the
public map payload.

## Retention

Imported contacts and their annotations are not exempt historical material.
They fall under R35 exactly like native signups: the deployment's configured
retention window, organizer anonymization, deletion receipts, and off-host
backup rotation all apply.
