import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createImportKeyRepository,
  ImportKeyLifecycleError,
} from "../src/import-keys.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("import key identity boundaries", () => {
  let database: TestDatabase;
  let seasonId: number;
  beforeEach(async () => {
    database = await openTestDatabase("porchfest-key-boundaries-");
    seasonId = createSeasonSetup(database.db).createSeason({
      year: 2031,
      displayName: "Synthetic Import",
      timezone: "UTC",
      eventDate: "2031-09-13",
      eventCity: "Exampleton",
      eventState: "WI",
      timeSlots: [],
      openSignups: false,
    }).season.id;
  });
  afterEach(async () => {
    await database.close();
  });
  const input = (seasonId: number) => ({
    seasonId,
    source: "fixture",
    naturalKey: "first",
    recordType: "season" as const,
    recordId: seasonId,
  });

  it("round trips a normalized binding through real season setup and migrated storage", () => {
    const keys = createImportKeyRepository(database.db);
    expect(keys.list(seasonId)).toEqual([]);
    expect(keys.find(seasonId, "fixture", "first")).toBeNull();
    expect(keys.findSeason("fixture", "first")).toBeNull();
    const first = keys.bind({
      ...input(seasonId),
      source: " fixture ",
      naturalKey: " first ",
    });
    expect(first.created).toBe(true);
    expect(keys.bind(input(seasonId))).toEqual({
      key: first.key,
      created: false,
    });
    expect(keys.find(seasonId, "fixture", "first")).toEqual(first.key);
    expect(keys.findSeason("fixture", "first")).toEqual(first.key);
    expect(keys.list(seasonId)).toEqual([first.key]);
  });

  it.each(["source", "naturalKey"] as const)(
    "rejects a blank %s without storing a row",
    (field) => {
      const keys = createImportKeyRepository(database.db);
      for (const operation of [keys.bind, keys.rebind]) {
        expect(() =>
          operation({ ...input(seasonId), [field]: " \t " }),
        ).toThrow(ImportKeyLifecycleError);
      }
      expect(keys.list(seasonId)).toEqual([]);
    },
  );

  it.each([{ recordId: 999 }, { recordType: "act" as const }])(
    "refuses conflicting identity %j without changing the existing key",
    (change) => {
      const keys = createImportKeyRepository(database.db);
      const original = keys.bind(input(seasonId)).key;
      expect(() => keys.bind({ ...input(seasonId), ...change })).toThrow(
        ImportKeyLifecycleError,
      );
      expect(keys.list(seasonId)).toEqual([original]);
    },
  );

  it("isolates keys by season and source and finds only season keys", () => {
    const keys = createImportKeyRepository(database.db);
    const other = createSeasonSetup(database.db).createSeason({
      year: 2032,
      displayName: "Other",
      timezone: "UTC",
      eventDate: "2032-09-13",
      eventCity: "Exampleton",
      eventState: "WI",
      timeSlots: [],
      openSignups: false,
    }).season;
    keys.bind({ ...input(seasonId), recordType: "act" });
    const seasonKey = keys.bind(input(other.id)).key;
    const anotherSource = keys.bind({
      ...input(seasonId),
      source: "second",
    }).key;
    expect(keys.findSeason("fixture", "first")).toEqual(seasonKey);
    expect(keys.findSeason("second", "first")).toEqual(anotherSource);
    expect(keys.list(other.id)).toEqual([seasonKey]);
    expect(keys.list(seasonId)).toHaveLength(2);
    expect(keys.find(other.id, "second", "first")).toBeNull();
  });

  it("advances rebind timestamps and versions once and leaves repeat rebinds stable", () => {
    let now = new Date("2031-01-01T00:00:00Z");
    const keys = createImportKeyRepository(database.db, { now: () => now });
    const first = keys.bind(input(seasonId)).key;
    now = new Date("2031-01-02T00:00:00Z");
    const rebound = keys.rebind({ ...input(seasonId), recordId: 42 });
    expect(rebound).toMatchObject({
      id: first.id,
      version: 2,
      recordId: 42,
      createdAt: first.createdAt,
      updatedAt: now,
    });
    now = new Date("2031-01-03T00:00:00Z");
    expect(keys.rebind({ ...input(seasonId), recordId: 42 })).toEqual(rebound);
    expect(keys.find(seasonId, "fixture", "first")).toEqual(rebound);
  });

  it("does not leave a key behind when the season foreign key fails", () => {
    const keys = createImportKeyRepository(database.db);
    expect(() => keys.bind(input(999999))).toThrow();
    expect(keys.list(999999)).toEqual([]);
    expect(keys.list(seasonId)).toEqual([]);
  });
});
