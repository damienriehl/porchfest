import { describe, expect, it } from "vitest";
import {
  currentYearIn,
  formatZonedDateInput,
  formatReadableZonedDateTime,
  formatReadableZonedWindow,
} from "../src/timezone.js";

describe("season timezone formatting", () => {
  it("chooses the local season year on both sides of the date line", () => {
    const instant = new Date("2031-01-01T05:30:00Z");
    expect(currentYearIn("America/Chicago", instant)).toBe(2030);
    expect(currentYearIn("Pacific/Kiritimati", instant)).toBe(2031);
    expect(currentYearIn("UTC", instant)).toBe(2031);
  });
  it.each([
    ["2031-01-01T05:30:00Z", "America/Chicago", "2030-12-31"],
    ["2031-12-31T12:00:00Z", "Pacific/Kiritimati", "2032-01-01"],
    ["2032-03-01T01:00:00Z", "America/Chicago", "2032-02-29"],
    ["2031-07-03T02:00:00Z", "UTC", "2031-07-03"],
  ])("formats %s in %s as an HTML calendar date", (instant, zone, expected) => {
    expect(formatZonedDateInput(new Date(instant), zone)).toBe(expected);
  });
  it("uses cached formatters without mixing zones or daylight offsets", () => {
    expect(
      formatReadableZonedDateTime(
        new Date("2031-01-15T18:00:00Z"),
        "America/Chicago",
      ),
    ).toBe("Jan 15, 2031, 12:00 PM");
    expect(
      formatReadableZonedDateTime(
        new Date("2031-07-15T18:00:00Z"),
        "America/Chicago",
      ),
    ).toBe("Jul 15, 2031, 1:00 PM");
    expect(
      formatReadableZonedDateTime(new Date("2031-07-15T18:00:00Z"), "UTC"),
    ).toBe("Jul 15, 2031, 6:00 PM");
  });
  it("integrates real core window formatting when UTC crosses midnight but local dates match", () => {
    const window = {
      startsAt: new Date("2031-06-02T00:00:00Z"),
      endsAt: new Date("2031-06-02T01:30:00Z"),
    };
    expect(formatReadableZonedWindow(window, "America/Chicago")).toBe(
      "Jun 1, 2031, 7:00–8:30 PM",
    );
    expect(formatReadableZonedWindow(window, "UTC")).toBe(
      "Jun 2, 2031, 12:00–1:30 AM",
    );
    expect(formatReadableZonedWindow(window, "America/Chicago")).toBe(
      "Jun 1, 2031, 7:00–8:30 PM",
    );
  });
  it("retains both dates when a window crosses local midnight", () => {
    expect(
      formatReadableZonedWindow(
        {
          startsAt: new Date("2031-06-02T04:30:00Z"),
          endsAt: new Date("2031-06-02T05:30:00Z"),
        },
        "America/Chicago",
      ),
    ).toBe("Jun 1, 2031, 11:30 PM–Jun 2, 2031, 12:30 AM");
  });
  it("retains both meridiems across noon", () => {
    expect(
      formatReadableZonedWindow(
        {
          startsAt: new Date("2031-06-01T16:30:00Z"),
          endsAt: new Date("2031-06-01T17:30:00Z"),
        },
        "America/Chicago",
      ),
    ).toBe("Jun 1, 2031, 11:30 AM–12:30 PM");
  });
  it.each(["Not/A_Zone", "__proto__", "constructor"])(
    "rejects unsupported timezone %s instead of inheriting cache members",
    (zone) => {
      const now = new Date("2031-06-01T00:00:00Z");
      expect(() => currentYearIn(zone, now)).toThrow(RangeError);
      expect(() => formatZonedDateInput(now, zone)).toThrow(RangeError);
      expect(() => formatReadableZonedDateTime(now, zone)).toThrow(RangeError);
      expect(() =>
        formatReadableZonedWindow({ startsAt: now, endsAt: now }, zone),
      ).toThrow(RangeError);
    },
  );
  it("rejects invalid date inputs throughout the formatting chain", () => {
    const invalid = new Date(NaN);
    expect(() => currentYearIn("UTC", invalid)).toThrow(RangeError);
    expect(() => formatZonedDateInput(invalid, "UTC")).toThrow(RangeError);
    expect(() => formatReadableZonedDateTime(invalid, "UTC")).toThrow(
      RangeError,
    );
    expect(() =>
      formatReadableZonedWindow(
        { startsAt: new Date(), endsAt: invalid },
        "UTC",
      ),
    ).toThrow(RangeError);
  });
});
