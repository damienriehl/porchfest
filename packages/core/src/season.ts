import { and, desc, eq, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  createRecordRepository,
  type ActChanges,
  type ContactChanges,
  type VenueChanges,
} from "./records.js";
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
  type Venue,
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

  function getAct(id: number): Act {
    const act = db.select().from(acts).where(eq(acts.id, id)).get();
    if (!act) throw new SeasonLifecycleError(`act ${id} does not exist`);
    return act;
  }

  function getVenue(id: number): Venue {
    const venue = db.select().from(venues).where(eq(venues.id, id)).get();
    if (!venue) throw new SeasonLifecycleError(`venue ${id} does not exist`);
    return venue;
  }

  function getContact(id: number): Contact {
    const contact = db.select().from(contacts).where(eq(contacts.id, id)).get();
    if (!contact)
      throw new SeasonLifecycleError(`contact ${id} does not exist`);
    return contact;
  }

  function assertLegal(season: Season, action: SeasonAction): void {
    if (!isSeasonActionLegal(season.state, action)) {
      throw new SeasonActionError(season.state, action);
    }
  }

  function assertCorrectionLegal(seasonId: number): void {
    assertLegal(getSeason(seasonId), "correction");
  }

  function assertCanonicalActUnassigned(
    seasonId: number,
    actId: number,
    assignedActs: readonly { actId: number }[],
  ): void {
    const canonicalAct = records.resolveAct(actId).canonical;
    const canonicalActAlreadyAssigned = assignedActs.some(
      (assignment) =>
        records.resolveAct(assignment.actId).canonical.id === canonicalAct.id,
    );
    if (canonicalActAlreadyAssigned) {
      throw new SeasonLifecycleError(
        `canonical act ${canonicalAct.id} is already assigned in season ${seasonId}`,
      );
    }
  }

  function updateAct(
    id: number,
    expectedVersion: number,
    changes: ActChanges,
  ): Act {
    assertCorrectionLegal(getAct(id).seasonId);
    return records.updateAct(id, expectedVersion, changes);
  }

  function updateVenue(
    id: number,
    expectedVersion: number,
    changes: VenueChanges,
  ): Venue {
    assertCorrectionLegal(getVenue(id).seasonId);
    return records.updateVenue(id, expectedVersion, changes);
  }

  function updateContact(
    id: number,
    expectedVersion: number,
    changes: ContactChanges,
  ): Contact {
    assertCorrectionLegal(getContact(id).seasonId);
    return records.updateContact(id, expectedVersion, changes);
  }

  function promotePlaceholderAct(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Act {
    assertCorrectionLegal(getAct(placeholderId).seasonId);
    return records.promotePlaceholderAct(
      placeholderId,
      placeholderVersion,
      submissionId,
      submissionVersion,
    );
  }

  function promotePlaceholderVenue(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Venue {
    assertCorrectionLegal(getVenue(placeholderId).seasonId);
    return records.promotePlaceholderVenue(
      placeholderId,
      placeholderVersion,
      submissionId,
      submissionVersion,
    );
  }

  function supersedeAct(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Act {
    assertCorrectionLegal(getAct(id).seasonId);
    return records.supersedeAct(id, expectedVersion, canonicalId);
  }

  function supersedeVenue(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Venue {
    assertCorrectionLegal(getVenue(id).seasonId);
    return records.supersedeVenue(id, expectedVersion, canonicalId);
  }

  function supersedeContact(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Contact {
    assertCorrectionLegal(getContact(id).seasonId);
    return records.supersedeContact(id, expectedVersion, canonicalId);
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
        const fallback = tx
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

      const result = tx
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
      const held = tx.select().from(slots).where(eq(slots.id, slotId)).get();
      if (!held) throw new SeasonLifecycleError(`slot ${slotId} disappeared`);
      return held;
    });
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
      assertLegal(season, "hold_release");
      if (slot.state !== "held") {
        throw new SeasonLifecycleError(
          `slot ${slot.id} is ${slot.state}; hold_release requires a held slot`,
        );
      }
      const assignmentTargetVenueId = slot.fallbackVenueId;
      const result = tx
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
      const released = tx
        .select()
        .from(slots)
        .where(eq(slots.id, slotId))
        .get();
      if (!released)
        throw new SeasonLifecycleError(`slot ${slotId} disappeared`);
      return { slot: released, assignmentTargetVenueId };
    });
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
      const assignedActs = tx
        .select({ actId: assignments.actId })
        .from(assignments)
        .where(eq(assignments.seasonId, season.id))
        .all();
      assertCanonicalActUnassigned(season.id, actId, assignedActs);
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
    return db.transaction((tx) => {
      const assignment = tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .get();
      if (!assignment)
        throw new SeasonLifecycleError(
          `assignment ${assignmentId} does not exist`,
        );
      const season = tx
        .select()
        .from(seasons)
        .where(eq(seasons.id, assignment.seasonId))
        .get();
      if (!season)
        throw new SeasonLifecycleError(
          `season ${assignment.seasonId} does not exist`,
        );
      assertLegal(season, "correction");
      if (changes.actId !== undefined) {
        const act = tx
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
      const result = tx
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
      if (changes.actId !== undefined) {
        const assignedActs = tx
          .select({ actId: assignments.actId })
          .from(assignments)
          .where(
            and(
              eq(assignments.seasonId, assignment.seasonId),
              ne(assignments.id, assignmentId),
            ),
          )
          .all();
        assertCanonicalActUnassigned(season.id, changes.actId, assignedActs);
      }
      const corrected = tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .get();
      if (!corrected)
        throw new SeasonLifecycleError(
          `assignment ${assignmentId} disappeared`,
        );
      return corrected;
    });
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
      listAssignments(seasonId).map(
        (assignment) => records.resolveAct(assignment.actId).canonical.id,
      ),
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
    // Owner-settled 2026-08-22: deliberately reach past the immediately prior season.
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
    updateAct,
    updateVenue,
    updateContact,
    promotePlaceholderAct,
    promotePlaceholderVenue,
    supersedeAct,
    supersedeVenue,
    supersedeContact,
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
