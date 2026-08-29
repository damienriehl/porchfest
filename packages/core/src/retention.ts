// R35's irreversible participant anonymization. Once off-host backup rotation
// has consumed the receipt, a restore cannot recover this identity by design.

import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  acts,
  annotations,
  changeRequests,
  contacts,
  deletionReceipts,
  venueCoordinates,
  venues,
  type Contact,
  type DeletionReceipt,
  type DeletionReceiptAction,
} from "./storage/schema.js";
import {
  type CoreDatabase,
  type CoreExecutor,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

export const DEFAULT_RETENTION_MONTHS = 24;
export const ANONYMIZED_CONTACT_NAME = "[participant anonymized]";
export const ANONYMIZED_ANNOTATION_NOTE = "[participant note anonymized]";

export interface RetentionRepositoryOptions extends RepositoryOptions {
  readonly retentionMonths?: number;
}

export interface AnonymizeParticipantInput {
  readonly contactId: number;
  readonly expectedVersion: number;
}

export interface AnonymizationResult {
  readonly contact: Contact;
  readonly receipt: DeletionReceipt;
}

export class RetentionConflictError extends RepositoryConflictError<"contact"> {
  constructor(contactId: number, conflictingFields: readonly string[]) {
    super("RetentionConflictError", "contact", contactId, conflictingFields);
  }
}

export class RetentionLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("RetentionLifecycleError", message);
  }
}

export function normalizeRetentionMonths(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? value
    : DEFAULT_RETENTION_MONTHS;
}

/** Calendar-month subtraction avoids making a 24-month policy mean 720 days. */
function retentionCutoff(now: Date, retentionMonths: number): Date {
  const targetMonthStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - retentionMonths,
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return targetMonthStart;
}

