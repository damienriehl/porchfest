import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createRetentionRepository,
  normalizeRetentionMonths,
  RetentionLifecycleError,
  ANONYMIZED_CONTACT_NAME,
} from "../src/retention.js";
import { createSeasonSetup } from "../src/setup.js";
import { contacts, venues, deletionReceipts } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("retention transaction and calendar boundaries", () => {
  let database: TestDatabase;
  let seasonId: number;
  let stamp: Date;
  beforeEach(async () => {
    database = await openTestDatabase("retention-transaction-");
    stamp = new Date("2032-03-31T12:00:00Z");
    seasonId = createSeasonSetup(database.db, () => stamp).createSeason({
      year: 2032,
      displayName: "Retention",
      timezone: "UTC",
      eventDate: "2032-09-01",
      eventCity: "Example",
      eventState: "WI",
      timeSlots: [],
      openSignups: true,
    }).season.id;
  });
  afterEach(async () => {
    await database.close();
  });
  function contact(
    name: string,
    updatedAt = new Date("2029-01-01T00:00:00Z"),
    canonicalContactId: number | null = null,
  ) {
    return database.db
      .insert(contacts)
      .values({
        seasonId,
        name,
        email: `${name}@example.invalid`,
        createdAt: updatedAt,
        updatedAt,
        canonicalContactId,
      })
      .returning()
      .get();
  }
  const repo = () =>
    createRetentionRepository(database.db, {
      now: () => stamp,
      retentionMonths: 1,
    });
  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "defaults invalid month policy %s",
    (value) => {
      expect(normalizeRetentionMonths(value)).toBe(24);
    },
  );
  it.each([
    ["2032-03-31T12:00:00Z", "2032-02-29T12:00:00Z"],
    ["2031-03-31T12:00:00Z", "2031-02-28T12:00:00Z"],
    ["2032-01-31T12:00:00Z", "2031-12-31T12:00:00Z"],
  ])("clamps calendar subtraction at %s", (now, cutoff) => {
    stamp = new Date(now);
    const before = contact(
      "before",
      new Date(new Date(cutoff).valueOf() - 1000),
    );
    contact("exact", new Date(cutoff));
    contact("after", new Date(new Date(cutoff).valueOf() + 1000));
    expect(
      repo()
        .listEligible()
        .map((row) => row.id),
    ).toEqual([before.id]);
  });
  it("returns empty states and a lifecycle error for a missing participant", () => {
    expect(repo().findParticipant(999)).toBeNull();
    expect(repo().listReceipts()).toEqual([]);
    expect(repo().anonymizeEligible()).toEqual([]);
    expect(() =>
      repo().anonymizeParticipant({ contactId: 999, expectedVersion: 1 }),
    ).toThrow(RetentionLifecycleError);
  });
  it("scrubs an entire descendant chain once while leaving a disconnected cycle untouched", () => {
    const root = contact("root");
    const child = contact("child", stamp, root.id);
    const grandchild = contact("grandchild", stamp, child.id);
    const cycleA = contact("cycle-a", stamp);
    const cycleB = contact("cycle-b", stamp, cycleA.id);
    database.db
      .update(contacts)
      .set({ canonicalContactId: cycleB.id })
      .where(eq(contacts.id, cycleA.id))
      .run();
    const venue = database.db
      .insert(venues)
      .values({
        seasonId,
        title: "Descendant porch",
        address: "Private address",
        hostContactId: grandchild.id,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    const result = repo().anonymizeEligible();
    expect(result).toHaveLength(1);
    for (const id of [root.id, child.id, grandchild.id])
      expect(repo().findParticipant(id)).toMatchObject({
        name: ANONYMIZED_CONTACT_NAME,
        email: null,
        version: 2,
      });
    expect(repo().findParticipant(cycleA.id)).toMatchObject({
      name: "cycle-a",
      version: 1,
    });
    expect(
      database.db.select().from(venues).where(eq(venues.id, venue.id)).get(),
    ).toMatchObject({ address: null, version: 2 });
    expect(repo().listReceipts()).toHaveLength(3);
    expect(repo().anonymizeEligible()).toEqual([]);
  });
  it("does not rewrite a descendant already carrying a deletion receipt", () => {
    const root = contact("root");
    const child = contact("child", stamp, root.id);
    database.db
      .insert(deletionReceipts)
      .values({
        contactId: child.id,
        action: "retention",
        applicationAnonymizedAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .run();
    repo().anonymizeParticipant({
      contactId: root.id,
      expectedVersion: root.version,
    });
    expect(repo().findParticipant(child.id)).toEqual(child);
    expect(repo().listReceipts()).toHaveLength(2);
  });
  it("rolls back earlier participants and linked venue scrubs when the sweep cannot persist a later receipt", () => {
    const first = contact("first");
    const second = contact("second");
    const venue = database.db
      .insert(venues)
      .values({
        seasonId,
        title: "Porch",
        address: "Private address",
        hostContactId: first.id,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    database.sqlite.exec(
      `CREATE TRIGGER fail_later_receipt BEFORE INSERT ON deletion_receipts WHEN NEW.contact_id = ${second.id} BEGIN SELECT RAISE(ABORT, 'receipt storage failure'); END`,
    );
    expect(() => repo().anonymizeEligible()).toThrow("receipt storage failure");
    expect(repo().findParticipant(first.id)).toEqual(first);
    expect(repo().findParticipant(second.id)).toEqual(second);
    expect(
      database.db.select().from(venues).where(eq(venues.id, venue.id)).get(),
    ).toEqual(venue);
    expect(repo().listReceipts()).toEqual([]);
    database.sqlite.exec("DROP TRIGGER fail_later_receipt");
    expect(repo().anonymizeEligible()).toHaveLength(2);
  });
  it("orders receipts newest first across separate anonymizations", () => {
    const first = contact("first");
    const second = contact("second");
    repo().anonymizeParticipant({ contactId: first.id, expectedVersion: 1 });
    stamp = new Date(stamp.valueOf() + 1000);
    repo().anonymizeParticipant({ contactId: second.id, expectedVersion: 1 });
    expect(
      repo()
        .listReceipts()
        .map((row) => row.contactId),
    ).toEqual([second.id, first.id]);
  });
});
