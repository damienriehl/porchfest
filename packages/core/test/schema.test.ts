import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seasonStates, slotStates } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const expectedTables = [
  "acts",
  "annotations",
  "assignments",
  "contacts",
  "email_log",
  "seasons",
  "slots",
  "venues",
];

describe("core schema migration", () => {
  let database: TestDatabase;
  let sqlite: Database.Database;

  beforeAll(async () => {
    database = await openTestDatabase("porchfest-schema-");
    sqlite = database.sqlite;
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates every domain table", () => {
    const tableNames = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tableNames).toEqual(expect.arrayContaining(expectedTables));
  });

  it("rejects a slot state outside the supported state machine", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2099, "Sample Season") as { id: number };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(season.id, "Sample Venue") as { id: number };

    expect(() =>
      sqlite
        .prepare(
          "insert into slots (season_id, venue_id, starts_at, ends_at, state) values (?, ?, ?, ?, ?)",
        )
        .run(season.id, venue.id, 4_102_444_800, 4_102_448_400, "invalid"),
    ).toThrow();
  });

  it("keeps migration state checks aligned with the schema state lists", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_overconfident_joseph.sql", import.meta.url),
      "utf8",
    );
    const constraintValues = (constraintName: string): string[] => {
      const values = migration.match(
        new RegExp(
          `CONSTRAINT "${constraintName}" CHECK\\([^\\n]*? in \\(([^)]*)\\)\\)`,
        ),
      )?.[1];
      if (values === undefined) {
        throw new Error(`migration constraint ${constraintName} not found`);
      }
      return values.split(",").map((value) => value.trim().replaceAll("'", ""));
    };

    expect(constraintValues("seasons_state_check")).toEqual(seasonStates);
    expect(constraintValues("slots_state_check")).toEqual(slotStates);
  });

  it("defaults the optimistic-concurrency version to one", () => {
    const inserted = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning version",
      )
      .get(2100, "Version Sample") as { version: number };

    expect(inserted.version).toBe(1);
  });

  it("round-trips a season-scoped row", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2101, "Scope Sample") as { id: number };

    const inserted = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links) values (?, ?, ?, ?, ?) returning id",
      )
      .get(
        season.id,
        "Sample Act",
        "Sample Genre",
        "Synthetic fixture",
        "https://example.invalid/sample",
      ) as { id: number };
    const selected = sqlite
      .prepare(
        "select season_id, name, version from acts where id = ? and season_id = ?",
      )
      .get(inserted.id, season.id);

    expect(selected).toEqual({
      season_id: season.id,
      name: "Sample Act",
      version: 1,
    });
  });
});
