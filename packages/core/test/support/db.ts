import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../../src/storage/schema.js";

export async function openTestDatabase(prefix: string) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  const sqlite = new Database(join(temporaryDirectory, "test.db"));
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });

  return {
    db,
    sqlite,
    async close() {
      sqlite.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

export type TestDatabase = Awaited<ReturnType<typeof openTestDatabase>>;
