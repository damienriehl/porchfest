export function currentYearIn(timezone: string, now = new Date()): number {
  const year = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
  })
    .formatToParts(now)
    .find((part) => part.type === "year")?.value;
  const parsed = Number(year);
  return Number.isSafeInteger(parsed) ? parsed : now.getUTCFullYear();
}

export function formatZonedDateInput(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function formatReadableZonedDateTime(
  date: Date,
  timezone: string,
): string {
  let formatter = readableDateTimeFormatters[timezone];
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    readableDateTimeFormatters[timezone] = formatter;
  }
  return formatter.format(date);
}

export function formatReadableZonedWindow(
  window: { readonly startsAt: Date; readonly endsAt: Date },
  timezone: string,
): string {
  let dateFormatter = readableDateFormatters[timezone];
  if (!dateFormatter) {
    dateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
    });
    readableDateFormatters[timezone] = dateFormatter;
  }
  const startDate = dateFormatter.format(window.startsAt);
  const endDate = dateFormatter.format(window.endsAt);
  if (startDate === endDate) {
    return `${startDate}, ${formatZonedWindow(window, timezone)}`;
  }
  return `${formatReadableZonedDateTime(window.startsAt, timezone)}–${formatReadableZonedDateTime(window.endsAt, timezone)}`;
}
import { formatZonedWindow } from "@porchfest/core";

const readableDateFormatters: Record<string, Intl.DateTimeFormat | undefined> =
  Object.create(null) as Record<string, Intl.DateTimeFormat | undefined>;
const readableDateTimeFormatters: Record<
  string,
  Intl.DateTimeFormat | undefined
> = Object.create(null) as Record<string, Intl.DateTimeFormat | undefined>;
