import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeasonSetup, type SeasonSetupInput } from "../src/setup.js";
import { createSeasonRepository, SeasonLifecycleError } from "../src/season.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const input = (patch: Partial<SeasonSetupInput> = {}): SeasonSetupInput => ({
  year: 2104,
  displayName: "  Synthetic Festival  ",
  timezone: "America/Chicago",
  eventDate: "2104-06-01",
  timeSlots: [{ startsAt: "13:00", endsAt: "14:00" }],
  openSignups: true,
  ...patch,
});

describe("season setup validation and persistence", () => {
  let database: TestDatabase;
  beforeEach(async () => {
    database = await openTestDatabase("setup-validation-");
  });
  afterEach(async () => {
    await database.close();
  });

  it.each<[string, Partial<SeasonSetupInput>]>([
    ["displayName", { displayName: " \n\t " }],
    ...[1999, 2201, 2100.5, NaN, Infinity].map(
      (year) => ["year", { year }] as [string, Partial<SeasonSetupInput>],
    ),
    ["eventCity", { eventCity: " " }],
    ["eventState", { eventState: " " }],
    ["timezone", { timezone: "Not/AZone" }],
    ["eventDate", { eventDate: "2104-02-30" }],
    ["eventDate", { eventDate: "06/01/2104" }],
    ["signupOpensOn", { signupOpensOn: "2104-02-30" }],
    ["signupClosesOn", { signupClosesOn: "tomorrow" }],
    [
      "signupClosesOn",
      { signupOpensOn: "2104-05-01", signupClosesOn: "2104-05-01" },
    ],
    [
      "signupClosesOn",
      { signupOpensOn: "2104-05-02", signupClosesOn: "2104-05-01" },
    ],
    ["timeSlots.0", { timeSlots: [{ startsAt: "9:00", endsAt: "10:00" }] }],
    ["timeSlots.0", { timeSlots: [{ startsAt: "13:00", endsAt: "" }] }],
    ["timeSlots.0", { timeSlots: [{ startsAt: "24:00", endsAt: "25:00" }] }],
    ["timeSlots.0", { timeSlots: [{ startsAt: "13:00", endsAt: "13:00" }] }],
    ["timeSlots.0", { timeSlots: [{ startsAt: "23:00", endsAt: "01:00" }] }],
    [
      "bounds.north",
      { bounds: { north: NaN, south: 44, west: -94, east: -93 } },
    ],
    [
      "bounds.south",
      { bounds: { north: 45, south: Infinity, west: -94, east: -93 } },
    ],
    [
      "bounds.east",
      { bounds: { north: 45, south: 44, west: -94, east: Infinity } },
    ],
    ["bounds.west", { bounds: { north: 45, south: 44, west: NaN, east: -93 } }],
    [
      "bounds.north",
      { bounds: { north: 91, south: 44, west: -94, east: -93 } },
    ],
    [
      "bounds.north",
      { bounds: { north: 45, south: -91, west: -94, east: -93 } },
    ],
    [
      "bounds.north",
      { bounds: { north: 44, south: 44, west: -94, east: -93 } },
    ],
    ["bounds.east", { bounds: { north: 45, south: 44, west: -94, east: 181 } }],
    [
      "bounds.east",
      { bounds: { north: 45, south: 44, west: -181, east: -93 } },
    ],
    ["bounds.east", { bounds: { north: 45, south: 44, west: -93, east: -93 } }],
    ["localityName", { localityName: "---" }],
    ["publicSiteUrl", { publicSiteUrl: "not a url" }],
    ["publicMapUrl", { publicMapUrl: "javascript:alert(1)" }],
    ["senderEmail", { senderEmail: "two@example.com other@example.com" }],
    ...[0, -1, 1.5, Infinity].map(
      (retentionDays) =>
        ["retentionDays", { retentionDays }] as [
          string,
          Partial<SeasonSetupInput>,
        ],
    ),
  ])(
    "rejects invalid %s before inserting any aggregate rows (%j)",
    (field, patch) => {
      const setup = createSeasonSetup(database.db);
      expect(() => setup.createFirstSeason(input(patch))).toThrowError(
        expect.objectContaining({ name: "SeasonSetupError", field }),
      );
      expect(setup.needsFirstRun()).toBe(true);
      expect(
        database.sqlite
          .prepare("select count(*) as n from season_time_slots")
          .get(),
      ).toEqual({ n: 0 });
    },
  );

  it("normalizes optional values and persists timezone-aware signup dates", () => {
    const setup = createSeasonSetup(
      database.db,
      () => new Date("2104-01-01T00:00:00Z"),
    );
    const { season } = setup.createFirstSeason(
      input({
        eventCity: " Sample City ",
        eventState: " MN ",
        signupOpensOn: " 2104-01-01 ",
        signupClosesOn: "2104-06-01",
        localityName: " Neighborhood 1 ",
        senderName: " Organizer ",
        senderEmail: " synthetic@example.invalid ",
        publicSiteUrl: " https://example.invalid ",
        publicMapUrl: " ",
        retentionDays: 1,
        timeSlots: [
          { startsAt: " ", endsAt: "\t" },
          { startsAt: "13:00", endsAt: "14:00" },
        ],
      }),
    );
    expect(season).toMatchObject({
      displayName: "Synthetic Festival",
      eventCity: "Sample City",
      eventState: "MN",
      state: "signups_open",
      signupOpensAt: new Date("2104-01-01T06:00:00Z"),
      signupClosesAt: new Date("2104-06-01T05:00:00Z"),
      senderName: "Organizer",
      senderEmail: "synthetic@example.invalid",
      publicSiteUrl: "https://example.invalid/",
      publicMapUrl: null,
      retentionDays: 1,
    });
    const venue = database.sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(season.id, "Synthetic porch") as { id: number };
    const slots = createSeasonRepository(database.db).ensureVenueSlots(
      venue.id,
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      startsAt: new Date("2104-06-01T18:00:00Z"),
      endsAt: new Date("2104-06-01T19:00:00Z"),
      state: "open",
    });
  });

  it("supports an empty draft and unknown season slot lookups", () => {
    const setup = createSeasonSetup(database.db);
    expect(setup.listSeasons()).toEqual([]);
    expect(setup.listTimeSlots(999)).toEqual([]);
    const { season, timeSlotCount } = setup.createSeason(
      input({ timeSlots: [], openSignups: false }),
    );
    expect(timeSlotCount).toBe(0);
    expect(season).toMatchObject({
      state: "setup",
      eventCity: "Unconfigured",
      eventState: "Unconfigured",
      signupOpensAt: null,
      signupClosesAt: null,
    });
    expect(setup.needsFirstRun()).toBe(false);
  });

  it("refuses additional-season creation before the first run", () => {
    const setup = createSeasonSetup(database.db);
    expect(() => setup.createAdditionalSeason(input(), true)).toThrowError(
      expect.objectContaining({ field: "additionalSeason" }),
    );
    expect(setup.seasonCount()).toBe(0);
  });

  it("sorts seasons by year then newest identity, independently of insertion order", () => {
    const setup = createSeasonSetup(database.db);
    const older = setup.createFirstSeason(input({ year: 2103 })).season;
    const newestYear = setup.createAdditionalSeason(
      input({ year: 2105 }),
      false,
    ).season;
    const laterDuplicate = setup.createAdditionalSeason(
      input({ year: 2103 }),
      true,
    ).season;
    expect(setup.listSeasons().map((s) => s.id)).toEqual([
      newestYear.id,
      laterDuplicate.id,
      older.id,
    ]);
  });

  it("rolls back the first-season aggregate when a template insert fails", () => {
    const setup = createSeasonSetup(database.db);
    database.sqlite.exec(
      "create trigger reject_template before insert on season_time_slots begin select raise(abort, 'synthetic template failure'); end",
    );
    expect(() => setup.createFirstSeason(input())).toThrow(
      "synthetic template failure",
    );
    expect(setup.seasonCount()).toBe(0);
    database.sqlite.exec("drop trigger reject_template");
    expect(setup.createFirstSeason(input()).timeSlotCount).toBe(1);
  });

  it("rolls back a details update and deleted templates when replacement insert fails", () => {
    const setup = createSeasonSetup(database.db);
    const { season } = setup.createFirstSeason(input());
    const before = setup.listTimeSlots(season.id);
    database.sqlite.exec(
      "create trigger reject_template before insert on season_time_slots begin select raise(abort, 'synthetic template failure'); end",
    );
    expect(() =>
      setup.updateSeasonDetails(
        season.id,
        season.version,
        input({
          displayName: "Changed",
          timeSlots: [{ startsAt: "15:00", endsAt: "16:00" }],
        }),
      ),
    ).toThrow("synthetic template failure");
    expect(setup.listSeasons()).toEqual([season]);
    expect(setup.listTimeSlots(season.id)).toEqual(before);
  });

  it("removes every template when an unused season is changed to an empty schedule", () => {
    const setup = createSeasonSetup(database.db);
    const { season } = setup.createFirstSeason(input());
    const changed = setup.updateSeasonDetails(
      season.id,
      season.version,
      input({ timeSlots: [] }),
    );
    expect(changed.timeSlotCount).toBe(0);
    expect(setup.listTimeSlots(season.id)).toEqual([]);
    expect(changed.season.version).toBe(season.version + 1);
  });

  it("rolls back additional-season creation when template persistence fails", () => {
    const setup = createSeasonSetup(database.db);
    const first = setup.createFirstSeason(input());
    database.sqlite.exec(
      "create trigger reject_template before insert on season_time_slots begin select raise(abort, 'synthetic template failure'); end",
    );
    expect(() =>
      setup.createAdditionalSeason(input({ year: 2105 }), false),
    ).toThrow("synthetic template failure");
    expect(setup.listSeasons()).toEqual([first.season]);
    expect(setup.listTimeSlots(first.season.id)).toHaveLength(1);
  });

  it("refuses updates for missing seasons without creating records", () => {
    const setup = createSeasonSetup(database.db);
    expect(() => setup.updateSeasonDetails(999, 1, input())).toThrow(
      SeasonLifecycleError,
    );
    expect(setup.seasonCount()).toBe(0);
  });
});
