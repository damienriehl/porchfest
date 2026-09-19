import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  conflict,
  RepositoryConflictError,
  RepositoryLifecycleError,
} from "../src/storage/repository-errors.js";
import { createRecordRepository, RecordConflictError } from "../src/records.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("repository error contracts", () => {
  it("uses a version conflict when no mutable field is named", () => {
    const error = new RepositoryConflictError(
      "SyntheticConflict",
      "act",
      42,
      [],
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "SyntheticConflict",
      recordType: "act",
      recordId: 42,
      conflictingFields: ["version"],
      message: "act 42 conflict: version",
    });
  });

  it("preserves multiple named fields and the concrete subclass through the throw helper", () => {
    expect(() =>
      conflict(RecordConflictError, "venue", 12, ["title", "notes"]),
    ).toThrowError(
      expect.objectContaining({
        name: "RecordConflictError",
        recordType: "venue",
        recordId: 12,
        conflictingFields: ["title", "notes"],
        message: "venue 12 conflict: title, notes",
      }),
    );
    expect(() => conflict(RecordConflictError, "contact", 12, [])).toThrow(
      RepositoryConflictError,
    );
  });

  it("preserves lifecycle error names and messages", () => {
    const error = new RepositoryLifecycleError(
      "SyntheticLifecycle",
      "Cannot continue",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.toString()).toBe("SyntheticLifecycle: Cannot continue");
  });
});

describe("repository conflict integration", () => {
  let database: TestDatabase;
  beforeEach(async () => {
    database = await openTestDatabase("repository-errors-");
  });
  afterEach(async () => {
    await database.close();
  });

  it("propagates an empty-patch stale write as a version conflict without changing the database", () => {
    const season = database.sqlite
      .prepare(
        "insert into seasons (year, display_name) values (2104, 'Synthetic') returning id",
      )
      .get() as { id: number };
    const act = database.sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, 'Synthetic act') returning id, version",
      )
      .get(season.id) as { id: number; version: number };
    const records = createRecordRepository(database.db);
    records.updateAct(act.id, act.version, { name: "Winning edit" });
    expect(() => records.updateAct(act.id, act.version, {})).toThrowError(
      expect.objectContaining({
        name: "RecordConflictError",
        conflictingFields: ["version"],
        recordType: "act",
        recordId: act.id,
      }),
    );
    expect(
      database.sqlite
        .prepare("select name, version from acts where id = ?")
        .get(act.id),
    ).toEqual({ name: "Winning edit", version: act.version + 1 });
  });

  it("reports a missing record through the same conflict contract as a stale version", () => {
    expect(() =>
      createRecordRepository(database.db).updateAct(999, 1, {
        name: "Missing",
      }),
    ).toThrowError(
      expect.objectContaining({ recordId: 999, conflictingFields: ["name"] }),
    );
  });
});
