import { describe, expect, it } from "vitest";
import {
  endOfDateInTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
} from "../src/time.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase } from "./support/db.js";

describe("calendar and offset boundaries", () => {
  it.each([
    undefined,
    "",
    "2031-2-03",
    "2031-02-30",
    "2031-00-01",
    "2031-01-00",
    "2031-13-01",
    "2031-01-01T00:00",
  ])("refuses invalid end-of-date input %j", (date) => {
    expect(endOfDateInTimeZone(date, "UTC")).toBeNull();
  });

  it.each([
    ["2032-02-29", "UTC", "2032-02-29T23:59:59.000Z"],
    ["2031-04-30", "UTC", "2031-04-30T23:59:59.000Z"],
    ["2031-03-09", "America/Chicago", "2031-03-10T04:59:59.000Z"],
    ["2031-11-02", "America/Chicago", "2031-11-03T05:59:59.000Z"],
    ["2031-06-01", "Asia/Kathmandu", "2031-06-01T18:14:59.000Z"],
  ])("ends %s in %s at the last real whole second", (day, zone, expected) => {
    expect(endOfDateInTimeZone(day, zone)?.toISOString()).toBe(expected);
  });

  it("rejects invalid zones at the date-ending boundary", () => {
    expect(endOfDateInTimeZone("2031-06-01", "Mars/Olympus")).toBeNull();
  });

  it.each([
    ["2031-01-01T00:00", "Pacific/Kiritimati", "2030-12-31T10:00:00.000Z"],
    ["2031-01-01T00:00", "Asia/Kathmandu", "2030-12-31T18:15:00.000Z"],
    ["2031-07-01T00:00", "Australia/Adelaide", "2031-06-30T14:30:00.000Z"],
    ["2031-01-01T00:00", "Australia/Adelaide", "2030-12-31T13:30:00.000Z"],
  ])(
    "resolves fractional and date-line offsets for %s in %s",
    (wall, zone, expected) => {
      expect(zonedWallClockToUtc(wall, zone)?.toISOString()).toBe(expected);
    },
  );

  it.each([
    "2031-00-01T12:00",
    "2031-01-00T12:00",
    "2031-01-01T12:00Z",
    "2031-01-01T12:00:00",
    " 2031-01-01T12:00",
    "2031-01-01T12:00 ",
  ])("keeps the wall-clock wire format strict for %j", (wall) => {
    expect(parseWallClock(wall)).toBeNull();
  });

  it("accepts a Gregorian leap day and refuses a non-leap century", () => {
    expect(parseWallClock("2000-02-29T23:59")).toEqual({
      year: 2000,
      month: 2,
      day: 29,
      hour: 23,
      minute: 59,
    });
    expect(parseWallClock("2100-02-29T23:59")).toBeNull();
  });

  it("persists local setup windows as UTC across a year boundary", async () => {
    const database = await openTestDatabase("porchfest-time-boundaries-");
    try {
      const setup = createSeasonSetup(database.db);
      const created = setup.createSeason({
        year: 2031,
        displayName: "Fractional offset",
        timezone: "Asia/Kathmandu",
        eventDate: "2031-01-01",
        eventCity: "Exampleton",
        eventState: "WI",
        signupOpensOn: "2030-12-01",
        signupClosesOn: "2030-12-31",
        timeSlots: [{ startsAt: "00:00", endsAt: "00:45" }],
        openSignups: false,
      });
      expect(
        database.sqlite
          .prepare(
            "select starts_at, ends_at from season_time_slots where season_id = ?",
          )
          .all(created.season.id),
      ).toEqual([
        {
          starts_at: Date.parse("2030-12-31T18:15:00Z") / 1000,
          ends_at: Date.parse("2030-12-31T19:00:00Z") / 1000,
        },
      ]);
    } finally {
      await database.close();
    }
  });
});
