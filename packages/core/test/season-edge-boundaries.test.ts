import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeasonRepository, SeasonActionError } from "../src/season.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("season operational edge boundaries", () => {
  let database: TestDatabase;
  let repo: ReturnType<typeof createSeasonRepository>;
  let seasonId: number;
  const now = new Date("2110-06-01T12:00:00Z");
  beforeEach(async () => {
    database = await openTestDatabase("season-edge-boundaries-");
    repo = createSeasonRepository(database.db, { now: () => now });
    seasonId = season(2110);
  });
  afterEach(async () => {
    await database.close();
  });
  function season(year: number) {
    return Number(
      database.sqlite
        .prepare(
          "insert into seasons (year, display_name, state) values (?, 'Synthetic season', 'assigning')",
        )
        .run(year).lastInsertRowid,
    );
  }
  function venue(id = seasonId) {
    return Number(
      database.sqlite
        .prepare(
          "insert into venues (season_id, title) values (?, 'Synthetic porch')",
        )
        .run(id).lastInsertRowid,
    );
  }
  function slot(id = seasonId) {
    const venueId = venue(id);
    return Number(
      database.sqlite
        .prepare(
          "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?)",
        )
        .run(id, venueId, now.getTime() / 1000, now.getTime() / 1000 + 3600)
        .lastInsertRowid,
    );
  }
  function contact(id: number, name: string) {
    return repo.createManualContact({
      seasonId: id,
      contact: { name, email: "returning@example.test" },
    });
  }

  it.each(["blank name", "missing fallback", "foreign fallback"])(
    "refuses %s without partially placing a hold",
    (condition) => {
      const id = slot();
      const before = repo.getSlot(id);
      const fallbackVenueId =
        condition === "missing fallback"
          ? 99999
          : condition === "foreign fallback"
            ? venue(season(2111))
            : undefined;
      expect(() =>
        repo.holdSlot(id, before.version, {
          heldForName: condition === "blank name" ? " \t\n" : "Synthetic act",
          decideBy: now,
          fallbackVenueId,
        }),
      ).toThrow(
        condition === "blank name"
          ? /held-for name/
          : condition === "missing fallback"
            ? /does not exist/
            : /different seasons/,
      );
      expect(repo.getSlot(id)).toEqual(before);
      expect(repo.listReleasableHolds(seasonId)).toEqual([]);
    },
  );

  it("includes the exact hold deadline and excludes future and other-season holds", () => {
    const due = slot();
    const future = slot();
    const foreign = slot(season(2111));
    repo.holdSlot(due, 1, { heldForName: "Due act", decideBy: now });
    repo.holdSlot(future, 1, {
      heldForName: "Future act",
      decideBy: new Date(now.getTime() + 1000),
    });
    repo.holdSlot(foreign, 1, { heldForName: "Foreign act", decideBy: now });
    expect(repo.listReleasableHolds(seasonId).map((row) => row.id)).toEqual([
      due,
    ]);
    expect(repo.getSlot(future).state).toBe("held");
  });

  it("releases a hold after lock, clears every hold field, then permits archival", () => {
    const id = slot();
    const fallback = venue();
    const held = repo.holdSlot(id, 1, {
      heldForName: "Pending act",
      decideBy: now,
      fallbackVenueId: fallback,
    });
    const locked = repo.transitionSeason(seasonId, 1, "locked");
    const released = repo.releaseSlotHold(id, held.version);
    expect(released.assignmentTargetVenueId).toBe(fallback);
    expect(released.slot).toMatchObject({
      state: "open",
      heldForName: null,
      heldDecideBy: null,
      fallbackVenueId: null,
      version: held.version + 1,
    });
    expect(repo.listReleasableHolds(seasonId)).toEqual([]);
    expect(
      repo.transitionSeason(seasonId, locked.version, "archived").state,
    ).toBe("archived");
    expect(() => repo.ensureVenueSlots(released.slot.venueId)).toThrow(
      SeasonActionError,
    );
  });

  it("refuses a repeated hold and an open-slot release without changing persisted data", () => {
    const id = slot();
    const open = repo.getSlot(id);
    expect(() => repo.releaseSlotHold(id, open.version)).toThrow(
      /requires a held slot/,
    );
    expect(repo.getSlot(id)).toEqual(open);
    const held = repo.holdSlot(id, open.version, {
      heldForName: "Initial act",
      decideBy: now,
    });
    expect(() =>
      repo.holdSlot(id, held.version, {
        heldForName: "Replacement act",
        decideBy: now,
      }),
    ).toThrow(/requires an open slot/);
    expect(repo.getSlot(id)).toEqual(held);
  });

  it("counts multiple held slots and ignores another season when archiving", () => {
    const one = slot();
    const two = slot();
    const other = slot(season(2111));
    for (const id of [one, two, other])
      repo.holdSlot(id, 1, { heldForName: "Fixture act", decideBy: now });
    expect(() => repo.transitionSeason(seasonId, 1, "archived")).toThrow(
      "2 slots are still held",
    );
    expect(repo.getSeason(seasonId).version).toBe(1);
    repo.releaseSlotHold(one, 2);
    repo.releaseSlotHold(two, 2);
    expect(repo.transitionSeason(seasonId, 1, "archived").state).toBe(
      "archived",
    );
    expect(repo.getSlot(other).state).toBe("held");
  });

  it("returns empty collections and matching suggestions for a season with no acts or templates", () => {
    const id = venue();
    expect(repo.ensureVenueSlots(id)).toEqual([]);
    expect(repo.listAssignments(seasonId)).toEqual([]);
    expect(repo.listActLinks(seasonId)).toEqual([]);
    expect(repo.listEmailWaves(seasonId)).toEqual([]);
    expect(repo.listEmailWave(seasonId, "missing wave")).toEqual([]);
    expect(repo.suggestForVenue(id)).toEqual([]);
    expect(
      repo.findPriorSeasonContact(seasonId, "absent@example.test"),
    ).toBeNull();
  });

  it("chooses the latest canonical prior contact and skips same-year and future contacts", () => {
    const prior = season(2109);
    const oldest = season(2108);
    const sameYear = season(2110);
    const future = season(2111);
    contact(oldest, "Oldest fixture");
    contact(prior, "Earlier same-season fixture");
    const expected = contact(prior, "Newest canonical fixture");
    const superseded = contact(prior, "Newest duplicate fixture");
    repo.supersedeContact(superseded.id, superseded.version, expected.id);
    contact(sameYear, "Same year fixture");
    contact(future, "Future fixture");
    contact(seasonId, "Current fixture");
    expect(
      repo.findPriorSeasonContact(seasonId, "returning@example.test"),
    ).toMatchObject({
      contact: { id: expected.id },
      sourceSeason: { id: prior },
    });
  });

  it("refuses links to a canonical self or a foreign act without inserting an edge", () => {
    const reach = contact(seasonId, "Reach fixture");
    const act = repo.createPlaceholderAct({
      seasonId,
      reach: { reachViaContactId: reach.id },
      act: { name: "Canonical act" },
    });
    const alias = repo.createPlaceholderAct({
      seasonId,
      reach: { reachViaContactId: reach.id },
      act: { name: "Alias act" },
    });
    repo.supersedeAct(alias.id, alias.version, act.id);
    expect(() =>
      repo.linkActs({ seasonId, actId: act.id, linkedActId: alias.id }),
    ).toThrow(/cannot be linked to itself/);
    const foreignSeason = season(2111);
    const foreign = repo.createPlaceholderAct({
      seasonId: foreignSeason,
      reach: {
        contact: { name: "Foreign contact", email: "foreign@example.test" },
      },
      act: { name: "Foreign act" },
    });
    expect(() =>
      repo.linkActs({ seasonId, actId: act.id, linkedActId: foreign.id }),
    ).toThrow(/same season/);
    expect(repo.listActLinks(seasonId)).toEqual([]);
  });
});
