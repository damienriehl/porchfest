import { and, desc, eq, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  createRecordRepository,
  RecordConflictError,
  type ActChanges,
  type ContactChanges,
  type CreatePlaceholderActInput,
  type CreatePlaceholderVenueInput,
  type HostSignup,
  type HostSignupInput,
  type PerformerSignup,
  type PerformerSignupInput,
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
  type RecordStatus,
  type Season,
  type Slot,
  type Venue,
} from "./storage/schema.js";
import * as schema from "./storage/schema.js";
import {
  type CoreDatabase,
  type CoreExecutor,
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
  "signup" | "assignment" | "hold" | "hold_release" | "correction";

const stateOrder: readonly SeasonState[] = schema.seasonStates;

const legalStates: Readonly<Record<SeasonAction, readonly SeasonState[]>> = {
  signup: ["signups_open", "assigning"],
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
  db: CoreExecutor,
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

  function getSeason(id: number, executor: CoreExecutor = db): Season {
    const season = executor
      .select()
      .from(seasons)
      .where(eq(seasons.id, id))
      .get();
    if (!season) throw new SeasonLifecycleError(`season ${id} does not exist`);
    return season;
  }

  function getAct(id: number, executor: CoreExecutor = db): Act {
    const act = executor.select().from(acts).where(eq(acts.id, id)).get();
    if (!act) throw new SeasonLifecycleError(`act ${id} does not exist`);
    return act;
  }

  function getVenue(id: number, executor: CoreExecutor = db): Venue {
    const venue = executor.select().from(venues).where(eq(venues.id, id)).get();
    if (!venue) throw new SeasonLifecycleError(`venue ${id} does not exist`);
    return venue;
  }

  function getContact(id: number, executor: CoreExecutor = db): Contact {
    const contact = executor
      .select()
      .from(contacts)
      .where(eq(contacts.id, id))
      .get();
    if (!contact)
      throw new SeasonLifecycleError(`contact ${id} does not exist`);
    return contact;
  }

  function assertLegal(season: Season, action: SeasonAction): void {
    if (!isSeasonActionLegal(season.state, action)) {
      throw new SeasonActionError(season.state, action);
    }
  }

  function assertCorrectionLegal(
    seasonId: number,
    executor: CoreExecutor = db,
  ): void {
    assertLegal(getSeason(seasonId, executor), "correction");
  }

  function createHostSignup(input: HostSignupInput): HostSignup {
    return db.transaction(
      (tx) => {
        assertLegal(getSeason(input.seasonId, tx), "signup");
        return createRecordRepository(tx, options).createHostSignup(input);
      },
      { behavior: "immediate" },
    );
  }

  function createPerformerSignup(input: PerformerSignupInput): PerformerSignup {
    return db.transaction(
      (tx) => {
        assertLegal(getSeason(input.seasonId, tx), "signup");
        return createRecordRepository(tx, options).createPerformerSignup(input);
      },
      { behavior: "immediate" },
    );
  }

  function createPlaceholderAct(input: CreatePlaceholderActInput): Act {
    // Organizer-created records are corrections, not participant signups. Keep
    // the legality check and both contact/record writes in one immediate unit.
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(input.seasonId, tx);
        return createRecordRepository(tx, options).createPlaceholderAct(input);
      },
      { behavior: "immediate" },
    );
  }

  function createPlaceholderVenue(input: CreatePlaceholderVenueInput): Venue {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(input.seasonId, tx);
        return createRecordRepository(tx, options).createPlaceholderVenue(
          input,
        );
      },
      { behavior: "immediate" },
    );
  }

  /**
   * R6: set an organizer-decided status on an act or venue.
   *
   * AE2 is the reason this is not a plain column write. Withdrawing an act must
   * reopen the slot it held, so the evening does not keep a booked slot for an
   * act that is not coming — and it must leave the email history alone, because
   * "we already wrote to them" stays true whatever happens next. Both halves
   * live in one transaction so a withdrawal cannot half-happen.
   */
  function setRecordStatus(
    recordType: "act" | "venue",
    id: number,
    expectedVersion: number,
    status: RecordStatus,
  ): { readonly reopenedSlotIds: readonly number[] } {
    return db.transaction(
      (tx) => {
        const table = recordType === "act" ? acts : venues;
        const stamp = now();
        const result = tx
          .update(table)
          .set({
            status,
            version: sql`${table.version} + 1`,
            updatedAt: stamp,
          })
          .where(and(eq(table.id, id), eq(table.version, expectedVersion)))
          .run();
        // KTD7: the predicate is inside the statement and the verdict is the
        // affected-row count.
        if (result.changes !== 1) {
          throw new RecordConflictError(recordType, id, ["status"]);
        }

        if (status !== "withdrawn") return { reopenedSlotIds: [] };

        const affected =
          recordType === "act"
            ? tx
                .select()
                .from(assignments)
                .where(eq(assignments.actId, id))
                .all()
            : tx
                .select({
                  id: assignments.id,
                  seasonId: assignments.seasonId,
                  actId: assignments.actId,
                  slotId: assignments.slotId,
                })
                .from(assignments)
                .innerJoin(slots, eq(slots.id, assignments.slotId))
                .where(eq(slots.venueId, id))
                .all();

        const reopenedSlotIds: number[] = [];
        for (const assignment of affected) {
          tx.delete(assignments).where(eq(assignments.id, assignment.id)).run();
          tx.update(slots)
            .set({
              state: "open",
              version: sql`${slots.version} + 1`,
              updatedAt: stamp,
            })
            .where(eq(slots.id, assignment.slotId))
            .run();
          reopenedSlotIds.push(assignment.slotId);
        }
        // email_log is deliberately untouched: the send history is immutable.
        return { reopenedSlotIds };
      },
      { behavior: "immediate" },
    );
  }

  type SeasonActIdentity = Pick<Act, "id" | "canonicalActId">;

  function resolveCanonicalSeasonAct(
    actId: number,
    seasonActsById: ReadonlyMap<number, SeasonActIdentity>,
    executor: CoreExecutor,
  ): SeasonActIdentity {
    let canonical = seasonActsById.get(actId) ?? getAct(actId, executor);
    const seen = new Set<number>();
    while (canonical.canonicalActId !== null) {
      if (seen.has(canonical.id)) {
        throw new SeasonLifecycleError(`act ${actId} has a supersession cycle`);
      }
      seen.add(canonical.id);
      canonical =
        seasonActsById.get(canonical.canonicalActId) ??
        getAct(canonical.canonicalActId, executor);
    }
    return canonical;
  }

  function assertCanonicalActUnassigned(
    seasonId: number,
    actId: number,
    assignedActs: readonly { actId: number }[],
    seasonActsById: ReadonlyMap<number, SeasonActIdentity>,
    executor: CoreExecutor,
  ): void {
    const canonicalAct = resolveCanonicalSeasonAct(
      actId,
      seasonActsById,
      executor,
    );
    const canonicalActAlreadyAssigned = assignedActs.some(
      (assignment) =>
        resolveCanonicalSeasonAct(assignment.actId, seasonActsById, executor)
          .id === canonicalAct.id,
    );
    if (canonicalActAlreadyAssigned) {
      throw new SeasonLifecycleError(
        `canonical act ${canonicalAct.id} is already assigned in season ${seasonId}`,
      );
    }
  }

  function assertActFamilyMergeLegal(
    reader: Pick<CoreDatabase, "select">,
    seasonId: number,
    sourceActId: number,
    targetActId: number,
    collisionMessage: (canonicalTargetId: number) => string,
  ): void {
    const seasonActs = reader
      .select({ id: acts.id, canonicalActId: acts.canonicalActId })
      .from(acts)
      .where(eq(acts.seasonId, seasonId))
      .all();
    const canonicalActIdById = new Map(
      seasonActs.map((act) => [act.id, act.canonicalActId]),
    );
    const assignedActs = reader
      .select({ actId: assignments.actId })
      .from(assignments)
      .where(eq(assignments.seasonId, seasonId))
      .all();

    let canonicalTargetId = targetActId;
    const targetSeen = new Set<number>();
    while (true) {
      if (targetSeen.has(canonicalTargetId)) {
        throw new SeasonLifecycleError(
          `act ${targetActId} has a supersession cycle`,
        );
      }
      targetSeen.add(canonicalTargetId);
      const nextTargetId = canonicalActIdById.get(canonicalTargetId);
      if (nextTargetId === undefined) {
        throw new SeasonLifecycleError(
          `act ${canonicalTargetId} does not exist`,
        );
      }
      if (nextTargetId === null) break;
      canonicalTargetId = nextTargetId;
    }

    const resolvesToTarget = (actId: number, applyMerge: boolean): boolean => {
      let currentId = actId;
      const assignedSeen = new Set<number>();
      while (currentId !== canonicalTargetId) {
        if (assignedSeen.has(currentId)) {
          throw new SeasonLifecycleError(
            `act ${actId} has a supersession cycle`,
          );
        }
        assignedSeen.add(currentId);
        const nextId =
          applyMerge && currentId === sourceActId
            ? canonicalTargetId
            : canonicalActIdById.get(currentId);
        if (nextId === undefined) {
          throw new SeasonLifecycleError(`act ${currentId} does not exist`);
        }
        if (nextId === null) return false;
        currentId = nextId;
      }
      return true;
    };
    const currentTargetAssignments = assignedActs.filter((assignment) =>
      resolvesToTarget(assignment.actId, false),
    ).length;
    const mergedTargetAssignments = assignedActs.filter((assignment) =>
      resolvesToTarget(assignment.actId, true),
    ).length;
    if (
      mergedTargetAssignments > 1 &&
      mergedTargetAssignments > currentTargetAssignments
    ) {
      throw new SeasonLifecycleError(collisionMessage(canonicalTargetId));
    }
  }

  function updateAct(
    id: number,
    expectedVersion: number,
    changes: ActChanges,
  ): Act {
    return db.transaction(
      (tx) => {
        const act = getAct(id, tx);
        assertCorrectionLegal(act.seasonId, tx);
        if (
          changes.reachViaContactId !== undefined &&
          changes.reachViaContactId !== null
        ) {
          const contact = getContact(changes.reachViaContactId, tx);
          if (contact.seasonId !== act.seasonId) {
            throw new SeasonLifecycleError(
              "reach-via contact and act belong to different seasons",
            );
          }
        }
        return createRecordRepository(tx, options).updateAct(
          id,
          expectedVersion,
          changes,
        );
      },
      { behavior: "immediate" },
    );
  }

  function updateVenue(
    id: number,
    expectedVersion: number,
    changes: VenueChanges,
  ): Venue {
    return db.transaction(
      (tx) => {
        const venue = getVenue(id, tx);
        assertCorrectionLegal(venue.seasonId, tx);
        if (
          changes.hostContactId !== undefined &&
          changes.hostContactId !== null
        ) {
          const contact = getContact(changes.hostContactId, tx);
          if (contact.seasonId !== venue.seasonId) {
            throw new SeasonLifecycleError(
              "host contact and venue belong to different seasons",
            );
          }
        }
        if (
          changes.reachViaContactId !== undefined &&
          changes.reachViaContactId !== null
        ) {
          const contact = getContact(changes.reachViaContactId, tx);
          if (contact.seasonId !== venue.seasonId) {
            throw new SeasonLifecycleError(
              "reach-via contact and venue belong to different seasons",
            );
          }
        }
        return createRecordRepository(tx, options).updateVenue(
          id,
          expectedVersion,
          changes,
        );
      },
      { behavior: "immediate" },
    );
  }

  function updateContact(
    id: number,
    expectedVersion: number,
    changes: ContactChanges,
  ): Contact {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(getContact(id, tx).seasonId, tx);
        return createRecordRepository(tx, options).updateContact(
          id,
          expectedVersion,
          changes,
        );
      },
      { behavior: "immediate" },
    );
  }

  function promotePlaceholderAct(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Act {
    return db.transaction(
      (tx) => {
        const placeholder = getAct(placeholderId, tx);
        assertCorrectionLegal(placeholder.seasonId, tx);
        const submission = getAct(submissionId, tx);
        if (
          placeholder.placeholder &&
          !submission.placeholder &&
          placeholder.seasonId === submission.seasonId &&
          placeholder.canonicalActId === null &&
          submission.canonicalActId === null
        ) {
          assertActFamilyMergeLegal(
            tx,
            placeholder.seasonId,
            submission.id,
            placeholder.id,
            () => "act promotion would merge assignments",
          );
        }
        return createRecordRepository(tx, options).promotePlaceholderAct(
          placeholderId,
          placeholderVersion,
          submissionId,
          submissionVersion,
        );
      },
      { behavior: "immediate" },
    );
  }

  function promotePlaceholderVenue(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Venue {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(getVenue(placeholderId, tx).seasonId, tx);
        return createRecordRepository(tx, options).promotePlaceholderVenue(
          placeholderId,
          placeholderVersion,
          submissionId,
          submissionVersion,
        );
      },
      { behavior: "immediate" },
    );
  }

  function supersedeAct(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Act {
    return db.transaction(
      (tx) => {
        const source = getAct(id, tx);
        assertCorrectionLegal(source.seasonId, tx);
        const target = getAct(canonicalId, tx);
        if (source.seasonId === target.seasonId && source.id !== target.id) {
          assertActFamilyMergeLegal(
            tx,
            source.seasonId,
            source.id,
            target.id,
            (canonicalTargetId) =>
              `canonical act ${canonicalTargetId} is already assigned in season ${source.seasonId}`,
          );
        }
        return createRecordRepository(tx, options).supersedeAct(
          id,
          expectedVersion,
          canonicalId,
        );
      },
      { behavior: "immediate" },
    );
  }

  function supersedeVenue(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Venue {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(getVenue(id, tx).seasonId, tx);
        return createRecordRepository(tx, options).supersedeVenue(
          id,
          expectedVersion,
          canonicalId,
        );
      },
      { behavior: "immediate" },
    );
  }

  function supersedeContact(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Contact {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(getContact(id, tx).seasonId, tx);
        return createRecordRepository(tx, options).supersedeContact(
          id,
          expectedVersion,
          canonicalId,
        );
      },
      { behavior: "immediate" },
    );
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
      const seasonActs = tx
        .select({ id: acts.id, canonicalActId: acts.canonicalActId })
        .from(acts)
        .where(eq(acts.seasonId, season.id))
        .all();
      const seasonActsById = new Map(
        seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
      );
      assertCanonicalActUnassigned(
        season.id,
        actId,
        assignedActs,
        seasonActsById,
        tx,
      );
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
        const seasonActs = tx
          .select({ id: acts.id, canonicalActId: acts.canonicalActId })
          .from(acts)
          .where(eq(acts.seasonId, season.id))
          .all();
        const seasonActsById = new Map(
          seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
        );
        assertCanonicalActUnassigned(
          season.id,
          changes.actId,
          assignedActs,
          seasonActsById,
          tx,
        );
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
    setRecordStatus,
    createHostSignup,
    createPerformerSignup,
    createPlaceholderAct,
    createPlaceholderVenue,
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
