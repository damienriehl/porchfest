import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  acts,
  assignments,
  contacts,
  emailLog,
  slots,
  venues,
  type Act,
  type Contact,
  type Venue,
} from "./storage/schema.js";
import {
  type CoreDatabase,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
  conflict as repositoryConflict,
} from "./storage/repository-errors.js";

export type ActChanges = Partial<
  Pick<
    Act,
    | "name"
    | "genre"
    | "description"
    | "links"
    | "placeholder"
    | "reachViaContactId"
  >
>;

export type VenueChanges = Partial<
  Pick<
    Venue,
    | "title"
    | "address"
    | "latitude"
    | "longitude"
    | "notes"
    | "hostContactId"
    | "placeholder"
    | "reachViaContactId"
  >
>;

export type ContactChanges = Partial<Pick<Contact, "name" | "email" | "phone">>;

export type ActivityQueueItem =
  | { recordType: "act"; record: Act }
  | { recordType: "venue"; record: Venue }
  | { recordType: "contact"; record: Contact };

export interface RecordResolution<T> {
  canonical: T;
  superseded: T[];
}

export class RecordConflictError extends RepositoryConflictError<
  "act" | "venue" | "contact"
> {
  constructor(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    super("RecordConflictError", recordType, recordId, conflictingFields);
  }
}

export class RecordLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("RecordLifecycleError", message);
  }
}

export type RecordRepositoryOptions = RepositoryOptions;

type CoreTransaction = Parameters<
  Parameters<CoreDatabase["transaction"]>[0]
>[0];

