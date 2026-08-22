import { and, eq, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  acts,
  contacts,
  venues,
  type Act,
  type Contact,
  type Venue,
} from "./storage/schema.js";
import * as schema from "./storage/schema.js";

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

export class RecordConflictError extends Error {
  readonly recordType: "act" | "venue" | "contact";
  readonly recordId: number;
  readonly conflictingFields: readonly string[];

  constructor(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    const fields =
      conflictingFields.length > 0 ? conflictingFields : ["version"];
    super(`${recordType} ${recordId} conflict: ${fields.join(", ")}`);
    this.name = "RecordConflictError";
    this.recordType = recordType;
    this.recordId = recordId;
    this.conflictingFields = fields;
  }
}

export class RecordLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordLifecycleError";
  }
}

export interface RecordRepositoryOptions {
  now?: () => Date;
}

type CoreDatabase = BetterSQLite3Database<typeof schema>;

export function createRecordRepository(
  db: CoreDatabase,
  options: RecordRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function conflict(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    fields: readonly string[],
  ): never {
    throw new RecordConflictError(recordType, recordId, fields);
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

      const placeholderResult = tx
        .update(acts)
        .set({
          name: submission.name,
          genre: submission.genre,
          description: submission.description,
          links: submission.links,
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

      const placeholderResult = tx
        .update(venues)
        .set({
          title: submission.title,
          address: submission.address,
          latitude: submission.latitude,
          longitude: submission.longitude,
          notes: submission.notes,
          hostContactId: submission.hostContactId,
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

  function resolveAct(id: number): RecordResolution<Act> {
    let canonical = getAct(id);
    const seen = new Set<number>();
    while (canonical.canonicalActId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`act ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getAct(canonical.canonicalActId);
    }
    const family = db
      .select()
      .from(acts)
      .where(eq(acts.seasonId, canonical.seasonId))
      .all()
      .filter((candidate) => {
        if (candidate.id === canonical.id) return false;
        let current = candidate;
        const candidateSeen = new Set<number>();
        while (current.canonicalActId !== null) {
          if (candidateSeen.has(current.id)) return false;
          candidateSeen.add(current.id);
          if (current.canonicalActId === canonical.id) return true;
          current = getAct(current.canonicalActId);
        }
        return false;
      });
    return { canonical, superseded: family };
  }

  function resolveVenue(id: number): RecordResolution<Venue> {
    let canonical = getVenue(id);
    const seen = new Set<number>();
    while (canonical.canonicalVenueId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`venue ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getVenue(canonical.canonicalVenueId);
    }
    const family = db
      .select()
      .from(venues)
      .where(eq(venues.seasonId, canonical.seasonId))
      .all()
      .filter((candidate) => {
        if (candidate.id === canonical.id) return false;
        let current = candidate;
        const candidateSeen = new Set<number>();
        while (current.canonicalVenueId !== null) {
          if (candidateSeen.has(current.id)) return false;
          candidateSeen.add(current.id);
          if (current.canonicalVenueId === canonical.id) return true;
          current = getVenue(current.canonicalVenueId);
        }
        return false;
      });
    return { canonical, superseded: family };
  }

  function resolveContact(id: number): RecordResolution<Contact> {
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
    const family = db
      .select()
      .from(contacts)
      .where(eq(contacts.seasonId, canonical.seasonId))
      .all()
      .filter((candidate) => {
        if (candidate.id === canonical.id) return false;
        let current = candidate;
        const candidateSeen = new Set<number>();
        while (current.canonicalContactId !== null) {
          if (candidateSeen.has(current.id)) return false;
          candidateSeen.add(current.id);
          if (current.canonicalContactId === canonical.id) return true;
          current = getContact(current.canonicalContactId);
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
    const source = getAct(id);
    const target = resolveAct(canonicalId).canonical;
    if (source.seasonId !== target.seasonId)
      throw new RecordLifecycleError(
        "supersession records belong to different seasons",
      );
    if (source.id === target.id)
      throw new RecordLifecycleError("act supersession would create a cycle");
    const result = db
      .update(acts)
      .set({
        canonicalActId: target.id,
        version: sql`${acts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(acts.id, id), eq(acts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("act", id, ["canonicalActId"]);
    return getAct(id);
  }

  function supersedeVenue(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Venue {
    const source = getVenue(id);
    const target = resolveVenue(canonicalId).canonical;
    if (source.seasonId !== target.seasonId)
      throw new RecordLifecycleError(
        "supersession records belong to different seasons",
      );
    if (source.id === target.id)
      throw new RecordLifecycleError("venue supersession would create a cycle");
    const result = db
      .update(venues)
      .set({
        canonicalVenueId: target.id,
        version: sql`${venues.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("venue", id, ["canonicalVenueId"]);
    return getVenue(id);
  }

  function supersedeContact(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Contact {
    const source = getContact(id);
    const target = resolveContact(canonicalId).canonical;
    if (source.seasonId !== target.seasonId)
      throw new RecordLifecycleError(
        "supersession records belong to different seasons",
      );
    if (source.id === target.id)
      throw new RecordLifecycleError(
        "contact supersession would create a cycle",
      );
    const result = db
      .update(contacts)
      .set({
        canonicalContactId: target.id,
        version: sql`${contacts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("contact", id, ["canonicalContactId"]);
    return getContact(id);
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
    const recipientIds =
      recordType === "act"
        ? [resolveAct(recordId).canonical.reachViaContactId]
        : (() => {
            const record = resolveVenue(recordId).canonical;
            return [record.hostContactId, record.reachViaContactId];
          })();
    const resolved = new Map<number, Contact>();
    for (const contactId of recipientIds) {
      if (contactId === null) continue;
      const canonical = resolveContact(contactId).canonical;
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
