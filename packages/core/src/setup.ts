// R34's first-run setup, in the domain rather than in a form handler.
//
// "Deploying successfully and still having no way to open a season is a failed
// install." So this validates once, here, and both the admin form and any future
// caller get the same refusals — a season that this function accepts is a season
// that can take a public signup.

import { desc, eq, sql } from "drizzle-orm";
import { seasons, seasonTimeSlots, type Season } from "./storage/schema.js";
import {
  isValidTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
} from "./time.js";
import type { CoreExecutor } from "./storage/repository-errors.js";

export class SeasonSetupError extends Error {
  override readonly name = "SeasonSetupError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export interface TimeSlotInput {
  /** Wall clock in the season's timezone, "HH:MM". */
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface SeasonSetupInput {
  readonly year: number;
  readonly displayName: string;
  readonly timezone: string;
  /** "YYYY-MM-DD", read in the season's own timezone. */
  readonly eventDate: string;
  readonly eventCity: string;
  readonly eventState: string;
  readonly signupOpensOn?: string | null;
  readonly signupClosesOn?: string | null;
  readonly timeSlots: readonly TimeSlotInput[];
  readonly localityName?: string | null;
  readonly bounds?: {
    readonly north: number;
    readonly south: number;
    readonly east: number;
    readonly west: number;
  } | null;
  readonly publicSiteUrl?: string | null;
  readonly publicMapUrl?: string | null;
  readonly senderName?: string | null;
  readonly senderEmail?: string | null;
  readonly retentionDays?: number | null;
  /** Whether the season should immediately accept public signups. */
  readonly openSignups: boolean;
}

export interface SeasonSetupResult {
  readonly season: Season;
  readonly timeSlotCount: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

export function createSeasonSetup(
  db: CoreExecutor,
  now: () => Date = () => new Date(),
) {
  function seasonCount(): number {
    const row = db
      .select({ total: sql<number>`count(*)` })
      .from(seasons)
      .get();
    return row?.total ?? 0;
  }

  /** True when this deployment has never opened a season — the first-run state. */
  function needsFirstRun(): boolean {
    return seasonCount() === 0;
  }

  function createSeason(input: SeasonSetupInput): SeasonSetupResult {
    const validated = validate(input);
    const stamp = now();
    const mutable = { version: 1, createdAt: stamp, updatedAt: stamp };

    const season = db
      .insert(seasons)
      .values({
        year: validated.year,
        displayName: validated.displayName,
        // R34 explicitly includes the signup state: an organizer finishing setup
        // expects a season that can accept a signup, not one they must then find
        // a second screen to open.
        state: input.openSignups ? "signups_open" : "setup",
        timezone: validated.timezone,
        eventDate: validated.eventDate,
        eventCity: validated.eventCity,
        eventState: validated.eventState,
        signupOpensAt: validated.signupOpensAt,
        signupClosesAt: validated.signupClosesAt,
        localityName: validated.localityName,
        boundsNorth: validated.bounds?.north ?? null,
        boundsSouth: validated.bounds?.south ?? null,
        boundsEast: validated.bounds?.east ?? null,
        boundsWest: validated.bounds?.west ?? null,
        publicSiteUrl: validated.publicSiteUrl,
        publicMapUrl: validated.publicMapUrl,
        senderName: validated.senderName,
        senderEmail: validated.senderEmail,
        retentionDays: validated.retentionDays,
        ...mutable,
      })
      .returning()
      .get();

    if (validated.timeSlots.length > 0) {
      db.insert(seasonTimeSlots)
        .values(
          validated.timeSlots.map((slot, index) => ({
            seasonId: season.id,
            position: index + 1,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            ...mutable,
          })),
        )
        .run();
    }

    return { season, timeSlotCount: validated.timeSlots.length };
  }

  /** Seasons newest first. The admin uses this to pick a default landing season
   *  rather than guessing that ids are contiguous. */
  function listSeasons(): Season[] {
    return db
      .select()
      .from(seasons)
      .orderBy(desc(seasons.year), desc(seasons.id))
      .all();
  }

  function listTimeSlots(seasonId: number) {
    return db
      .select()
      .from(seasonTimeSlots)
      .where(eq(seasonTimeSlots.seasonId, seasonId))
      .orderBy(seasonTimeSlots.position)
      .all();
  }

  return Object.freeze({
    needsFirstRun,
    seasonCount,
    createSeason,
    listSeasons,
    listTimeSlots,
  });
}

export type SeasonSetupRepository = ReturnType<typeof createSeasonSetup>;

interface ValidatedSetup {
  year: number;
  displayName: string;
  timezone: string;
  eventDate: string;
  eventCity: string;
  eventState: string;
  signupOpensAt: Date | null;
  signupClosesAt: Date | null;
  timeSlots: { startsAt: Date; endsAt: Date }[];
  localityName: string | null;
  bounds: SeasonSetupInput["bounds"];
  publicSiteUrl: string | null;
  publicMapUrl: string | null;
  senderName: string | null;
  senderEmail: string | null;
  retentionDays: number | null;
}

function validate(input: SeasonSetupInput): ValidatedSetup {
  const displayName = input.displayName.trim();
  if (!displayName) {
    throw new SeasonSetupError("displayName", "Give the season a name.");
  }
  if (
    !Number.isSafeInteger(input.year) ||
    input.year < 2000 ||
    input.year > 2200
  ) {
    throw new SeasonSetupError("year", "Enter a four-digit year.");
  }
  const eventCity = input.eventCity.trim();
  if (!eventCity) {
    throw new SeasonSetupError("eventCity", "Enter the event city.");
  }
  const eventState = input.eventState.trim();
  if (!eventState) {
    throw new SeasonSetupError(
      "eventState",
      "Enter the event state or region.",
    );
  }
  // Refused rather than defaulted: a wrong timezone silently shifts every
  // availability window a performer types, which is the U4 bug this column exists
  // to prevent.
  if (!isValidTimeZone(input.timezone)) {
    throw new SeasonSetupError(
      "timezone",
      "Choose a valid IANA timezone, such as America/Chicago.",
    );
  }
  if (
    !DATE_PATTERN.test(input.eventDate) ||
    !parseWallClock(`${input.eventDate}T12:00`)
  ) {
    throw new SeasonSetupError(
      "eventDate",
      "Enter the event date as YYYY-MM-DD.",
    );
  }

  const signupOpensAt = optionalDate(
    input.signupOpensOn,
    input.timezone,
    "signupOpensOn",
  );
  const signupClosesAt = optionalDate(
    input.signupClosesOn,
    input.timezone,
    "signupClosesOn",
  );
  if (signupOpensAt && signupClosesAt && signupClosesAt <= signupOpensAt) {
    throw new SeasonSetupError(
      "signupClosesOn",
      "Signups must close after they open.",
    );
  }

  const timeSlots = input.timeSlots
    .filter((slot) => slot.startsAt.trim() || slot.endsAt.trim())
    .map((slot, index) => {
      const label = `timeSlots.${index}`;
      if (
        !TIME_PATTERN.test(slot.startsAt) ||
        !TIME_PATTERN.test(slot.endsAt)
      ) {
        throw new SeasonSetupError(label, "Enter each time slot as HH:MM.");
      }
      const startsAt = zonedWallClockToUtc(
        `${input.eventDate}T${slot.startsAt}`,
        input.timezone,
      );
      const endsAt = zonedWallClockToUtc(
        `${input.eventDate}T${slot.endsAt}`,
        input.timezone,
      );
      if (!startsAt || !endsAt || endsAt <= startsAt) {
        throw new SeasonSetupError(
          label,
          "Each time slot must end after it starts.",
        );
      }
      return { startsAt, endsAt };
    });

  const bounds = input.bounds ?? null;
  if (bounds) {
    for (const [name, value] of [
      ["north", bounds.north],
      ["south", bounds.south],
      ["east", bounds.east],
      ["west", bounds.west],
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new SeasonSetupError(
          `bounds.${name}`,
          "Enter the bounding box as decimal degrees.",
        );
      }
    }
    if (
      bounds.north > 90 ||
      bounds.south < -90 ||
      bounds.north <= bounds.south
    ) {
      throw new SeasonSetupError(
        "bounds.north",
        "The north edge must be above the south edge.",
      );
    }
    if (bounds.east > 180 || bounds.west < -180 || bounds.east <= bounds.west) {
      throw new SeasonSetupError(
        "bounds.east",
        "The east edge must be right of the west edge.",
      );
    }
  }

  return {
    year: input.year,
    displayName,
    timezone: input.timezone,
    eventDate: input.eventDate,
    eventCity,
    eventState,
    signupOpensAt,
    signupClosesAt,
    timeSlots,
    localityName: trimmed(input.localityName),
    bounds,
    publicSiteUrl: httpUrl(input.publicSiteUrl, "publicSiteUrl"),
    publicMapUrl: httpUrl(input.publicMapUrl, "publicMapUrl"),
    senderName: trimmed(input.senderName),
    senderEmail: email(input.senderEmail),
    retentionDays: retention(input.retentionDays),
  };
}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text || null;
}

function optionalDate(
  value: string | null | undefined,
  timezone: string,
  field: string,
): Date | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (!DATE_PATTERN.test(text)) {
    throw new SeasonSetupError(field, "Enter the date as YYYY-MM-DD.");
  }
  const instant = zonedWallClockToUtc(`${text}T00:00`, timezone);
  if (!instant) throw new SeasonSetupError(field, "Enter a real date.");
  return instant;
}

function httpUrl(
  value: string | null | undefined,
  field: string,
): string | null {
  const text = trimmed(value);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SeasonSetupError(
      field,
      "Enter a full http:// or https:// address.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SeasonSetupError(
      field,
      "Enter a full http:// or https:// address.",
    );
  }
  return url.toString();
}

function email(value: string | null | undefined): string | null {
  const text = trimmed(value);
  if (!text) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new SeasonSetupError(
      "senderEmail",
      "Enter an address in the form name@example.com.",
    );
  }
  return text;
}

function retention(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SeasonSetupError(
      "retentionDays",
      "Enter a whole number of days, or leave it blank.",
    );
  }
  return value;
}
