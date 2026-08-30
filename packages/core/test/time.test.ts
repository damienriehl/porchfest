import { describe, expect, it } from "vitest";
import {
  endOfDateInTimeZone,
  isValidTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
} from "../src/time.js";

describe("endOfDateInTimeZone", () => {
  it("uses the season timezone and rolls the calendar year forward", () => {
    expect(
      endOfDateInTimeZone("2031-12-31", "America/Chicago")?.toISOString(),
    ).toBe("2032-01-01T05:59:59.000Z");
    expect(endOfDateInTimeZone("2031-02-29", "America/Chicago")).toBeNull();
  });
});

describe("parseWallClock", () => {
  it("accepts a real calendar time", () => {
    expect(parseWallClock("2031-06-01T14:05")).toEqual({
      year: 2031,
      month: 6,
      day: 1,
      hour: 14,
      minute: 5,
    });
  });

  it("refuses a date that does not exist instead of rolling it forward", () => {
    // `new Date("2031-02-29")` silently becomes March 1, which is how an
    // impossible availability window used to persist as a different day.
    expect(parseWallClock("2031-02-29T14:00")).toBeNull();
    expect(parseWallClock("2031-04-31T14:00")).toBeNull();
    expect(parseWallClock("2031-13-01T14:00")).toBeNull();
    expect(parseWallClock("2031-06-01T24:00")).toBeNull();
    expect(parseWallClock("2031-06-01T14:60")).toBeNull();
  });

  it("refuses anything that is not exactly the expected shape", () => {
    for (const value of ["", "2031-06-01", "2031-6-1T14:00", "garbage"]) {
      expect(parseWallClock(value)).toBeNull();
    }
  });
});

describe("zonedWallClockToUtc", () => {
  it("resolves a wall clock through the zone that owns it", () => {
    expect(
      zonedWallClockToUtc("2031-06-01T14:00", "America/Chicago")?.toISOString(),
    ).toBe("2031-06-01T19:00:00.000Z");
  });

  it("uses the offset in force on that date, not one fixed offset", () => {
    // Central standard time is -06:00, central daylight time is -05:00. A single
    // hardcoded offset gets one of these two wrong all year.
    expect(
      zonedWallClockToUtc("2031-01-15T09:00", "America/Chicago")?.toISOString(),
    ).toBe("2031-01-15T15:00:00.000Z");
    expect(
      zonedWallClockToUtc("2031-07-15T09:00", "America/Chicago")?.toISOString(),
    ).toBe("2031-07-15T14:00:00.000Z");
  });

  it("round-trips both daylight-saving transition days", () => {
    const zone = "America/Chicago";
    for (const value of ["2031-03-09T03:30", "2031-11-02T01:30"]) {
      const instant = zonedWallClockToUtc(value, zone);
      expect(instant).not.toBeNull();
      const rendered = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .format(instant as Date)
        .replace(", ", "T");
      expect(rendered).toBe(value);
    }
  });

  it("treats UTC as the identity, so a season that never set a zone is unmoved", () => {
    expect(zonedWallClockToUtc("2031-06-01T14:00", "UTC")?.toISOString()).toBe(
      "2031-06-01T14:00:00.000Z",
    );
  });

  it("refuses an unknown zone rather than silently falling back to UTC", () => {
    expect(zonedWallClockToUtc("2031-06-01T14:00", "Mars/Olympus")).toBeNull();
    expect(zonedWallClockToUtc("2031-06-01T14:00", "")).toBeNull();
  });

  it("refuses an impossible date", () => {
    expect(
      zonedWallClockToUtc("2031-02-29T14:00", "America/Chicago"),
    ).toBeNull();
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and refuses invented ones", () => {
    expect(isValidTimeZone("America/Chicago")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
