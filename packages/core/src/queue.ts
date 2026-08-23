// R5's new-activity queue, and R15's guarantee that a participant edit comes back
// to it.
//
// The whole design rests on one idea: a dismissal records the record VERSION it
// was made against. "New for this organizer" is then just `version >
// dismissedVersion`, which means a later edit re-surfaces the item without any
// code having to observe the edit — and one organizer's dismissal is invisible to
// another because the row is keyed by organizer.

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  acts,
  contacts,
  queueDismissals,
  venues,
  type Act,
  type Contact,
  type QueueRecordType,
  type Venue,
} from "./storage/schema.js";
import type { CoreExecutor } from "./storage/repository-errors.js";

export type QueueRecord =
  | { readonly recordType: "act"; readonly record: Act }
  | { readonly recordType: "venue"; readonly record: Venue }
  | { readonly recordType: "contact"; readonly record: Contact };

export type QueueItem = QueueRecord & {
  /** False once this organizer has dismissed the record at its current version. */
  readonly isNew: boolean;
  readonly version: number;
  readonly updatedAt: Date;
};

export function createQueueRepository(
  db: CoreExecutor,
  now: () => Date = () => new Date(),
) {
  function allRecords(seasonId: number): QueueRecord[] {
    // Superseded records never appear (R27): they are represented by whatever
    // record supersedes them.
    const actRows = db
      .select()
      .from(acts)
      .where(and(eq(acts.seasonId, seasonId), isNull(acts.canonicalActId)))
      .all()
      .map((record): QueueRecord => ({ recordType: "act", record }));
    const venueRows = db
      .select()
      .from(venues)
      .where(
        and(eq(venues.seasonId, seasonId), isNull(venues.canonicalVenueId)),
      )
      .all()
      .map((record): QueueRecord => ({ recordType: "venue", record }));
    const contactRows = db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.seasonId, seasonId),
          isNull(contacts.canonicalContactId),
        ),
      )
      .all()
      .map((record): QueueRecord => ({ recordType: "contact", record }));
    return [...actRows, ...venueRows, ...contactRows];
  }

  function dismissalsFor(
    seasonId: number,
    organizerId: number,
  ): Map<string, number> {
    const rows = db
      .select()
      .from(queueDismissals)
      .where(
        and(
          eq(queueDismissals.seasonId, seasonId),
          eq(queueDismissals.organizerId, organizerId),
        ),
      )
      .all();
    return new Map(
      rows.map((row) => [
        `${row.recordType}:${row.recordId}`,
        row.dismissedVersion,
      ]),
    );
  }

  /** Every record in the season, each marked new-or-not for this organizer. */
  function listForOrganizer(
    seasonId: number,
    organizerId: number,
  ): QueueItem[] {
    const dismissed = dismissalsFor(seasonId, organizerId);
    return allRecords(seasonId)
      .map((entry): QueueItem => {
        const key = `${entry.recordType}:${entry.record.id}`;
        const seenAt = dismissed.get(key);
        return {
          ...entry,
          version: entry.record.version,
          updatedAt: entry.record.updatedAt,
          isNew: seenAt === undefined || entry.record.version > seenAt,
        };
      })
      .sort(
        (left, right) => right.updatedAt.valueOf() - left.updatedAt.valueOf(),
      );
  }

  function listNewForOrganizer(
    seasonId: number,
    organizerId: number,
  ): QueueItem[] {
    return listForOrganizer(seasonId, organizerId).filter((item) => item.isNew);
  }

  function countNewForOrganizer(seasonId: number, organizerId: number): number {
    return listNewForOrganizer(seasonId, organizerId).length;
  }

  /**
   * Mark an item reviewed for one organizer, at the version they actually looked
   * at. Passing the version the organizer saw — rather than reading the current
   * one here — is what stops a dismissal from silently swallowing an edit that
   * landed while they were reading.
   */
  function dismiss(input: {
    organizerId: number;
    seasonId: number;
    recordType: QueueRecordType;
    recordId: number;
    version: number;
  }): void {
    const stamp = now();
    const updated = db
      .update(queueDismissals)
      .set({
        dismissedVersion: input.version,
        version: sql`${queueDismissals.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(queueDismissals.organizerId, input.organizerId),
          eq(queueDismissals.recordType, input.recordType),
          eq(queueDismissals.recordId, input.recordId),
        ),
      )
      .run();
    if (updated.changes > 0) return;

    db.insert(queueDismissals)
      .values({
        organizerId: input.organizerId,
        seasonId: input.seasonId,
        recordType: input.recordType,
        recordId: input.recordId,
        dismissedVersion: input.version,
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
  }

  return Object.freeze({
    listForOrganizer,
    listNewForOrganizer,
    countNewForOrganizer,
    dismiss,
  });
}

export type QueueRepository = ReturnType<typeof createQueueRepository>;
