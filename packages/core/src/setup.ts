// R34's first-run setup, in the domain rather than in a form handler.
//
// "Deploying successfully and still having no way to open a season is a failed
// install." So this validates once, here, and both the admin form and any future
// caller get the same refusals — a season that this function accepts is a season
// that can take a public signup.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  acts,
  assignments,
  outboxWaves,
  seasons,
  seasonTimeSlots,
  slots,
  venueCoordinates,
  venues,
  type Season,
} from "./storage/schema.js";
import {
  isSeasonActionLegal,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
} from "./season.js";
import {
  isValidTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
} from "./time.js";
import type {
  CoreDatabase,
  CoreExecutor,
} from "./storage/repository-errors.js";

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
  readonly eventCity?: string;
  readonly eventState?: string;
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
  db: CoreDatabase,
  now: () => Date = () => new Date(),
) {
  function seasonCountIn(executor: CoreExecutor): number {
    const row = executor
      .select({ total: sql<number>`count(*)` })
      .from(seasons)
      .get();
    return row?.total ?? 0;
  }

  function seasonCount(): number {
    return seasonCountIn(db);
  }

  /** True when this deployment has never opened a season — the first-run state. */
  function needsFirstRun(): boolean {
    return seasonCount() === 0;
  }

  function insertSeason(
    executor: CoreExecutor,
    validated: ValidatedSetup,
    openSignups: boolean,
  ): SeasonSetupResult {
    const stamp = now();
    const mutable = { version: 1, createdAt: stamp, updatedAt: stamp };

    const season = executor
      .insert(seasons)
      .values({
        year: validated.year,
        displayName: validated.displayName,
        // R34 explicitly includes the signup state: an organizer finishing setup
        // expects a season that can accept a signup, not one they must then find
        // a second screen to open.
        state: openSignups ? "signups_open" : "setup",
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
      executor
        .insert(seasonTimeSlots)
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

  /** General creation remains available to imports and trusted domain callers.
   * Organizer routes use the intention-revealing first/additional commands. */
  function createSeason(input: SeasonSetupInput): SeasonSetupResult {
    const validated = validate(input);
    return insertSeason(db, validated, input.openSignups);
  }

  /** Create the deployment's first season only when the database is still empty.
   * The emptiness check and insert share one immediate transaction so two open
   * setup tabs cannot both pass a route-level preflight and create rows. */
  function createFirstSeason(input: SeasonSetupInput): SeasonSetupResult {
    const validated = validate(input);
    return db.transaction(
      (tx) => {
        if (seasonCountIn(tx) !== 0) {
          throw new SeasonSetupError(
            "firstRun",
            "The first season has already been created. Review the seasons already open before adding another.",
          );
        }
        return insertSeason(tx, validated, input.openSignups);
      },
      { behavior: "immediate" },
    );
  }

  /** Open a new season without implying that it edits an existing one. A second
   * row for the same year is legal, but only after an explicit confirmation. */
  function createAdditionalSeason(
    input: SeasonSetupInput,
    confirmDuplicateYear: boolean,
  ): SeasonSetupResult {
    const validated = validate(input);
    return db.transaction(
      (tx) => {
        if (seasonCountIn(tx) === 0) {
          throw new SeasonSetupError(
            "additionalSeason",
            "Open the first season before opening another one.",
          );
        }
        const sameYear = tx
          .select({ id: seasons.id })
          .from(seasons)
          .where(eq(seasons.year, validated.year))
          .get();
        if (sameYear && !confirmDuplicateYear) {
          throw new SeasonSetupError(
            "confirmDuplicateYear",
            `Confirm that you want another ${validated.year} season. This creates a separate season; it does not edit the existing one.`,
          );
        }
        return insertSeason(tx, validated, input.openSignups);
      },
      { behavior: "immediate" },
    );
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

  /**
   * Replace a season's editable setup details as one immediate unit. The season
   * row is the aggregate CAS: dependent checks, template replacement, and
   * coordinate invalidation all roll back when its submitted version is stale.
   */
  function updateSeasonDetails(
    seasonId: number,
    expectedVersion: number,
    input: SeasonSetupInput,
  ): SeasonSetupResult {
    const validated = validate(input);
    return db.transaction(
      (tx) => {
        const current = tx
          .select()
          .from(seasons)
          .where(eq(seasons.id, seasonId))
          .get();
        if (!current) {
          throw new SeasonLifecycleError(`season ${seasonId} does not exist`);
        }
        if (!isSeasonActionLegal(current.state, "correction")) {
          throw new SeasonActionError(current.state, "correction");
        }

        const currentSlots = tx
          .select()
          .from(seasonTimeSlots)
          .where(eq(seasonTimeSlots.seasonId, seasonId))
          .orderBy(seasonTimeSlots.position)
          .all();
        const templatesChanged = !sameTimeSlots(
          currentSlots,
          validated.timeSlots,
        );
        const scheduleChanged =
          current.eventDate !== validated.eventDate ||
          current.timezone !== validated.timezone ||
          templatesChanged;
        if (scheduleChanged) {
          assertScheduleDependenciesClear(tx, seasonId);
        }

        const localityChanged =
          current.localityName !== validated.localityName ||
          current.boundsNorth !== (validated.bounds?.north ?? null) ||
          current.boundsSouth !== (validated.bounds?.south ?? null) ||
          current.boundsEast !== (validated.bounds?.east ?? null) ||
          current.boundsWest !== (validated.bounds?.west ?? null);
        if (localityChanged && current.mapPublishedAt !== null) {
          throw new SeasonLifecycleError(
            "Unpublish the public map before changing the locality or bounding box, so the published pins cannot become stale.",
          );
        }

        const stamp = now();
        const result = tx
          .update(seasons)
          .set({
            year: validated.year,
            displayName: validated.displayName,
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
            version: sql`${seasons.version} + 1`,
            updatedAt: stamp,
          })
          .where(
            and(eq(seasons.id, seasonId), eq(seasons.version, expectedVersion)),
          )
          .run();
        if (result.changes !== 1) {
          throw new SeasonConflictError("season", seasonId, ["eventDetails"]);
        }

        if (templatesChanged) {
          tx.delete(seasonTimeSlots)
            .where(eq(seasonTimeSlots.seasonId, seasonId))
            .run();
          if (validated.timeSlots.length > 0) {
            tx.insert(seasonTimeSlots)
              .values(
                validated.timeSlots.map((slot, index) => ({
                  seasonId,
                  position: index + 1,
                  startsAt: slot.startsAt,
                  endsAt: slot.endsAt,
                  version: 1,
                  createdAt: stamp,
                  updatedAt: stamp,
                })),
              )
              .run();
          }
        }

        if (localityChanged) {
          const venueIds = tx
            .select({ id: venues.id })
            .from(venues)
            .where(eq(venues.seasonId, seasonId));
          tx.update(venueCoordinates)
            .set({
              status: "needs-review",
              rejectionCode: "address-changed",
              version: sql`${venueCoordinates.version} + 1`,
              updatedAt: stamp,
            })
            .where(inArray(venueCoordinates.venueId, venueIds))
            .run();
        }

        const season = tx
          .select()
          .from(seasons)
          .where(eq(seasons.id, seasonId))
          .get();
        if (!season) {
          throw new SeasonLifecycleError(`season ${seasonId} disappeared`);
        }
        return { season, timeSlotCount: validated.timeSlots.length };
      },
      { behavior: "immediate" },
    );
  }

  return Object.freeze({
    needsFirstRun,
    seasonCount,
    createSeason,
    createFirstSeason,
    createAdditionalSeason,
    updateSeasonDetails,
    listSeasons,
    listTimeSlots,
  });
}

function sameTimeSlots(
  current: readonly { readonly startsAt: Date; readonly endsAt: Date }[],
  next: readonly { readonly startsAt: Date; readonly endsAt: Date }[],
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (slot, index) =>
        slot.startsAt.getTime() === next[index]?.startsAt.getTime() &&
        slot.endsAt.getTime() === next[index]?.endsAt.getTime(),
    )
  );
}

function countRows(
  executor: CoreExecutor,
  table:
    | typeof acts
    | typeof venues
    | typeof slots
    | typeof assignments
    | typeof outboxWaves,
  seasonId: number,
): number {
  const row = executor
    .select({ total: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.seasonId, seasonId))
    .get();
  return row?.total ?? 0;
}

function assertScheduleDependenciesClear(
  executor: CoreExecutor,
  seasonId: number,
): void {
  const assignmentCount = countRows(executor, assignments, seasonId);
  const heldCount =
    executor
      .select({ total: sql<number>`count(*)` })
      .from(slots)
      .where(and(eq(slots.seasonId, seasonId), eq(slots.state, "held")))
      .get()?.total ?? 0;
  const slotCount = countRows(executor, slots, seasonId);
  const participantCount =
    countRows(executor, acts, seasonId) + countRows(executor, venues, seasonId);
  const outboxCount = countRows(executor, outboxWaves, seasonId);
  const blockers: string[] = [];
  if (assignmentCount > 0) {
    blockers.push(
      `unassign ${assignmentCount} assignment${assignmentCount === 1 ? "" : "s"}`,
    );
  }
  if (heldCount > 0) {
    blockers.push(`release ${heldCount} hold${heldCount === 1 ? "" : "s"}`);
  }
  if (slotCount > 0) {
    blockers.push(
      `remove ${slotCount} venue slot${slotCount === 1 ? "" : "s"}`,
    );
  }
  if (participantCount > 0) {
    blockers.push(
      `remove ${participantCount} participant record${participantCount === 1 ? "" : "s"}`,
    );
  }
  if (outboxCount > 0) {
    blockers.push(
      `clear ${outboxCount} outbox record${outboxCount === 1 ? "" : "s"}`,
    );
  }
  if (blockers.length > 0) {
    throw new SeasonLifecycleError(
      `Clear dependent schedule data before changing the event date, timezone, or time slots: ${blockers.join("; ")}.`,
    );
  }
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
  const eventCity = input.eventCity?.trim() ?? "Unconfigured";
  if (!eventCity) {
    throw new SeasonSetupError("eventCity", "Enter the event city.");
  }
  const eventState = input.eventState?.trim() ?? "Unconfigured";
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

  const localityName = trimmed(input.localityName);
  if (localityName !== null && !/[A-Za-z0-9]/.test(localityName)) {
    throw new SeasonSetupError(
      "localityName",
      "Enter a locality containing a word or number.",
    );
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
    localityName,
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
