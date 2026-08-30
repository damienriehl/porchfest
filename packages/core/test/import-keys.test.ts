import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createImportKeyRepository,
  ImportKeyLifecycleError,
} from "../src/import-keys.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("import key rebinding", () => {
  let database: TestDatabase;
  let seasonId: number;
  const now = new Date("2026-08-30T12:00:00.000Z");

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-import-keys-");
    seasonId = (
      database.sqlite
        .prepare(
          "insert into seasons (year, display_name) values (?, ?) returning id",
        )
        .get(2026, "Synthetic Rebinding Season") as { id: number }
    ).id;
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates a missing key and leaves a same-record rebind unchanged", () => {
    const importKeys = createImportKeyRepository(database.db, {
      now: () => now,
    });
    const input = {
      seasonId,
      source: " synthetic:assignment ",
      naturalKey: " venue-01:6-7 ",
      recordType: "assignment" as const,
      recordId: 41,
    };

    const created = importKeys.rebind(input);
    const unchanged = importKeys.rebind(input);

    expect(created).toMatchObject({
      source: "synthetic:assignment",
      naturalKey: "venue-01:6-7",
      recordType: "assignment",
      recordId: 41,
      version: 1,
    });
    expect(unchanged).toEqual(created);
  });

  it("updates the record id but refuses to change record type", () => {
    const importKeys = createImportKeyRepository(database.db, {
      now: () => now,
    });
    const input = {
      seasonId,
      source: "synthetic:assignment",
      naturalKey: "venue-01:6-7",
      recordType: "assignment" as const,
      recordId: 41,
    };
    const created = importKeys.rebind(input);

    const rebound = importKeys.rebind({ ...input, recordId: 42 });

    expect(rebound).toMatchObject({
      id: created.id,
      recordType: "assignment",
      recordId: 42,
      version: created.version + 1,
    });
    expect(() =>
      importKeys.rebind({
        ...input,
        recordType: "slot",
        recordId: 42,
      }),
    ).toThrowError(ImportKeyLifecycleError);
    expect(() =>
      importKeys.rebind({
        ...input,
        recordType: "slot",
        recordId: 42,
      }),
    ).toThrowError(
      "import key synthetic:assignment/venue-01:6-7 is already bound to assignment 42",
    );
  });
});
