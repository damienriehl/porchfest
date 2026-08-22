import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { CoreDatabase } from "./repository-errors.js";
import * as schema from "./schema.js";

export const CORE_DATABASE_FILENAME = "porchfest.db";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export interface CoreDatabaseConnection {
  readonly database: CoreDatabase;
  readonly close: () => void;
}

export function openCoreDatabase(path: string): CoreDatabaseConnection {
  const sqlite = new Database(path);
  const close = () => {
    sqlite.close();
  };

  try {
    sqlite.pragma("foreign_keys = ON");
    const database = drizzle(sqlite, { schema });
    migrate(database, { migrationsFolder });

    return Object.freeze({ database, close });
  } catch (error) {
    try {
      close();
    } catch {
      // Preserve the initialization error that made boot fail.
    }
    throw error;
  }
}
