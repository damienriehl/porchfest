import { and, desc, eq, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { createRecordRepository } from "./records.js";
import {
  acts,
  assignments,
  contacts,
  emailLog,
  seasons,
  slots,
  venues,
  type Act,
  type Assignment,
  type Contact,
  type EmailLogEntry,
  type Season,
  type Slot,
} from "./storage/schema.js";
import * as schema from "./storage/schema.js";
import {
  type CoreDatabase,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
  conflict as repositoryConflict,
} from "./storage/repository-errors.js";

/*
 * Policy choices not fixed by the product requirements:
 * - assignment: signups_open, signups_closed, and assigning;
 * - hold: setup through assigning;
 * - correction and hold_release: every state except archived;
 * - transitions: forward-only (a later state may be selected directly).
 *
 * A held-for name does not have to resolve to an act row. This supports both a
 * not-yet-signed-up act and an act-side pencil whose venue host has not filed.
 */

export type SeasonState = (typeof schema.seasonStates)[number];
export type SeasonAction =
  "assignment" | "hold" | "hold_release" | "correction";

const stateOrder: readonly SeasonState[] = schema.seasonStates;

const legalStates: Readonly<Record<SeasonAction, readonly SeasonState[]>> = {
  assignment: ["signups_open", "signups_closed", "assigning"],
  hold: ["setup", "signups_open", "signups_closed", "assigning"],
  hold_release: [
    "setup",
    "signups_open",
    "signups_closed",
    "assigning",
    "locked",
  ],
  correction: [
    "setup",
    "signups_open",
    "signups_closed",
    "assigning",
    "locked",
  ],
};

export function isSeasonActionLegal(
  state: SeasonState,
  action: SeasonAction,
): boolean {
  return legalStates[action].includes(state);
}

export class SeasonActionError extends Error {
  readonly state: SeasonState;
  readonly action: string;

  constructor(state: SeasonState, action: string) {
    super(`season state ${state} refuses action ${action}`);
    this.name = "SeasonActionError";
    this.state = state;
    this.action = action;
  }
}

export class SeasonConflictError extends RepositoryConflictError<
  "season" | "slot" | "assignment"
> {
  constructor(
    recordType: "season" | "slot" | "assignment",
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    super("SeasonConflictError", recordType, recordId, conflictingFields);
  }
}

export class SeasonLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("SeasonLifecycleError", message);
  }
}

export type SeasonRepositoryOptions = RepositoryOptions;

export interface SlotHold {
  heldForName: string;
  decideBy: Date;
  fallbackVenueId?: number | null;
}

export interface ReleasedSlotHold {
  slot: Slot;
  assignmentTargetVenueId: number | null;
}

export interface AssignmentSuggestion {
  act: Act;
  slot: Slot;
}

export interface PriorSeasonContact {
  contact: Contact;
  sourceSeason: Season;
}

export type AssignmentCorrection = Partial<Pick<Assignment, "actId">>;