export function createRecordRepository(
  db: CoreDatabase | CoreTransaction,
  options: RecordRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function conflict(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    fields: readonly string[],
  ): never {
    return repositoryConflict(
      RecordConflictError,
      recordType,
      recordId,
      fields,
    );
  }

  function getAct(id: number): Act {
    const record = db.select().from(acts).where(eq(acts.id, id)).get();
    if (!record) throw new RecordLifecycleError(`act ${id} does not exist`);
    return record;
  }

  function getVenue(id: number): Venue {
    const record = db.select().from(venues).where(eq(venues.id, id)).get();
    if (!record) throw new RecordLifecycleError(`venue ${id} does not exist`);
    return record;
  }

  function getContact(id: number): Contact {
    const record = db.select().from(contacts).where(eq(contacts.id, id)).get();
    if (!record) throw new RecordLifecycleError(`contact ${id} does not exist`);
    return record;
  }

  function updateAct(
    id: number,
    expectedVersion: number,
    changes: ActChanges,
  ): Act {
    const fields = Object.keys(changes);
    const result = db
      .update(acts)
      .set({
        ...changes,
        version: sql`${acts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(acts.id, id), eq(acts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("act", id, fields);
    return getAct(id);
  }

  function updateVenue(
    id: number,
    expectedVersion: number,
    changes: VenueChanges,
  ): Venue {
    const fields = Object.keys(changes);
    const result = db
      .update(venues)
      .set({
        ...changes,
        version: sql`${venues.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("venue", id, fields);
    return getVenue(id);
  }

  function updateContact(
    id: number,
    expectedVersion: number,
    changes: ContactChanges,
  ): Contact {
    const fields = Object.keys(changes);
    const result = db
      .update(contacts)
      .set({
        ...changes,
        version: sql`${contacts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("contact", id, fields);
    return getContact(id);
  }

  function promotePlaceholderAct(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Act {
    return db.transaction((tx) => {
      const placeholder = tx
        .select()
        .from(acts)
        .where(eq(acts.id, placeholderId))
        .get();
      const submission = tx
        .select()
        .from(acts)
        .where(eq(acts.id, submissionId))
        .get();
      if (!placeholder)
        throw new RecordLifecycleError(`act ${placeholderId} does not exist`);
      if (!submission)
        throw new RecordLifecycleError(`act ${submissionId} does not exist`);
      if (!placeholder.placeholder)
        throw new RecordLifecycleError(
          `act ${placeholderId} is not a placeholder`,
        );
      if (submission.placeholder)
        throw new RecordLifecycleError(
          `act ${submissionId} is not a submission`,
        );
      if (placeholder.seasonId !== submission.seasonId)
        throw new RecordLifecycleError(
          "promotion records belong to different seasons",
        );
      if (placeholder.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${placeholderId} is already superseded`,
        );
      if (submission.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${submissionId} is already superseded`,
        );
      const placeholderResult = tx
        .update(acts)
        .set({
          name: submission.name,
          genre: submission.genre ?? placeholder.genre,
          description: submission.description ?? placeholder.description,
          links: submission.links ?? placeholder.links,
          placeholder: false,
          reachViaContactId:
            submission.reachViaContactId ?? placeholder.reachViaContactId,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(eq(acts.id, placeholderId), eq(acts.version, placeholderVersion)),
        )
        .run();
      if (placeholderResult.changes !== 1)
        conflict("act", placeholderId, ["promotion"]);

      tx.update(assignments)
        .set({
          actId: placeholderId,
          version: sql`${assignments.version} + 1`,
          updatedAt: now(),
        })
        .where(eq(assignments.actId, submissionId))
        .run();
      tx.update(emailLog)
        .set({ recordId: placeholderId })
        .where(
          and(
            eq(emailLog.recordType, "act"),
            eq(emailLog.recordId, submissionId),
          ),
        )
        .run();

      const submissionResult = tx
        .update(acts)
        .set({
          canonicalActId: placeholderId,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(eq(acts.id, submissionId), eq(acts.version, submissionVersion)),
        )
        .run();
      if (submissionResult.changes !== 1)
        conflict("act", submissionId, ["promotion"]);

      const promoted = tx
        .select()
        .from(acts)
        .where(eq(acts.id, placeholderId))
        .get();
      if (!promoted)
        throw new RecordLifecycleError(`act ${placeholderId} disappeared`);
      return promoted;
    });
  }

  function promotePlaceholderVenue(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Venue {
    return db.transaction((tx) => {
      const placeholder = tx
        .select()
        .from(venues)
        .where(eq(venues.id, placeholderId))
        .get();
      const submission = tx
        .select()
        .from(venues)
        .where(eq(venues.id, submissionId))
        .get();
      if (!placeholder)
        throw new RecordLifecycleError(`venue ${placeholderId} does not exist`);
      if (!submission)
        throw new RecordLifecycleError(`venue ${submissionId} does not exist`);
      if (!placeholder.placeholder)
        throw new RecordLifecycleError(
          `venue ${placeholderId} is not a placeholder`,
        );
      if (submission.placeholder)
        throw new RecordLifecycleError(
          `venue ${submissionId} is not a submission`,
        );
      if (placeholder.seasonId !== submission.seasonId)
        throw new RecordLifecycleError(
          "promotion records belong to different seasons",
        );
      if (placeholder.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${placeholderId} is already superseded`,
        );
      if (submission.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${submissionId} is already superseded`,
        );
      const placeholderSlot = tx
        .select({ id: slots.id })
        .from(slots)
        .where(
          or(
            eq(slots.venueId, placeholderId),
            eq(slots.fallbackVenueId, placeholderId),
          ),
        )
        .get();
      const submissionSlot = tx
        .select({ id: slots.id })
        .from(slots)
        .where(
          or(
            eq(slots.venueId, submissionId),
            eq(slots.fallbackVenueId, submissionId),
          ),
        )
        .get();
      if (placeholderSlot && submissionSlot)
        throw new RecordLifecycleError("venue promotion would merge slots");

      const placeholderResult = tx
        .update(venues)
        .set({
          title: submission.title,
          address: submission.address ?? placeholder.address,
          latitude: submission.latitude ?? placeholder.latitude,
          longitude: submission.longitude ?? placeholder.longitude,
          notes: submission.notes ?? placeholder.notes,
          hostContactId: submission.hostContactId ?? placeholder.hostContactId,
          placeholder: false,
          reachViaContactId:
            submission.reachViaContactId ?? placeholder.reachViaContactId,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(venues.id, placeholderId),
            eq(venues.version, placeholderVersion),
          ),
        )
        .run();
      if (placeholderResult.changes !== 1)
        conflict("venue", placeholderId, ["promotion"]);

      tx.update(slots)
        .set({
          venueId: sql`case when ${slots.venueId} = ${submissionId} then ${placeholderId} else ${slots.venueId} end`,
          fallbackVenueId: sql`case when ${slots.fallbackVenueId} = ${submissionId} then ${placeholderId} else ${slots.fallbackVenueId} end`,
          version: sql`${slots.version} + 1`,
          updatedAt: now(),
        })
        .where(
          or(
            eq(slots.venueId, submissionId),
            eq(slots.fallbackVenueId, submissionId),
          ),
        )
        .run();
      tx.update(emailLog)
        .set({ recordId: placeholderId })
        .where(
          and(
            eq(emailLog.recordType, "venue"),
            eq(emailLog.recordId, submissionId),
          ),
        )
        .run();

      const submissionResult = tx
        .update(venues)
        .set({
          canonicalVenueId: placeholderId,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(venues.id, submissionId),
            eq(venues.version, submissionVersion),
          ),
        )
        .run();
      if (submissionResult.changes !== 1)
        conflict("venue", submissionId, ["promotion"]);

      const promoted = tx
        .select()
        .from(venues)
        .where(eq(venues.id, placeholderId))
        .get();
      if (!promoted)
        throw new RecordLifecycleError(`venue ${placeholderId} disappeared`);
      return promoted;
    });
  }

  function resolveCanonicalAct(id: number): Act {
    let canonical = getAct(id);
    const seen = new Set<number>();
    while (canonical.canonicalActId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`act ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getAct(canonical.canonicalActId);
    }
    return canonical;
  }

  function resolveAct(id: number): RecordResolution<Act> {
    const canonical = resolveCanonicalAct(id);
    const familyRows = db
      .select()
      .from(acts)
      .where(eq(acts.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(familyRows.map((record) => [record.id, record]));
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalActId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalActId === canonical.id) return true;
        current =
          familyById.get(current.canonicalActId) ??
          getAct(current.canonicalActId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function resolveCanonicalVenue(id: number): Venue {
    let canonical = getVenue(id);
    const seen = new Set<number>();
    while (canonical.canonicalVenueId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`venue ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getVenue(canonical.canonicalVenueId);
    }
    return canonical;
  }

  function resolveVenue(id: number): RecordResolution<Venue> {
    const canonical = resolveCanonicalVenue(id);
    const familyRows = db
      .select()
      .from(venues)
      .where(eq(venues.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(familyRows.map((record) => [record.id, record]));
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalVenueId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalVenueId === canonical.id) return true;
        current =
          familyById.get(current.canonicalVenueId) ??
          getVenue(current.canonicalVenueId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function resolveCanonicalContact(id: number): Contact {
    let canonical = getContact(id);
    const seen = new Set<number>();
    while (canonical.canonicalContactId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(
          `contact ${id} has a supersession cycle`,
        );
      seen.add(canonical.id);
      canonical = getContact(canonical.canonicalContactId);
    }
    return canonical;
  }

  function resolveContact(id: number): RecordResolution<Contact> {
    const canonical = resolveCanonicalContact(id);
    const familyRows = db
      .select()
      .from(contacts)
      .where(eq(contacts.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(familyRows.map((record) => [record.id, record]));
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalContactId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalContactId === canonical.id) return true;
        current =
          familyById.get(current.canonicalContactId) ??
          getContact(current.canonicalContactId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function supersedeAct(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Act {
    return db.transaction((tx) => {
      const source = tx.select().from(acts).where(eq(acts.id, id)).get();
      if (!source) throw new RecordLifecycleError(`act ${id} does not exist`);

      let target = tx.select().from(acts).where(eq(acts.id, canonicalId)).get();
      if (!target)
        throw new RecordLifecycleError(`act ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalActId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `act ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalActId;
        target = tx.select().from(acts).where(eq(acts.id, nextId)).get();
        if (!target)
          throw new RecordLifecycleError(`act ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError("act supersession would create a cycle");

      const targetCheck = tx
        .select({ canonicalActId: acts.canonicalActId })
        .from(acts)
        .where(eq(acts.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`act ${target.id} does not exist`);
      if (targetCheck.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${target.id} is already superseded`,
        );

      const result = tx
        .update(acts)
        .set({
          canonicalActId: target.id,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(acts.id, id), eq(acts.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("act", id, ["canonicalActId"]);

      const superseded = tx.select().from(acts).where(eq(acts.id, id)).get();
      if (!superseded) throw new RecordLifecycleError(`act ${id} disappeared`);
      return superseded;
    });
  }

  function supersedeVenue(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Venue {
    return db.transaction((tx) => {
      const source = tx.select().from(venues).where(eq(venues.id, id)).get();
      if (!source) throw new RecordLifecycleError(`venue ${id} does not exist`);

      let target = tx
        .select()
        .from(venues)
        .where(eq(venues.id, canonicalId))
        .get();
      if (!target)
        throw new RecordLifecycleError(`venue ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalVenueId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `venue ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalVenueId;
        target = tx.select().from(venues).where(eq(venues.id, nextId)).get();
        if (!target)
          throw new RecordLifecycleError(`venue ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError(
          "venue supersession would create a cycle",
        );

      const targetCheck = tx
        .select({ canonicalVenueId: venues.canonicalVenueId })
        .from(venues)
        .where(eq(venues.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`venue ${target.id} does not exist`);
      if (targetCheck.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${target.id} is already superseded`,
        );

      const result = tx
        .update(venues)
        .set({
          canonicalVenueId: target.id,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("venue", id, ["canonicalVenueId"]);

      const superseded = tx
        .select()
        .from(venues)
        .where(eq(venues.id, id))
        .get();
      if (!superseded)
        throw new RecordLifecycleError(`venue ${id} disappeared`);
      return superseded;
    });
  }

  function supersedeContact(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Contact {
    return db.transaction((tx) => {
      const source = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, id))
        .get();
      if (!source)
        throw new RecordLifecycleError(`contact ${id} does not exist`);

      let target = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, canonicalId))
        .get();
      if (!target)
        throw new RecordLifecycleError(`contact ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalContactId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `contact ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalContactId;
        target = tx
          .select()
          .from(contacts)
          .where(eq(contacts.id, nextId))
          .get();
        if (!target)
          throw new RecordLifecycleError(`contact ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError(
          "contact supersession would create a cycle",
        );

      const targetCheck = tx
        .select({ canonicalContactId: contacts.canonicalContactId })
        .from(contacts)
        .where(eq(contacts.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`contact ${target.id} does not exist`);
      if (targetCheck.canonicalContactId !== null)
        throw new RecordLifecycleError(
          `contact ${target.id} is already superseded`,
        );

      const result = tx
        .update(contacts)
        .set({
          canonicalContactId: target.id,
          version: sql`${contacts.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("contact", id, ["canonicalContactId"]);

      const superseded = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, id))
        .get();
      if (!superseded)
        throw new RecordLifecycleError(`contact ${id} disappeared`);
      return superseded;
    });
  }

  function listActivityQueue(seasonId: number): ActivityQueueItem[] {
    return [
      ...db
        .select()
        .from(acts)
        .where(and(eq(acts.seasonId, seasonId), isNull(acts.canonicalActId)))
        .all()
        .map((record): ActivityQueueItem => ({ recordType: "act", record })),
      ...db
        .select()
        .from(venues)
        .where(
          and(eq(venues.seasonId, seasonId), isNull(venues.canonicalVenueId)),
        )
        .all()
        .map((record): ActivityQueueItem => ({ recordType: "venue", record })),
      ...db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.seasonId, seasonId),
            isNull(contacts.canonicalContactId),
          ),
        )
        .all()
        .map((record): ActivityQueueItem => ({
          recordType: "contact",
          record,
        })),
    ];
  }

  function resolveEmailRecipients(
    recordType: "act" | "venue",
    recordId: number,
  ): Contact[] {
    let recipientIds: (number | null)[];
    if (recordType === "act") {
      recipientIds = [resolveCanonicalAct(recordId).reachViaContactId];
    } else {
      const record = resolveCanonicalVenue(recordId);
      recipientIds = [record.hostContactId, record.reachViaContactId];
    }
    const resolved = new Map<number, Contact>();
    for (const contactId of recipientIds) {
      if (contactId === null) continue;
      const canonical = resolveCanonicalContact(contactId);
      if (canonical.email !== null) resolved.set(canonical.id, canonical);
    }
    return [...resolved.values()];
  }

  return Object.freeze({
    updateAct,
    updateVenue,
    updateContact,
    promotePlaceholderAct,
    promotePlaceholderVenue,
    supersedeAct,
    supersedeVenue,
    supersedeContact,
    resolveAct,
    resolveVenue,
    resolveContact,
    listActivityQueue,
    resolveEmailRecipients,
  });
}
