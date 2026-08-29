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
