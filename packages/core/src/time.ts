// Participant-facing forms submit timezone-free wall clocks: an HTML
// `datetime-local` control sends "2027-09-11T14:00" and says nothing about which
// clock that is. Reading it as UTC is the silent failure this module exists to
// prevent — in Saint Paul it shifts every window five hours earlier, and the
// mistake survives a green test suite because the test pins the same wrong epoch.
//
// The season owns the answer (R34), so conversion always takes an IANA zone.

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export interface WallClockParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Parse "YYYY-MM-DDTHH:MM" strictly. Returns null for anything that is not a
 * real calendar time. `new Date()` normalizes 2031-02-29 into March 1 rather
 * than rejecting it, so the parsed components are round-tripped and compared
 * instead of trusting the Date constructor.
 */
export function parseWallClock(value: string): WallClockParts | null {
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, hour, minute };
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a wall clock in `timeZone` to the instant it names.
 *
 * The offset of a zone depends on the instant, and the instant is what we are
 * solving for, so this guesses UTC and corrects twice. Two passes settle every
 * real zone including both DST edges: the first correction lands within an hour
 * of the answer, the second lands on it. A time in a spring-forward gap does not
 * exist; it resolves to the instant the clock jumps to rather than being
 * rejected, which is the forgiving behavior a signup form wants.
 */
export function zonedWallClockToUtc(
  value: string,
  timeZone: string,
): Date | null {
  const parts = parseWallClock(value);
  if (!parts || !isValidTimeZone(timeZone)) return null;

  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let timestamp = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const rendered = formatter.formatToParts(new Date(timestamp));
    const field = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(rendered.find((part) => part.type === type)?.value ?? "0");
    const asZone = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      // Some locales render midnight as hour 24; normalize it back to 0.
      field("hour") % 24,
      field("minute"),
      field("second"),
    );
    timestamp += target - asZone;
  }

  return new Date(timestamp);
}

/** Resolve the final whole second of a calendar date in an IANA timezone. */
export function endOfDateInTimeZone(
  value: string | undefined,
  timeZone: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return null;
  const [year, month, day] = value!.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const selected = new Date(Date.UTC(year, month - 1, day));
  if (
    selected.getUTCFullYear() !== year ||
    selected.getUTCMonth() !== month - 1 ||
    selected.getUTCDate() !== day
  ) {
    return null;
  }
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = `${next.getUTCFullYear().toString().padStart(4, "0")}-${(next.getUTCMonth() + 1).toString().padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;
  const nextMidnight = zonedWallClockToUtc(`${nextDate}T00:00`, timeZone);
  return nextMidnight === null
    ? null
    : new Date(nextMidnight.getTime() - 1_000);
}
