import { and, asc, desc, eq, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  formatZonedWindow,
  overlaps,
  suggestionsForVenue,
  type MatchingInput,
  type RankedPairing,
} from "./matching.js";
import { applyContactAddressChange } from "./outbox.js";
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
  actAvailabilities,
  actLinks,
  assignments,
  contacts,
  emailLog,
  seasons,
  seasonTimeSlots,
  slots,
  venues,
  type Act,
  type ActLink,
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
  "season" | "slot" | "assignment" | "act_link"
> {
  constructor(
    recordType: "season" | "slot" | "assignment" | "act_link",
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

export type AssignmentConflictKind =
  | "slot_filled"
  | "slot_held"
  | "act_already_assigned"
  | "act_withdrawn"
  | "shared_member";

export class AssignmentConflictError extends SeasonLifecycleError {
  readonly kind: AssignmentConflictKind;

  constructor(kind: AssignmentConflictKind, message: string) {
    super(message);
    this.name = "AssignmentConflictError";
    this.kind = kind;
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
    recordType: "season" | "slot" | "assignment" | "act_link",
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

  function getSlot(id: number, executor: CoreExecutor = db): Slot {
    const slot = executor.select().from(slots).where(eq(slots.id, id)).get();
    if (!slot) throw new SeasonLifecycleError(`slot ${id} does not exist`);
    return slot;
  }

  function getAssignment(id: number, executor: CoreExecutor = db): Assignment {
    const assignment = executor
      .select()
      .from(assignments)
      .where(eq(assignments.id, id))
      .get();
    if (!assignment)
      throw new SeasonLifecycleError(`assignment ${id} does not exist`);
    return assignment;
  }

  function getActLink(id: number, executor: CoreExecutor = db): ActLink {
    const link = executor
      .select()
      .from(actLinks)
      .where(eq(actLinks.id, id))
      .get();
    if (!link) throw new SeasonLifecycleError(`act link ${id} does not exist`);
    return link;
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

  function materializeVenueSlots(venue: Venue, executor: CoreExecutor): Slot[] {
    const templates = executor
      .select()
      .from(seasonTimeSlots)
      .where(eq(seasonTimeSlots.seasonId, venue.seasonId))
      .orderBy(asc(seasonTimeSlots.startsAt), asc(seasonTimeSlots.id))
      .all();
    const existing = executor
      .select()
      .from(slots)
      .where(
        and(eq(slots.seasonId, venue.seasonId), eq(slots.venueId, venue.id)),
      )
      .all();
    const existingWindows = new Set(
      existing.map(
        (slot) => `${slot.startsAt.getTime()}:${slot.endsAt.getTime()}`,
      ),
    );
    for (const template of templates) {
      const windowKey = `${template.startsAt.getTime()}:${template.endsAt.getTime()}`;
      if (existingWindows.has(windowKey)) continue;
      executor
        .insert(slots)
        .values({
          seasonId: venue.seasonId,
          venueId: venue.id,
          startsAt: template.startsAt,
          endsAt: template.endsAt,
          state: "open",
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      existingWindows.add(windowKey);
    }
    return executor
      .select()
      .from(slots)
      .where(
        and(eq(slots.seasonId, venue.seasonId), eq(slots.venueId, venue.id)),
      )
      .orderBy(asc(slots.startsAt), asc(slots.id))
      .all();
  }

  function createHostSignup(input: HostSignupInput): HostSignup {
    return db.transaction(
      (tx) => {
        assertLegal(getSeason(input.seasonId, tx), "signup");
        const signup = createRecordRepository(tx, options).createHostSignup(
          input,
        );
        materializeVenueSlots(signup.venue, tx);
        return signup;
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
        const venue = createRecordRepository(
          tx,
          options,
        ).createPlaceholderVenue(input);
        materializeVenueSlots(venue, tx);
        return venue;
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
        // Status changes can release schedule assignments, so archival must
        // refuse them before either the record or its slots are touched.
        // This existence read also means a missing row raises a lifecycle
        // error, not the conflict error returned by the versioned update.
        const record = recordType === "act" ? getAct(id, tx) : getVenue(id, tx);
        assertCorrectionLegal(record.seasonId, tx);
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
            ? (() => {
                const seasonActs = tx
                  .select({ id: acts.id, canonicalActId: acts.canonicalActId })
                  .from(acts)
                  .where(eq(acts.seasonId, record.seasonId))
                  .all();
                const seasonActsById = new Map(
                  seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
                );
                const canonicalId = resolveCanonicalSeasonAct(
                  id,
                  seasonActsById,
                  tx,
                ).id;
                return tx
                  .select()
                  .from(assignments)
                  .where(eq(assignments.seasonId, record.seasonId))
                  .all()
                  .filter(
                    (assignment) =>
                      resolveCanonicalSeasonAct(
                        assignment.actId,
                        seasonActsById,
                        tx,
                      ).id === canonicalId,
                  );
              })()
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
        const before = getContact(id, tx);
        assertCorrectionLegal(before.seasonId, tx);
        const contact = createRecordRepository(tx, options).updateContact(
          id,
          expectedVersion,
          changes,
        );
        // KTD6/AE9: a corrected address is the one contact edit that reaches
        // into the outbox. The person at the new address has not been written
        // to, so their send state is cleared here, inside the same transaction
        // as the correction, rather than by a sweep that could miss it.
        if (
          changes.email !== undefined &&
          (before.email ?? "") !== (contact.email ?? "")
        ) {
          applyContactAddressChange(
            tx,
            {
              contactId: id,
              previousAddress: before.email,
              newAddress: contact.email,
            },
            now,
          );
        }
        return contact;
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
        const source = getVenue(id, tx);
        assertCorrectionLegal(source.seasonId, tx);
        const assignmentCount = tx
          .select({ id: assignments.id })
          .from(assignments)
          .innerJoin(slots, eq(slots.id, assignments.slotId))
          .where(
            and(
              eq(slots.seasonId, source.seasonId),
              eq(slots.venueId, source.id),
            ),
          )
          .all().length;
        const holdCount = tx
          .select({ id: slots.id })
          .from(slots)
          .where(
            and(
              eq(slots.seasonId, source.seasonId),
              eq(slots.venueId, source.id),
              eq(slots.state, "held"),
            ),
          )
          .all().length;
        if (assignmentCount > 0 || holdCount > 0) {
          throw new SeasonLifecycleError(
            `Unassign ${assignmentCount} ${assignmentCount === 1 ? "act" : "acts"} and release ${holdCount} ${holdCount === 1 ? "hold" : "holds"} before superseding this venue`,
          );
        }
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
    return db.transaction((tx) => {
      const season = getSeason(seasonId, tx);
      const currentIndex = stateOrder.indexOf(season.state);
      const targetIndex = stateOrder.indexOf(targetState);
      const action = `transition_to_${targetState}`;
      if (targetIndex <= currentIndex) {
        throw new SeasonActionError(season.state, action);
      }
      if (targetState === "archived") {
        const heldCount = tx
          .select({ id: slots.id })
          .from(slots)
          .where(and(eq(slots.seasonId, seasonId), eq(slots.state, "held")))
          .all().length;
        if (heldCount > 0) {
          throw new SeasonLifecycleError(
            heldCount === 1
              ? "1 slot is still held; release it before archiving"
              : `${heldCount} slots are still held; release them before archiving`,
          );
        }
      }

      const result = tx
        .update(seasons)
        .set({
          state: targetState,
          mapPublishedAt:
            targetState === "archived" ? null : season.mapPublishedAt,
          version: sql`${seasons.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(eq(seasons.id, seasonId), eq(seasons.version, expectedVersion)),
        )
        .run();
      if (result.changes !== 1) conflict("season", seasonId, ["state"]);
      return getSeason(seasonId, tx);
    });
  }

  function setSeasonMapPublication(
    seasonId: number,
    actor: number | null,
    expectedVersion: number,
    published: boolean,
  ): Season {
    void actor;
    return db.transaction(
      (tx) => {
        const season = getSeason(seasonId, tx);
        if (season.state !== "locked") {
          throw new SeasonActionError(
            season.state,
            published ? "map_publish" : "map_unpublish",
          );
        }
        const result = tx
          .update(seasons)
          .set({
            mapPublishedAt: published ? now() : null,
            version: sql`${seasons.version} + 1`,
            updatedAt: now(),
          })
          .where(
            and(eq(seasons.id, seasonId), eq(seasons.version, expectedVersion)),
          )
          .run();
        if (result.changes !== 1) {
          conflict("season", seasonId, ["mapPublishedAt"]);
        }
        return getSeason(seasonId, tx);
      },
      { behavior: "immediate" },
    );
  }

  function publishSeasonMap(
    seasonId: number,
    actor: number | null,
    expectedVersion: number,
  ): Season {
    return setSeasonMapPublication(seasonId, actor, expectedVersion, true);
  }

  function unpublishSeasonMap(
    seasonId: number,
    actor: number | null,
    expectedVersion: number,
  ): Season {
    return setSeasonMapPublication(seasonId, actor, expectedVersion, false);
  }

  function ensureVenueSlots(venueId: number): Slot[] {
    return db.transaction(
      (tx) => {
        const venue = getVenue(venueId, tx);
        assertCorrectionLegal(venue.seasonId, tx);
        return materializeVenueSlots(venue, tx);
      },
      { behavior: "immediate" },
    );
  }

  function listVenueSlots(venueId: number): Slot[] {
    const venue = getVenue(venueId);
    return db
      .select()
      .from(slots)
      .where(
        and(eq(slots.seasonId, venue.seasonId), eq(slots.venueId, venueId)),
      )
      .orderBy(asc(slots.startsAt), asc(slots.id))
      .all();
  }

  function listSeasonSlots(seasonId: number): Slot[] {
    getSeason(seasonId);
    return db
      .select()
      .from(slots)
      .where(eq(slots.seasonId, seasonId))
      .orderBy(asc(slots.startsAt), asc(slots.id))
      .all();
  }

  function listSeasonVenues(seasonId: number): Venue[] {
    getSeason(seasonId);
    return db
      .select()
      .from(venues)
      .where(eq(venues.seasonId, seasonId))
      .orderBy(asc(venues.id))
      .all();
  }

  function linkActs(input: {
    seasonId: number;
    actId: number;
    linkedActId: number;
    note?: string | null;
  }): ActLink {
    return db.transaction(
      (tx) => {
        assertCorrectionLegal(input.seasonId, tx);
        const first = getAct(input.actId, tx);
        const second = getAct(input.linkedActId, tx);
        if (
          first.seasonId !== input.seasonId ||
          second.seasonId !== input.seasonId
        ) {
          throw new SeasonLifecycleError(
            "linked acts must belong to the same season",
          );
        }
        const seasonActs = tx
          .select({ id: acts.id, canonicalActId: acts.canonicalActId })
          .from(acts)
          .where(eq(acts.seasonId, input.seasonId))
          .all();
        const seasonActsById = new Map(
          seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
        );
        const canonicalFirst = resolveCanonicalSeasonAct(
          first.id,
          seasonActsById,
          tx,
        ).id;
        const canonicalSecond = resolveCanonicalSeasonAct(
          second.id,
          seasonActsById,
          tx,
        ).id;
        if (canonicalFirst === canonicalSecond) {
          throw new SeasonLifecycleError("an act cannot be linked to itself");
        }
        const actId = Math.min(canonicalFirst, canonicalSecond);
        const linkedActId = Math.max(canonicalFirst, canonicalSecond);
        const duplicate = tx
          .select()
          .from(actLinks)
          .where(eq(actLinks.seasonId, input.seasonId))
          .all()
          .find((link) => {
            const firstEndpoint = resolveCanonicalSeasonAct(
              link.actId,
              seasonActsById,
              tx,
            ).id;
            const secondEndpoint = resolveCanonicalSeasonAct(
              link.linkedActId,
              seasonActsById,
              tx,
            ).id;
            return (
              Math.min(firstEndpoint, secondEndpoint) === actId &&
              Math.max(firstEndpoint, secondEndpoint) === linkedActId
            );
          });
        if (duplicate) {
          throw new SeasonLifecycleError(
            `acts ${actId} and ${linkedActId} are already linked`,
          );
        }
        return tx
          .insert(actLinks)
          .values({
            seasonId: input.seasonId,
            actId,
            linkedActId,
            note: input.note ?? null,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning()
          .get();
      },
      { behavior: "immediate" },
    );
  }

  function unlinkActs(linkId: number, expectedVersion: number): void {
    db.transaction(
      (tx) => {
        const link = tx
          .select()
          .from(actLinks)
          .where(eq(actLinks.id, linkId))
          .get();
        if (!link) {
          throw new SeasonLifecycleError(`act link ${linkId} does not exist`);
        }
        assertCorrectionLegal(link.seasonId, tx);
        const result = tx
          .delete(actLinks)
          .where(
            and(eq(actLinks.id, linkId), eq(actLinks.version, expectedVersion)),
          )
          .run();
        if (result.changes !== 1) conflict("act_link", linkId, ["link"]);
      },
      { behavior: "immediate" },
    );
  }

  function listActLinks(seasonId: number): ActLink[] {
    return db
      .select()
      .from(actLinks)
      .where(eq(actLinks.seasonId, seasonId))
      .orderBy(asc(actLinks.actId), asc(actLinks.linkedActId))
      .all();
  }

  function listActLinksForAct(actId: number): ActLink[] {
    const act = getAct(actId);
    const seasonActs = db
      .select({ id: acts.id, canonicalActId: acts.canonicalActId })
      .from(acts)
      .where(eq(acts.seasonId, act.seasonId))
      .all();
    const seasonActsById = new Map(
      seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
    );
    const canonicalActId = resolveCanonicalSeasonAct(
      act.id,
      seasonActsById,
      db,
    ).id;
    return listActLinks(act.seasonId).filter((link) => {
      const firstEndpoint = resolveCanonicalSeasonAct(
        link.actId,
        seasonActsById,
        db,
      ).id;
      const secondEndpoint = resolveCanonicalSeasonAct(
        link.linkedActId,
        seasonActsById,
        db,
      ).id;
      return (
        firstEndpoint === canonicalActId || secondEndpoint === canonicalActId
      );
    });
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
    options: { sharedMemberOverride?: string | null } = {},
  ): Assignment {
    return db.transaction(
      (tx) => {
        const slot = tx.select().from(slots).where(eq(slots.id, slotId)).get();
        if (!slot)
          throw new SeasonLifecycleError(`slot ${slotId} does not exist`);
        const season = getSeason(slot.seasonId, tx);
        assertLegal(season, "assignment");
        const act = getAct(actId, tx);
        if (act.seasonId !== slot.seasonId) {
          throw new SeasonLifecycleError(
            "act and slot belong to different seasons",
          );
        }
        if (act.status === "withdrawn") {
          throw new AssignmentConflictError(
            "act_withdrawn",
            `${act.name} have withdrawn and cannot be assigned`,
          );
        }

        const slotVenue = getVenue(slot.venueId, tx);
        if (slot.state === "held") {
          throw new AssignmentConflictError(
            "slot_held",
            `Slot is held for ${slot.heldForName ?? "an unnamed act"} until ${slot.heldDecideBy?.toISOString().slice(0, 10) ?? "an unspecified date"}`,
          );
        }
        if (slot.state === "assigned") {
          const occupying = tx
            .select()
            .from(assignments)
            .where(eq(assignments.slotId, slot.id))
            .get();
          const occupyingAct =
            occupying === undefined ? null : getAct(occupying.actId, tx);
          throw new AssignmentConflictError(
            "slot_filled",
            `Slot at ${slotVenue.title}, ${formatZonedWindow(slot, season.timezone)} is already filled${occupyingAct === null ? "" : ` by ${occupyingAct.name}`}`,
          );
        }

        const seasonActs = tx
          .select()
          .from(acts)
          .where(eq(acts.seasonId, season.id))
          .all();
        const seasonActsById = new Map(
          seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
        );
        const canonicalAct = resolveCanonicalSeasonAct(
          actId,
          seasonActsById,
          tx,
        );
        const canonicalRecord = getAct(canonicalAct.id, tx);
        if (canonicalRecord.status === "withdrawn") {
          throw new AssignmentConflictError(
            "act_withdrawn",
            `${canonicalRecord.name} have withdrawn and cannot be assigned`,
          );
        }
        const seasonAssignments = tx
          .select()
          .from(assignments)
          .where(eq(assignments.seasonId, season.id))
          .all();
        const canonicalAssignmentActIds = new Map(
          seasonAssignments.map((assignment) => [
            assignment.id,
            resolveCanonicalSeasonAct(assignment.actId, seasonActsById, tx).id,
          ]),
        );
        const assignedConflict = seasonAssignments.find(
          (assignment) =>
            canonicalAssignmentActIds.get(assignment.id) === canonicalAct.id,
        );
        if (assignedConflict !== undefined) {
          const conflictingSlot = tx
            .select()
            .from(slots)
            .where(eq(slots.id, assignedConflict.slotId))
            .get();
          if (!conflictingSlot) {
            throw new SeasonLifecycleError(
              `slot ${assignedConflict.slotId} does not exist`,
            );
          }
          const conflictingVenue = getVenue(conflictingSlot.venueId, tx);
          throw new AssignmentConflictError(
            "act_already_assigned",
            `${canonicalRecord.name} are already assigned to ${conflictingVenue.title}, ${formatZonedWindow(conflictingSlot, season.timezone)}`,
          );
        }

        const linkedCanonicalIds = new Set<number>();
        for (const link of tx
          .select()
          .from(actLinks)
          .where(eq(actLinks.seasonId, season.id))
          .all()) {
          const first = resolveCanonicalSeasonAct(
            link.actId,
            seasonActsById,
            tx,
          ).id;
          const second = resolveCanonicalSeasonAct(
            link.linkedActId,
            seasonActsById,
            tx,
          ).id;
          if (first === canonicalAct.id) linkedCanonicalIds.add(second);
          if (second === canonicalAct.id) linkedCanonicalIds.add(first);
        }
        const seasonSlotsById = new Map(
          tx
            .select()
            .from(slots)
            .where(eq(slots.seasonId, season.id))
            .all()
            .map((seasonSlot) => [seasonSlot.id, seasonSlot]),
        );
        const sharedMemberConflict = seasonAssignments.find((assignment) => {
          const assignedCanonical = canonicalAssignmentActIds.get(
            assignment.id,
          );
          if (assignedCanonical === undefined) return false;
          if (!linkedCanonicalIds.has(assignedCanonical)) return false;
          const assignedSlot = seasonSlotsById.get(assignment.slotId);
          return assignedSlot !== undefined && overlaps(assignedSlot, slot);
        });
        const override = options.sharedMemberOverride?.trim() ?? "";
        if (sharedMemberConflict !== undefined && override.length === 0) {
          const conflictingSlot = seasonSlotsById.get(
            sharedMemberConflict.slotId,
          );
          if (!conflictingSlot) {
            throw new SeasonLifecycleError(
              `slot ${sharedMemberConflict.slotId} does not exist`,
            );
          }
          const conflictingCanonicalId = canonicalAssignmentActIds.get(
            sharedMemberConflict.id,
          );
          if (conflictingCanonicalId === undefined) {
            throw new SeasonLifecycleError(
              `act ${sharedMemberConflict.actId} does not exist`,
            );
          }
          const conflictingAct = getAct(conflictingCanonicalId, tx);
          const conflictingVenue = getVenue(conflictingSlot.venueId, tx);
          throw new AssignmentConflictError(
            "shared_member",
            `${conflictingAct.name} shares a member and is already assigned to ${conflictingVenue.title}, ${formatZonedWindow(conflictingSlot, season.timezone)}; record an organizer override to continue`,
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
          .values({
            seasonId: slot.seasonId,
            actId: canonicalAct.id,
            slotId,
            sharedMemberOverride: override.length === 0 ? null : override,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning()
          .get();
      },
      { behavior: "immediate" },
    );
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
      let canonicalActId: number | undefined;
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
        const seasonActs = tx
          .select({ id: acts.id, canonicalActId: acts.canonicalActId })
          .from(acts)
          .where(eq(acts.seasonId, season.id))
          .all();
        const seasonActsById = new Map(
          seasonActs.map((seasonAct) => [seasonAct.id, seasonAct]),
        );
        canonicalActId = resolveCanonicalSeasonAct(
          changes.actId,
          seasonActsById,
          tx,
        ).id;
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
        assertCanonicalActUnassigned(
          season.id,
          canonicalActId,
          assignedActs,
          seasonActsById,
          tx,
        );
      }
      const fields = Object.keys(changes);
      const correctedChanges =
        canonicalActId === undefined
          ? changes
          : { ...changes, actId: canonicalActId };
      const result = tx
        .update(assignments)
        .set({
          ...correctedChanges,
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

  function unassignSlot(assignmentId: number, expectedVersion: number): Slot {
    return db.transaction(
      (tx) => {
        const assignment = tx
          .select()
          .from(assignments)
          .where(eq(assignments.id, assignmentId))
          .get();
        if (!assignment) {
          throw new SeasonLifecycleError(
            `assignment ${assignmentId} does not exist`,
          );
        }
        assertLegal(getSeason(assignment.seasonId, tx), "assignment");
        const slot = tx
          .select()
          .from(slots)
          .where(eq(slots.id, assignment.slotId))
          .get();
        if (!slot) {
          throw new SeasonLifecycleError(
            `slot ${assignment.slotId} does not exist`,
          );
        }
        const deleted = tx
          .delete(assignments)
          .where(
            and(
              eq(assignments.id, assignmentId),
              eq(assignments.version, expectedVersion),
            ),
          )
          .run();
        if (deleted.changes !== 1) {
          conflict("assignment", assignmentId, ["unassignment"]);
        }
        const reopened = tx
          .update(slots)
          .set({
            state: "open",
            version: sql`${slots.version} + 1`,
            updatedAt: now(),
          })
          .where(and(eq(slots.id, slot.id), eq(slots.version, slot.version)))
          .run();
        if (reopened.changes !== 1) conflict("slot", slot.id, ["state"]);
        const result = tx
          .select()
          .from(slots)
          .where(eq(slots.id, slot.id))
          .get();
        if (!result) {
          throw new SeasonLifecycleError(`slot ${slot.id} disappeared`);
        }
        return result;
      },
      { behavior: "immediate" },
    );
  }

  function listAssignments(seasonId: number): Assignment[] {
    return db
      .select()
      .from(assignments)
      .where(eq(assignments.seasonId, seasonId))
      .all();
  }

  function buildMatchingInput(seasonId: number): MatchingInput {
    const season = getSeason(seasonId);
    const seasonActs = db
      .select()
      .from(acts)
      .where(eq(acts.seasonId, seasonId))
      .all();
    const actsById = new Map(seasonActs.map((act) => [act.id, act]));
    const canonicalId = (actId: number): number =>
      resolveCanonicalSeasonAct(actId, actsById, db).id;
    const candidateActs = seasonActs.filter(
      (act) => act.canonicalActId === null && act.status !== "withdrawn",
    );
    const availabilityRows = db
      .select()
      .from(actAvailabilities)
      .where(eq(actAvailabilities.seasonId, seasonId))
      .all();
    const linkedIdsByAct = new Map<number, Set<number>>(
      candidateActs.map((act) => [act.id, new Set<number>()]),
    );
    for (const link of listActLinks(seasonId)) {
      const first = canonicalId(link.actId);
      const second = canonicalId(link.linkedActId);
      if (first === second) continue;
      linkedIdsByAct.get(first)?.add(second);
      linkedIdsByAct.get(second)?.add(first);
    }

    const seasonVenues = db
      .select()
      .from(venues)
      .where(eq(venues.seasonId, seasonId))
      .all()
      .filter(
        (venue) =>
          venue.canonicalVenueId === null && venue.status !== "withdrawn",
      );
    const seasonSlots = db
      .select()
      .from(slots)
      .where(eq(slots.seasonId, seasonId))
      .all();
    const seasonContacts = db
      .select()
      .from(contacts)
      .where(eq(contacts.seasonId, seasonId))
      .all();
    const contactsById = new Map(
      seasonContacts.map((contact) => [contact.id, contact]),
    );

    return {
      timezone: season.timezone,
      venues: seasonVenues.map((venue) => ({
        id: venue.id,
        title: venue.title,
        hostName:
          venue.hostContactId === null
            ? null
            : (contactsById.get(venue.hostContactId)?.name ?? null),
        hasPower: venue.hasPower,
        requestedActNames: venue.requestedActNames,
        genrePreferences: venue.genrePreferences,
        slots: seasonSlots
          .filter((slot) => slot.venueId === venue.id)
          .map((slot) => ({
            id: slot.id,
            venueId: slot.venueId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            state: slot.state,
          })),
      })),
      acts: candidateActs.map((act) => ({
        id: act.id,
        name: act.name,
        genre: act.genre,
        requiresAmplification: act.requiresAmplification,
        housePreference: act.housePreference,
        availabilities: availabilityRows
          .filter((availability) => canonicalId(availability.actId) === act.id)
          .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
        linkedActIds: [...(linkedIdsByAct.get(act.id) ?? [])].sort(
          (left, right) => left - right,
        ),
      })),
      assignments: listAssignments(seasonId).map((assignment) => ({
        actId: canonicalId(assignment.actId),
        slotId: assignment.slotId,
      })),
    };
  }

  function suggestForVenue(venueId: number): RankedPairing[] {
    const venue = getVenue(venueId);
    return suggestionsForVenue(buildMatchingInput(venue.seasonId), venueId);
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
    getAct,
    getVenue,
    getSlot,
    getAssignment,
    getActLink,
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
    publishSeasonMap,
    unpublishSeasonMap,
    ensureVenueSlots,
    listVenueSlots,
    listSeasonSlots,
    listSeasonVenues,
    linkActs,
    unlinkActs,
    listActLinks,
    listActLinksForAct,
    holdSlot,
    listReleasableHolds,
    releaseSlotHold,
    assignSlot,
    correctAssignment,
    unassignSlot,
    listActivityQueue: records.listActivityQueue,
    listAssignments,
    buildMatchingInput,
    suggestForVenue,
    listEmailWaves,
    listEmailWave,
    findPriorSeasonContact,
  });
}
