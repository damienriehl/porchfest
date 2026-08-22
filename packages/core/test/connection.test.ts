import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_DATABASE_FILENAME,
  openCoreDatabase,
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
} from "../src/index.js";
import { contacts, schemaTableNames } from "../src/storage/schema.js";

describe("core database connection", () => {
  let closeDatabase: (() => void) | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDatabase?.();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("exports signup option vocabularies from the package entry point", () => {
    expect(venueGearValues).toContain("pa");
    expect(venueDrinkValues).toContain("water");
    expect(venueAmenityValues).toContain("accessible_entry");
  });

  it("migrates a file database and enforces foreign keys", async () => {
    const pragmaSpy = vi.spyOn(Database.prototype, "pragma");

    temporaryDirectory = await mkdtemp(join(tmpdir(), "porchfest-connection-"));
    const connection = openCoreDatabase(
      join(temporaryDirectory, CORE_DATABASE_FILENAME),
    );
    closeDatabase = connection.close;

    const tableNames = connection.database
      .all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
      )
      .map(({ name }) => name);
    const foreignKeys = connection.database.get<{ foreign_keys: number }>(
      sql`pragma foreign_keys`,
    );

    expect(pragmaSpy).toHaveBeenCalledWith("foreign_keys = ON");
    expect(tableNames).toEqual(expect.arrayContaining([...schemaTableNames]));
    expect(foreignKeys).toEqual({ foreign_keys: 1 });
    expect(() =>
      connection.database
        .insert(contacts)
        .values({ seasonId: 999_999, name: "Orphan contact" })
        .run(),
    ).toThrowError("FOREIGN KEY constraint failed");
  });
});