export function createRetentionRepository(
  db: CoreDatabase,
  options: RetentionRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const retentionMonths = normalizeRetentionMonths(options.retentionMonths);

  function isEligible(executor: CoreExecutor, cutoff: Date) {
    return or(
      lt(contacts.updatedAt, cutoff),
      and(
        isNotNull(contacts.canonicalContactId),
        exists(
          executor
            .select({ id: deletionReceipts.id })
            .from(deletionReceipts)
            .where(eq(deletionReceipts.contactId, contacts.canonicalContactId)),
        ),
      ),
    );
  }

  function listEligibleWith(executor: CoreExecutor): Contact[] {
    const cutoff = retentionCutoff(now(), retentionMonths);
    return executor
      .select()
      .from(contacts)
      .where(
        and(
          isEligible(executor, cutoff),
          notExists(
            executor
              .select({ id: deletionReceipts.id })
              .from(deletionReceipts)
              .where(eq(deletionReceipts.contactId, contacts.id)),
          ),
        ),
      )
      .all();
  }

  function listEligible(): Contact[] {
    return listEligibleWith(db);
  }

  function findParticipant(contactId: number): Contact | null {
    return (
      db.select().from(contacts).where(eq(contacts.id, contactId)).get() ?? null
    );
  }

  function listReceipts(): DeletionReceipt[] {
    return db
      .select()
      .from(deletionReceipts)
      .orderBy(desc(deletionReceipts.applicationAnonymizedAt))
      .all();
  }

  function existingResult(
    executor: CoreExecutor,
    input: AnonymizeParticipantInput,
  ): AnonymizationResult | null {
    const contact = executor
      .select()
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .get();
    if (!contact) {
      throw new RetentionLifecycleError(
        `contact ${input.contactId} does not exist`,
      );
    }
    const receipt = executor
      .select()
      .from(deletionReceipts)
      .where(eq(deletionReceipts.contactId, input.contactId))
      .get();
    if (receipt && contact.version === input.expectedVersion) {
      return { contact, receipt };
    }
    return null;
  }

  function anonymizeWith(
    executor: CoreExecutor,
    input: AnonymizeParticipantInput,
    action: DeletionReceiptAction,
  ): AnonymizationResult {
    const stamp = now();
    const cutoff = retentionCutoff(stamp, retentionMonths);
    const changed = executor
      .update(contacts)
      .set({
        name: ANONYMIZED_CONTACT_NAME,
        email: null,
        phone: null,
        version: sql`${contacts.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(contacts.id, input.contactId),
          eq(contacts.version, input.expectedVersion),
          // R35: eligibility belongs inside the irreversible mutation. A
          // superseded row whose canonical receipt already exists is also due,
          // because otherwise that newly linked identity is unreachable.
          isEligible(executor, cutoff),
          notExists(
            executor
              .select({ id: deletionReceipts.id })
              .from(deletionReceipts)
              .where(eq(deletionReceipts.contactId, contacts.id)),
          ),
        ),
      )
      .run();

    // KTD7: the expected version is inside the mutation. The affected-row count
    // is the verdict, so two organizers using the same version cannot both win.
    if (changed.changes !== 1) {
      const existing = existingResult(executor, input);
      if (existing) return existing;
      throw new RetentionConflictError(input.contactId, ["version"]);
    }

    const canonicalContact = executor
      .select()
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .get();
    if (!canonicalContact) {
      throw new RetentionLifecycleError(
        `contact ${input.contactId} disappeared during anonymization`,
      );
    }
    const seasonContacts = executor
      .select()
      .from(contacts)
      .where(eq(contacts.seasonId, canonicalContact.seasonId))
      .all();
    const contactsById = new Map(
      seasonContacts.map((contact) => [contact.id, contact]),
    );
    const descendantContactIds = seasonContacts
      .filter((candidate) => {
        if (candidate.id === canonicalContact.id) return false;
        let current = candidate;
        const seen = new Set<number>();
        while (current.canonicalContactId !== null) {
          if (seen.has(current.id)) return false;
          seen.add(current.id);
          if (current.canonicalContactId === canonicalContact.id) return true;
          const next = contactsById.get(current.canonicalContactId);
          if (!next) return false;
          current = next;
        }
        return false;
      })
      .map(({ id }) => id);
    const receiptedContactIds =
      descendantContactIds.length === 0
        ? new Set<number>()
        : new Set(
            executor
              .select({ contactId: deletionReceipts.contactId })
              .from(deletionReceipts)
              .where(inArray(deletionReceipts.contactId, descendantContactIds))
              .all()
              .map(({ contactId }) => contactId),
          );
    const supersededContactIds = descendantContactIds.filter(
      (contactId) => !receiptedContactIds.has(contactId),
    );
    if (supersededContactIds.length > 0) {
      executor
        .update(contacts)
        .set({
          name: ANONYMIZED_CONTACT_NAME,
          email: null,
          phone: null,
          version: sql`${contacts.version} + 1`,
          updatedAt: stamp,
        })
        .where(inArray(contacts.id, supersededContactIds))
        .run();
    }
    const participantContactIds = [
      canonicalContact.id,
      ...supersededContactIds,
    ];

    const linkedVenues = executor
      .select({ id: venues.id })
      .from(venues)
      .where(
        or(
          inArray(venues.hostContactId, participantContactIds),
          inArray(venues.reachViaContactId, participantContactIds),
        ),
      )
      .all();
    const linkedActs = executor
      .select({ id: acts.id })
      .from(acts)
      .where(inArray(acts.reachViaContactId, participantContactIds))
      .all();
    const venueIds = linkedVenues.map(({ id }) => id);
    const actIds = linkedActs.map(({ id }) => id);

    if (venueIds.length > 0) {
      executor
        .update(venues)
        .set({
          address: null,
          spaceDescription: null,
          notes: null,
          version: sql`${venues.version} + 1`,
          updatedAt: stamp,
        })
        .where(inArray(venues.id, venueIds))
        .run();
      // Coordinate provenance includes the private address-at-geocode and the
      // attendee point itself, so anonymization removes the complete row.
      executor
        .delete(venueCoordinates)
        .where(inArray(venueCoordinates.venueId, venueIds))
        .run();
      executor
        .update(changeRequests)
        .set({
          proposedValue: null,
          status: sql`case when ${changeRequests.status} = 'pending' then 'rejected' else ${changeRequests.status} end`,
          version: sql`${changeRequests.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(changeRequests.recordType, "venue"),
            inArray(changeRequests.recordId, venueIds),
          ),
        )
        .run();
      executor
        .update(annotations)
        .set({
          note: ANONYMIZED_ANNOTATION_NOTE,
          version: sql`${annotations.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(annotations.recordType, "venue"),
            inArray(annotations.recordId, venueIds),
          ),
        )
        .run();
    }

    if (actIds.length > 0) {
      executor
        .update(acts)
        .set({
          notes: null,
          version: sql`${acts.version} + 1`,
          updatedAt: stamp,
        })
        .where(inArray(acts.id, actIds))
        .run();
      executor
        .update(changeRequests)
        .set({
          proposedValue: null,
          status: sql`case when ${changeRequests.status} = 'pending' then 'rejected' else ${changeRequests.status} end`,
          version: sql`${changeRequests.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(changeRequests.recordType, "act"),
            inArray(changeRequests.recordId, actIds),
          ),
        )
        .run();
      executor
        .update(annotations)
        .set({
          note: ANONYMIZED_ANNOTATION_NOTE,
          version: sql`${annotations.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(annotations.recordType, "act"),
            inArray(annotations.recordId, actIds),
          ),
        )
        .run();
    }

    executor
      .update(annotations)
      .set({
        note: ANONYMIZED_ANNOTATION_NOTE,
        version: sql`${annotations.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(annotations.recordType, "contact"),
          inArray(annotations.recordId, participantContactIds),
        ),
      )
      .run();

    // email_log is deliberately untouched. Once its contact row is scrubbed,
    // it is R35's non-identifying evidence that a matching wave was sent.
    const receiptValues = (contactId: number) => ({
      contactId,
      action,
      applicationAnonymizedAt: stamp,
      backupStatus: "pending" as const,
      backupCompletedAt: null,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    });
    const receipt = executor
      .insert(deletionReceipts)
      .values(receiptValues(input.contactId))
      .returning()
      .get();
    if (supersededContactIds.length > 0) {
      // R35: every identity scrub gets its own idempotence receipt. A later
      // eligibility pass must not mutate an already-anonymized descendant.
      executor
        .insert(deletionReceipts)
        .values(supersededContactIds.map(receiptValues))
        .run();
    }
    return { contact: canonicalContact, receipt };
  }

  function anonymizeParticipant(
    input: AnonymizeParticipantInput,
  ): AnonymizationResult {
    return db.transaction((tx) => anonymizeWith(tx, input, "organizer"), {
      behavior: "immediate",
    });
  }

  function anonymizeEligible(): AnonymizationResult[] {
    return db.transaction(
      (tx) => {
        const results: AnonymizationResult[] = [];
        for (const contact of listEligibleWith(tx)) {
          const alreadyAnonymized = tx
            .select({ id: deletionReceipts.id })
            .from(deletionReceipts)
            .where(eq(deletionReceipts.contactId, contact.id))
            .get();
          if (alreadyAnonymized) continue;
          results.push(
            anonymizeWith(
              tx,
              { contactId: contact.id, expectedVersion: contact.version },
              "retention",
            ),
          );
        }
        return results;
      },
      { behavior: "immediate" },
    );
  }

  return Object.freeze({
    retentionMonths,
    listEligible,
    findParticipant,
    anonymizeParticipant,
    anonymizeEligible,
    listReceipts,
  });
}

export type RetentionRepository = ReturnType<typeof createRetentionRepository>;
