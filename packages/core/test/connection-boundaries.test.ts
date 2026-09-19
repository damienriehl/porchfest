import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openCoreDatabase } from "../src/storage/connection.js";
import { createSeasonSetup } from "../src/setup.js";
import { createSeasonRepository } from "../src/season.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(
    join(tmpdir(), "porchfest-connection-boundaries-"),
  );
  directories.push(path);
  return path;
}

describe("database open and restart boundaries", () => {
  it("migrates an in-memory database and makes close idempotent", () => {
    const connection = openCoreDatabase(":memory:");
    expect(connection.database.get(sql`pragma foreign_keys`)).toEqual({
      foreign_keys: 1,
    });
    expect(Object.isFrozen(connection)).toBe(true);
    connection.close();
    expect(() => connection.close()).not.toThrow();
    expect(() => connection.database.get(sql`select 1`)).toThrow();
  });

  it("preserves real signup records across close and repeated migration on restart", async () => {
    const path = join(await directory(), "restart.db");
    const first = openCoreDatabase(path);
    let seasonId: number;
    try {
      const season = createSeasonSetup(first.database).createSeason({
        year: 2031,
        displayName: "Restart fixture",
        timezone: "UTC",
        eventDate: "2031-09-13",
        timeSlots: [],
        openSignups: true,
      }).season;
      seasonId = season.id;
      createSeasonRepository(first.database).createPerformerSignup({
        seasonId,
        contact: { name: "Synthetic Act", email: "act@example.invalid" },
        act: {
          name: "Persistent Band",
          durationMinutes: 30,
          requiresAmplification: false,
          genre: "",
          description: "",
          links: "",
          housePreference: null,
          canLendGear: false,
          notes: null,
        },
        availabilities: [],
      });
    } finally {
      first.close();
    }
    const second = openCoreDatabase(path);
    try {
      const records = createSeasonRepository(second.database).listActivityQueue(
        seasonId,
      );
      expect(records).toHaveLength(2);
      expect(
        records.find((record) => record.recordType === "act")?.record,
      ).toMatchObject({ name: "Persistent Band", version: 1 });
      expect(second.database.get(sql`pragma foreign_keys`)).toEqual({
        foreign_keys: 1,
      });
      expect(
        second.database.get(sql`select count(*) as count from seasons`),
      ).toEqual({ count: 1 });
    } finally {
      second.close();
    }
  });

  it("rejects a missing parent directory without silently changing the database location", async () => {
    const root = await directory();
    expect(() =>
      openCoreDatabase(join(root, "missing", "database.db")),
    ).toThrow();
  });

  it("propagates corrupt database initialization and can subsequently open a separate healthy file", async () => {
    const root = await directory();
    const corrupt = join(root, "corrupt.db");
    await writeFile(corrupt, "synthetic non-SQLite bytes");
    expect(() => openCoreDatabase(corrupt)).toThrow();
    const healthy = openCoreDatabase(join(root, "healthy.db"));
    try {
      expect(
        healthy.database.get(sql`select count(*) as count from seasons`),
      ).toEqual({ count: 0 });
    } finally {
      healthy.close();
    }
  });
});
