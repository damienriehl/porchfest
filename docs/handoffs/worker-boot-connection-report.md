Porchfest U3 boot-time database connection report

Implementation

- packages/core/src/storage/connection.ts:8-39 defines the database filename and openCoreDatabase(). It opens one better-sqlite3 handle, enables foreign keys on that handle, creates the CoreDatabase, applies committed migrations, and returns the database with an idempotent close path. Initialization failures close the handle and rethrow, so boot remains loud and fatal.
- packages/core/src/index.ts:13-31 exports the connection API and injects the CoreDatabase into createCore alongside the existing adapter ports.
- packages/web/src/composition.ts:44-80 uses the existing dataDirectory decision, opens dataDirectory/porchfest.db once during boot, gives that database to createCore, and exposes the connection close path on the runtime. A later composition failure closes the already-opened database before propagating.

Migration path

packages/core/src/storage/connection.ts:10-12 resolves ../../drizzle relative to connection.ts through import.meta.url, matching packages/core/test/support/db.ts. The runtime image copies the complete packages tree and runs packages/web/src/server.ts through tsx from /app, so the URL becomes /app/packages/core/drizzle regardless of the process working directory.

Connection proof

packages/core/test/connection.test.ts:31-55 opens a temporary file database, confirms all eight domain tables, confirms PRAGMA foreign_keys returns 1, rejects a contact whose season does not exist, closes the handle, and removes the temporary directory. The rejected insert raised SqliteError: FOREIGN KEY constraint failed with code SQLITE_CONSTRAINT_FOREIGNKEY.

Container smoke

scripts/container-smoke.sh:27-62 adds a reusable schema probe for all eight domain tables. Lines 95-108 run it against the boot database, then create a deliberately empty SQLite file and require the same probe to reject it. Running the probe directly against an empty file returned status 1 and reported: Missing migrated tables: acts, annotations, assignments, contacts, email_log, seasons, slots, venues.

Verification

npm run typecheck: pass.
npm run lint: pass.
npm test: pass — 12 test files, 135 tests, the core and route boundary self-tests, and the clean-room self-test.

Contradictions and limitations

The implementation and table set agree with the requested design. The full container smoke could not complete in this checkout because packages/core/src/storage/schema.ts and the committed migration directory currently have untracked filesystem permissions 0600 and 0700, respectively. The image correctly runs as user node and therefore stopped with EACCES while reading /app/packages/core/src/storage/schema.ts. Git records the files as ordinary 0644 content, but changing schema.ts or anything under packages/core/drizzle was explicitly outside this worker's ownership, so those modes were left untouched and the limitation is reported rather than hidden.
