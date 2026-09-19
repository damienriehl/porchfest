import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnnotationLifecycleError,
  createAnnotationRepository,
} from "../src/annotations.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("annotation repository", () => {
  let database: TestDatabase;
  let seasonId: number;
  const stamp = new Date("2104-01-01T00:00:00Z");
  beforeEach(async () => {
    database = await openTestDatabase("annotation-coverage-");
    seasonId = createSeasonSetup(database.db).createSeason({
      year: 2104,
      displayName: "Synthetic",
      timezone: "UTC",
      eventDate: "2104-06-01",
      timeSlots: [],
      openSignups: false,
    }).season.id;
  });
  afterEach(async () => {
    await database.close();
  });

  it("stores a trimmed note and reads its actual persisted identity and clock", () => {
    const repository = createAnnotationRepository(database.db, {
      now: () => stamp,
    });
    const result = repository.annotate({
      seasonId,
      recordType: "act",
      recordId: 12,
      note: " \n Confirm power \t ",
    });
    expect(result.created).toBe(true);
    expect(result.annotation).toMatchObject({
      seasonId,
      recordType: "act",
      recordId: 12,
      note: "Confirm power",
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    expect(
      createAnnotationRepository(database.db).listAnnotations(seasonId),
    ).toEqual([result.annotation]);
  });

  it("deduplicates a trimmed retry without resetting its timestamp or version", () => {
    const repository = createAnnotationRepository(database.db, {
      now: () => stamp,
    });
    const input = {
      seasonId,
      recordType: "venue" as const,
      recordId: 1,
      note: "Check access",
    };
    const first = repository.annotate(input);
    const retry = createAnnotationRepository(database.db, {
      now: () => new Date("2105-01-01"),
    }).annotate({ ...input, note: " Check access\n" });
    expect(retry).toEqual({ created: false, annotation: first.annotation });
    expect(repository.listAnnotations(seasonId)).toHaveLength(1);
  });

  it.each(["", " ", "\n\t\r", "\u00a0"])(
    "refuses an empty note %j before persisting",
    (note) => {
      const repository = createAnnotationRepository(database.db);
      expect(() =>
        repository.annotate({
          seasonId,
          recordType: "contact",
          recordId: 1,
          note,
        }),
      ).toThrow(AnnotationLifecycleError);
      expect(repository.listAnnotations(seasonId)).toEqual([]);
    },
  );

  it("keeps deduplication and every optional filter scoped to the complete target", () => {
    const repository = createAnnotationRepository(database.db);
    const secondSeasonId = database.sqlite
      .prepare(
        "insert into seasons (year, display_name) values (2105, 'Second synthetic') returning id",
      )
      .get() as { id: number };
    const rows = [
      { seasonId, recordType: "act" as const, recordId: 1, note: "Repeated" },
      { seasonId, recordType: "act" as const, recordId: 2, note: "Repeated" },
      { seasonId, recordType: "venue" as const, recordId: 1, note: "Repeated" },
      { seasonId, recordType: "act" as const, recordId: 1, note: "Different" },
      {
        seasonId: secondSeasonId.id,
        recordType: "act" as const,
        recordId: 1,
        note: "Repeated",
      },
    ].map((target) => repository.annotate(target).annotation);
    expect(repository.listAnnotations(seasonId)).toEqual(rows.slice(0, 4));
    expect(repository.listAnnotations(seasonId, "act")).toEqual([
      rows[0],
      rows[1],
      rows[3],
    ]);
    expect(repository.listAnnotations(seasonId, undefined, 1)).toEqual([
      rows[0],
      rows[2],
      rows[3],
    ]);
    expect(repository.listAnnotations(seasonId, "act", 1)).toEqual([
      rows[0],
      rows[3],
    ]);
    expect(repository.listAnnotations(secondSeasonId.id)).toEqual([rows[4]]);
    expect(repository.listAnnotations(seasonId, "contact")).toEqual([]);
    expect(repository.listAnnotations(seasonId, "act", 0)).toEqual([]);
    expect(repository.listAnnotations(999)).toEqual([]);
  });

  it("propagates foreign key failure without persisting an orphan", () => {
    const repository = createAnnotationRepository(database.db);
    expect(() =>
      repository.annotate({
        seasonId: 999,
        recordType: "act",
        recordId: 1,
        note: "Orphan",
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(repository.listAnnotations(999)).toEqual([]);
  });

  it("participates in a caller transaction and disappears on rollback", () => {
    expect(() =>
      database.db.transaction((tx) => {
        const repository = createAnnotationRepository(tx);
        repository.annotate({
          seasonId,
          recordType: "act",
          recordId: 1,
          note: "Pending",
        });
        expect(repository.listAnnotations(seasonId)).toHaveLength(1);
        throw new Error("synthetic outer failure");
      }),
    ).toThrow("synthetic outer failure");
    expect(
      createAnnotationRepository(database.db).listAnnotations(seasonId),
    ).toEqual([]);
  });
});
