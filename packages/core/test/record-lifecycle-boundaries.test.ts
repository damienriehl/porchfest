import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordRepository, RecordConflictError } from "../src/records.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("record graph boundaries against SQLite", () => {
  let database: TestDatabase;
  let records: ReturnType<typeof createRecordRepository>;
  let seasonId: number;
  beforeEach(async () => {
    database = await openTestDatabase("record-graph-boundaries-");
    records = createRecordRepository(database.db);
    seasonId = Number(
      database.sqlite
        .prepare(
          "insert into seasons (year, display_name) values (2110, 'Graph fixture')",
        )
        .run().lastInsertRowid,
    );
  });
  afterEach(async () => {
    await database.close();
  });

  const kinds = ["act", "venue", "contact"] as const;
  function graph(kind: (typeof kinds)[number]) {
    const table = `${kind}s`;
    const canonicalColumn = `canonical_${kind}_id`;
    const create = (season = seasonId) =>
      Number(
        database.sqlite
          .prepare(
            `insert into ${table} (season_id, ${kind === "venue" ? "title" : "name"}) values (?, 'Synthetic record')`,
          )
          .run(season).lastInsertRowid,
      );
    const read = (id: number) =>
      database.sqlite.prepare(`select * from ${table} where id = ?`).get(id);
    const point = (id: number, target: number) =>
      database.sqlite
        .prepare(`update ${table} set ${canonicalColumn} = ? where id = ?`)
        .run(target, id);
    const resolve =
      kind === "act"
        ? records.resolveAct
        : kind === "venue"
          ? records.resolveVenue
          : records.resolveContact;
    const supersede =
      kind === "act"
        ? records.supersedeAct
        : kind === "venue"
          ? records.supersedeVenue
          : records.supersedeContact;
    return { create, read, point, resolve, supersede };
  }

  describe.each(kinds)("%s canonical graph", (kind) => {
    it("resolves a transitive family while ignoring a separate corrupt cycle", () => {
      const g = graph(kind);
      const [root, middle, leaf, brokenA, brokenB] = Array.from(
        { length: 5 },
        () => g.create(),
      );
      g.supersede(leaf!, 1, middle!);
      g.supersede(middle!, 1, root!);
      g.point(brokenA!, brokenB!);
      g.point(brokenB!, brokenA!);
      const resolved = g.resolve(leaf!);
      expect(resolved.canonical.id).toBe(root);
      expect(resolved.superseded.map((row) => row.id).sort()).toEqual(
        [middle, leaf].sort(),
      );
      expect(
        records
          .listActivityQueue(seasonId)
          .filter((item) => item.recordType === kind)
          .map((item) => item.record.id),
      ).toEqual([root]);
    });

    it("rejects traversal into a corrupt cycle without altering the source", () => {
      const g = graph(kind);
      const source = g.create();
      const a = g.create();
      const b = g.create();
      g.point(a, b);
      g.point(b, a);
      const before = g.read(source);
      expect(() => g.resolve(a)).toThrow(/supersession cycle/);
      expect(() => g.supersede(source, 1, a)).toThrow(/supersession cycle/);
      expect(g.read(source)).toEqual(before);
    });

    it("rejects stale supersession after resolving a target alias atomically", () => {
      const g = graph(kind);
      const source = g.create();
      const alias = g.create();
      const canonical = g.create();
      g.supersede(alias, 1, canonical);
      const before = g.read(source);
      expect(() => g.supersede(source, 0, alias)).toThrow(RecordConflictError);
      expect(g.read(source)).toEqual(before);
      expect(g.resolve(alias).canonical.id).toBe(canonical);
    });

    it("rejects a target from a different season and missing endpoints", () => {
      const g = graph(kind);
      const otherSeason = Number(
        database.sqlite
          .prepare(
            "insert into seasons (year, display_name) values (2111, 'Other fixture')",
          )
          .run().lastInsertRowid,
      );
      const source = g.create();
      const target = g.create(otherSeason);
      const before = g.read(source);
      expect(() => g.supersede(source, 1, target)).toThrow(/different seasons/);
      expect(() => g.supersede(source, 1, 99999)).toThrow(/does not exist/);
      expect(() => g.supersede(99999, 1, target)).toThrow(/does not exist/);
      expect(g.read(source)).toEqual(before);
    });
  });

  it("deduplicates host and reach recipients after transitive contact supersession", () => {
    const old = records.createManualContact({
      seasonId,
      contact: { name: "Old fixture", email: "old@example.test" },
    });
    const middle = records.createManualContact({
      seasonId,
      contact: { name: "Middle fixture", email: "middle@example.test" },
    });
    const current = records.createManualContact({
      seasonId,
      contact: { name: "Current fixture", email: "current@example.test" },
    });
    const venue = records.createPlaceholderVenue({
      seasonId,
      reach: { reachViaContactId: old.id },
      venue: { title: "Synthetic porch", hostContactId: middle.id },
    });
    records.supersedeContact(old.id, old.version, middle.id);
    records.supersedeContact(middle.id, middle.version, current.id);
    expect(records.resolveEmailRecipients("venue", venue.id)).toEqual([
      current,
    ]);
    records.updateContact(current.id, current.version, { email: null });
    expect(records.resolveEmailRecipients("venue", venue.id)).toEqual([]);
  });

  it("rolls back the newly created reach contact if placeholder host validation fails", () => {
    const before = database.sqlite.prepare("select * from contacts").all();
    expect(() =>
      records.createPlaceholderVenue({
        seasonId,
        reach: {
          contact: { name: "Rollback fixture", email: "rollback@example.test" },
        },
        venue: { title: "Rejected porch", hostContactId: 99999 },
      }),
    ).toThrow(/does not exist/);
    expect(database.sqlite.prepare("select * from contacts").all()).toEqual(
      before,
    );
    expect(records.listActivityQueue(seasonId)).toEqual([]);
  });

  it("rolls back a manual contact when SQLite refuses the placeholder act", () => {
    database.sqlite.exec(
      "create trigger reject_fixture_act before insert on acts begin select raise(abort, 'fixture act write failure'); end",
    );
    expect(() =>
      records.createPlaceholderAct({
        seasonId,
        reach: {
          contact: { name: "Rollback fixture", email: "rollback@example.test" },
        },
        act: { name: "Rejected act" },
      }),
    ).toThrow(/fixture act write failure/);
    expect(records.listActivityQueue(seasonId)).toEqual([]);
  });

  it("returns no recipients for an unreachable act and no records for an empty season", () => {
    expect(records.listActivityQueue(seasonId)).toEqual([]);
    const actId = graph("act").create();
    expect(records.resolveEmailRecipients("act", actId)).toEqual([]);
    expect(() => records.resolveEmailRecipients("venue", 99999)).toThrow(
      /does not exist/,
    );
  });
});