export function createSeasonRepository(
  db: CoreDatabase,
  options: SeasonRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const records = createRecordRepository(db, options);

  function conflict(
    recordType: "season" | "slot" | "assignment",
    recordId: number,
    fields: readonly string[],
  ): never {
    return repositoryConflict(
      SeasonConflictError,
      recordType,
      recordId,
      fields,
    );
  }

  function getSeason(id: number): Season {
    const season = db.select().from(seasons).where(eq(seasons.id, id)).get();
    if (!season) throw new SeasonLifecycleError(`season ${id} does not exist`);
    return season;
  }

  function getSlot(id: number): Slot {
    const slot = db.select().from(slots).where(eq(slots.id, id)).get();
    if (!slot) throw new SeasonLifecycleError(`slot ${id} does not exist`);
    return slot;
  }

  function getAssignment(id: number): Assignment {
    const assignment = db
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .get();
    if (!assignment)
      throw new SeasonLifecycleError(`assignment ${id} does not exist`);
    return assignment;
  }

  function assertLegal(season: Season, action: SeasonAction): void {
    if (!isSeasonActionLegal(season.state, action)) {
      throw new SeasonActionError(season.state, action);
    }
  }

  function transitionSeason(
    seasonId: number,
    expectedVersion: number,
    targetState: SeasonState,
  ): Season {
    const season = getSeason(seasonId);
    const currentIndex = stateOrder.indexOf(season.state);
    const targetIndex = stateOrder.indexOf(targetState);
    const action = `transition_to_${targetState}`;
    if (targetIndex <= currentIndex) {
      throw new SeasonActionError(season.state, action);
    }

    const result = db
      .update(seasons)
      .set({
        state: targetState,
        version: sql`${seasons.version} + 1`,
        updatedAt: now(),
      })
      .where(
        and(eq(seasons.id, seasonId), eq(seasons.version, expectedVersion)),
      )
      .run();
    if (result.changes !== 1) conflict("season", seasonId, ["state"]);
    return getSeason(seasonId);
  }

  function holdSlot(
    slotId: number,
    expectedVersion: number,
    hold: SlotHold,
  ): Slot {
    const slot = getSlot(slotId);
    const season = getSeason(slot.seasonId);
    assertLegal(season, "hold");
    if (slot.state !== "open") {
      throw new SeasonLifecycleError(
        `slot ${slot.id} is ${slot.state}; hold requires an open slot`,
      );
    }
    if (hold.heldForName.trim().length === 0) {
      throw new SeasonLifecycleError("a slot hold requires a held-for name");
    }
    if (hold.fallbackVenueId !== undefined && hold.fallbackVenueId !== null) {
      const fallback = db
        .select()
        .from(venues)
        .where(eq(venues.id, hold.fallbackVenueId))
        .get();
      if (!fallback)
        throw new SeasonLifecycleError(
          `fallback venue ${hold.fallbackVenueId} does not exist`,
        );
      if (fallback.seasonId !== slot.seasonId) {
        throw new SeasonLifecycleError(
          "fallback venue and held slot belong to different seasons",
        );
      }
    }

    const result = db
      .update(slots)
      .set({
        state: "held",
        heldDecideBy: hold.decideBy,
        heldForName: hold.heldForName,
        fallbackVenueId: hold.fallbackVenueId ?? null,
        version: sql`${slots.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(slots.id, slotId), eq(slots.version, expectedVersion)))
      .run();
    if (result.changes !== 1)
      conflict("slot", slotId, [
        "state",
        "heldDecideBy",
        "heldForName",
        "fallbackVenueId",
      ]);
    return getSlot(slotId);
  }

  function listReleasableHolds(seasonId: number): Slot[] {
    return db
      .select()
      .from(slots)
      .where(
        and(
          eq(slots.seasonId, seasonId),
          eq(slots.state, "held"),
          lte(slots.heldDecideBy, now()),
        ),
      )
      .all();
  }

  function releaseSlotHold(
    slotId: number,
    expectedVersion: number,
  ): ReleasedSlotHold {
    const slot = getSlot(slotId);
    const season = getSeason(slot.seasonId);
    assertLegal(season, "hold_release");
    if (slot.state !== "held") {
      throw new SeasonLifecycleError(
        `slot ${slot.id} is ${slot.state}; hold_release requires a held slot`,
      );
    }
    const assignmentTargetVenueId = slot.fallbackVenueId;
    const result = db
      .update(slots)
      .set({
        state: "open",
        heldDecideBy: null,
        heldForName: null,
        fallbackVenueId: null,
        version: sql`${slots.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(slots.id, slotId), eq(slots.version, expectedVersion)))
      .run();
    if (result.changes !== 1)
      conflict("slot", slotId, [
        "state",
        "heldDecideBy",
        "heldForName",
        "fallbackVenueId",
      ]);
    return { slot: getSlot(slotId), assignmentTargetVenueId };
  }

  function assignSlot(
    slotId: number,
    expectedVersion: number,
    actId: number,
  ): Assignment {
    return db.transaction((tx) => {
      const slot = tx.select().from(slots).where(eq(slots.id, slotId)).get();
      if (!slot)
        throw new SeasonLifecycleError(`slot ${slotId} does not exist`);
      const season = tx
        .select()
        .from(seasons)
        .where(eq(seasons.id, slot.seasonId))
        .get();
      if (!season)
        throw new SeasonLifecycleError(
          `season ${slot.seasonId} does not exist`,
        );
      assertLegal(season, "assignment");
      const act = tx.select().from(acts).where(eq(acts.id, actId)).get();
      if (!act) throw new SeasonLifecycleError(`act ${actId} does not exist`);
      if (act.seasonId !== slot.seasonId) {
        throw new SeasonLifecycleError(
          "act and slot belong to different seasons",
        );
      }
      if (slot.state !== "open") {
        throw new SeasonLifecycleError(
          `slot ${slot.id} is ${slot.state}; assignment requires an open slot`,
        );
      }

      const result = tx
        .update(slots)
        .set({
          state: "assigned",
          version: sql`${slots.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(slots.id, slotId), eq(slots.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("slot", slotId, ["assignment"]);
      return tx
        .insert(assignments)
        .values({ seasonId: slot.seasonId, actId, slotId })
        .returning()
        .get();
    });
  }

  function correctAssignment(
    assignmentId: number,
    expectedVersion: number,
    changes: AssignmentCorrection,
  ): Assignment {
    const assignment = getAssignment(assignmentId);
    const season = getSeason(assignment.seasonId);
    assertLegal(season, "correction");
    if (changes.actId !== undefined) {
      const act = db
        .select()
        .from(acts)
        .where(eq(acts.id, changes.actId))
        .get();
      if (!act)
        throw new SeasonLifecycleError(`act ${changes.actId} does not exist`);
      if (act.seasonId !== assignment.seasonId) {
        throw new SeasonLifecycleError(
          "corrected act and assignment belong to different seasons",
        );
      }
    }
    const fields = Object.keys(changes);
    const result = db
      .update(assignments)
      .set({
        ...changes,
        version: sql`${assignments.version} + 1`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(assignments.id, assignmentId),
          eq(assignments.version, expectedVersion),
        ),
      )
      .run();
    if (result.changes !== 1) conflict("assignment", assignmentId, fields);
    return getAssignment(assignmentId);
  }

  function listAssignments(seasonId: number): Assignment[] {
    return db
      .select()
      .from(assignments)
      .where(eq(assignments.seasonId, seasonId))
      .all();
  }

  function listAssignmentSuggestions(seasonId: number): AssignmentSuggestion[] {
    const assignedActIds = new Set(
      listAssignments(seasonId).map((assignment) => assignment.actId),
    );
    const candidates = db
      .select()
      .from(acts)
      .where(and(eq(acts.seasonId, seasonId), isNull(acts.canonicalActId)))
      .all()
      .filter((act) => !assignedActIds.has(act.id));
    const openSlots = db
      .select()
      .from(slots)
      .where(and(eq(slots.seasonId, seasonId), eq(slots.state, "open")))
      .all();
    return candidates.flatMap((act) =>
      openSlots.map((slot) => ({ act, slot })),
    );
  }

  function listEmailWaves(seasonId: number): EmailLogEntry[] {
    return db
      .select()
      .from(emailLog)
      .where(eq(emailLog.seasonId, seasonId))
      .all();
  }

  function listEmailWave(seasonId: number, waveLabel: string): EmailLogEntry[] {
    return db
      .select()
      .from(emailLog)
      .where(
        and(eq(emailLog.seasonId, seasonId), eq(emailLog.waveLabel, waveLabel)),
      )
      .all();
  }

  function findPriorSeasonContact(
    currentSeasonId: number,
    email: string,
  ): PriorSeasonContact | null {
    const currentSeason = getSeason(currentSeasonId);
    const match = db
      .select({ contact: contacts, sourceSeason: seasons })
      .from(contacts)
      .innerJoin(seasons, eq(contacts.seasonId, seasons.id))
      .where(
        and(
          ne(contacts.seasonId, currentSeasonId),
          lt(seasons.year, currentSeason.year),
          eq(contacts.email, email),
          isNull(contacts.canonicalContactId),
        ),
      )
      .orderBy(desc(seasons.year), desc(contacts.id))
      .limit(1)
      .get();
    return match ?? null;
  }

  return Object.freeze({
    getSeason,
    transitionSeason,
    holdSlot,
    listReleasableHolds,
    releaseSlotHold,
    assignSlot,
    correctAssignment,
    listActivityQueue: records.listActivityQueue,
    listAssignments,
    listAssignmentSuggestions,
    listEmailWaves,
    listEmailWave,
    findPriorSeasonContact,
  });
}
