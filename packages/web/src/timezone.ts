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
