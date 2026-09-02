// R35. Retention removes participant identity while keeping the season graph and
// non-identifying send history intact.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANONYMIZED_CONTACT_NAME,
  RetentionConflictError,
  createRetentionRepository,
} from "../src/retention.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import {
  acts,
  annotations,
  changeRequests,
  contacts,
  deletionReceipts,
  emailLog,
  seasons,
  venueCoordinates,
  venues,
} from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
const clock = new Date("2032-07-15T12:00:00.000Z");

beforeEach(async () => {
  database = await openTestDatabase("porchfest-retention-");
});

afterEach(async () => {
  await database.close();
});

function fixtures(state: "signups_open" | "archived" = "signups_open") {
  const now = () => clock;
  const setup = createSeasonSetup(database.db, now);
  const repository = createSeasonRepository(database.db, { now });
  const { season } = setup.createSeason({
    year: 2032,
    displayName: "Synthetic Retention Season",
    timezone: "UTC",
    eventDate: "2032-09-11",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [],
    openSignups: true,
  });
  const signup = repository.createHostSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic Host",
      email: "synthetic-host@example.invalid",
      phone: "synthetic-host-phone",
    },
    venue: {
      title: "Synthetic Porch",
      address: "synthetic-host-address",
      spaceDescription:
        "Synthetic Host uses the private synthetic-unit entrance",
      hasPower: true,
      rainBackup: false,
      notes:
        "Ask Synthetic Host at synthetic-host-phone about the synthetic-unit access",
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
  database.db
    .update(contacts)
    .set({ updatedAt: new Date("2030-07-14T12:00:00.000Z") })
    .where(eq(contacts.id, signup.contact.id))
    .run();
  database.db
    .insert(venueCoordinates)
    .values({
      venueId: signup.venue.id,
      latitude: 0.25,
      longitude: -0.5,
      source: "geocoded",
      precision: "parcel",
      provider: "fixture",
      ref: "way/1",
      status: "verified",
      addressAtGeocode: "synthetic-host-address",
      updatedAt: clock,
    })
    .run();
  const act = database.db
    .insert(acts)
    .values({
      seasonId: season.id,
      name: "Synthetic Band",
      genre: "Folk",
      description: "A band description that survives",
      links: "https://example.invalid/synthetic-band",
      notes: "Synthetic Host handles scheduling",
      reachViaContactId: signup.contact.id,
      createdAt: clock,
      updatedAt: clock,
    })
    .returning()
    .get();
  const annotation = database.db
    .insert(annotations)
    .values({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      note: "Synthetic Host prefers email",
      createdAt: clock,
      updatedAt: clock,
    })
    .returning()
    .get();
  const request = database.db
    .insert(changeRequests)
    .values({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedValue: "synthetic-corrected-address",
      createdAt: clock,
      updatedAt: clock,
    })
    .returning()
    .get();
  const history = database.db
    .insert(emailLog)
    .values({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      waveLabel: "synthetic-wave",
      recipientContactId: signup.contact.id,
      sentAt: clock,
    })
    .returning()
    .get();
  if (state === "archived") {
    database.db
      .update(seasons)
      .set({ state: "archived" })
      .where(eq(seasons.id, season.id))
      .run();
  }
  return { act, annotation, history, request, season, signup };
}

describe("participant anonymization", () => {
  it("scrubs active participant data and preserves structural and send history", () => {
    const { act, annotation, history, request, signup } = fixtures();
    const supersededContact = database.db
      .insert(contacts)
      .values({
        seasonId: signup.contact.seasonId,
        name: "Synthetic Duplicate Host",
        email: "synthetic-duplicate-host@example.invalid",
        phone: "synthetic-duplicate-host-phone",
        originalSubmission: JSON.stringify({
          version: 1,
          values: { name: "Synthetic Duplicate Host" },
        }),
        canonicalContactId: signup.contact.id,
        createdAt: clock,
        updatedAt: clock,
      })
      .returning()
      .get();
    database.db
      .update(acts)
      .set({
        reachViaContactId: supersededContact.id,
        originalSubmission: JSON.stringify({
          version: 1,
          values: { name: "Synthetic Band" },
        }),
      })
      .where(eq(acts.id, act.id))
      .run();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });

    const result = retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });

    expect(
      database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, signup.contact.id))
        .get(),
    ).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
      originalSubmission: null,
    });
    expect(
      database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, supersededContact.id))
        .get(),
    ).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
      originalSubmission: null,
      canonicalContactId: signup.contact.id,
    });
    expect(
      database.db
        .select()
        .from(venues)
        .where(eq(venues.id, signup.venue.id))
        .get(),
    ).toMatchObject({
      title: "Synthetic Porch",
      address: null,
      spaceDescription: null,
      notes: null,
      originalSubmission: null,
    });
    expect(
      database.db
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.venueId, signup.venue.id))
        .get(),
    ).toBeUndefined();
    expect(
      database.db.select().from(acts).where(eq(acts.id, act.id)).get(),
    ).toMatchObject({
      name: "Synthetic Band",
      genre: "Folk",
      description: "A band description that survives",
      links: "https://example.invalid/synthetic-band",
      notes: null,
      originalSubmission: null,
    });
    expect(
      database.db
        .select()
        .from(annotations)
        .where(eq(annotations.id, annotation.id))
        .get(),
    ).toMatchObject({ note: "[participant note anonymized]" });
    expect(
      database.db
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.id, request.id))
        .get(),
    ).toMatchObject({ proposedValue: null, status: "rejected" });
    expect(
      database.db
        .select()
        .from(emailLog)
        .where(eq(emailLog.id, history.id))
        .get(),
    ).toEqual(history);
    expect(result.receipt.contactId).toBe(signup.contact.id);
  });

  it("covers a participant whose season is archived", () => {
    const { signup } = fixtures("archived");
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });

    retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });

    expect(
      database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, signup.contact.id))
        .get(),
    ).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
    });
    expect(
      database.db
        .select()
        .from(venues)
        .where(eq(venues.id, signup.venue.id))
        .get(),
    ).toMatchObject({ address: null });
  });

  it("closes a pending proposal when anonymization makes it undecodable", () => {
    const { request, signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });

    retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });

    expect(
      database.db
        .select({
          proposedValue: changeRequests.proposedValue,
          status: changeRequests.status,
        })
        .from(changeRequests)
        .where(eq(changeRequests.id, request.id))
        .get(),
    ).toEqual({ proposedValue: null, status: "rejected" });
  });

  it("refuses a stale version", () => {
    const { signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });
    database.db
      .update(contacts)
      .set({ version: signup.contact.version + 1 })
      .where(eq(contacts.id, signup.contact.id))
      .run();

    expect(() =>
      retention.anonymizeParticipant({
        contactId: signup.contact.id,
        expectedVersion: signup.contact.version,
      }),
    ).toThrow(RetentionConflictError);
    expect(database.db.select().from(deletionReceipts).all()).toHaveLength(0);
  });

  it("lets only one concurrent same-version attempt succeed against the database", async () => {
    const { signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });
    const input = {
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    };

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => retention.anonymizeParticipant(input)),
      Promise.resolve().then(() => retention.anonymizeParticipant(input)),
    ]);

    expect(attempts.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(RetentionConflictError);
    expect(database.db.select().from(deletionReceipts).all()).toHaveLength(1);
  });

  it("is idempotent when retried with the current anonymized version", () => {
    const { signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });
    const first = retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });

    const second = retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: first.contact.version,
    });

    expect(second).toEqual(first);
    expect(database.db.select().from(deletionReceipts).all()).toHaveLength(1);
  });

  it("writes a non-identifying receipt awaiting off-host backup rotation", () => {
    const { signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
    });

    retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });

    const receipts = retention.listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ backupStatus: "pending" });
    const serialized = JSON.stringify(receipts[0]);
    for (const identifyingValue of [
      "Synthetic Host",
      "synthetic-host@example.invalid",
      "synthetic-host-phone",
      "synthetic-host-address",
    ]) {
      expect(serialized).not.toContain(identifyingValue);
    }
  });
});

describe("retention eligibility", () => {
  it("includes a record just outside the configured window, not one just inside", () => {
    const { season } = fixtures();
    const outside = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Outside",
        updatedAt: new Date("2030-07-15T11:59:59.000Z"),
      })
      .returning()
      .get();
    const inside = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Inside",
        updatedAt: new Date("2030-07-15T12:00:01.000Z"),
      })
      .returning()
      .get();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });

    const eligibleIds = retention.listEligible().map((contact) => contact.id);

    expect(eligibleIds).toContain(outside.id);
    expect(eligibleIds).not.toContain(inside.id);
  });

  it("anonymizes every eligible record and leaves newer records intact", () => {
    const { season } = fixtures();
    const old = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Old",
        updatedAt: new Date("2030-07-14T12:00:00.000Z"),
      })
      .returning()
      .get();
    const recent = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Recent",
        updatedAt: new Date("2030-07-16T12:00:00.000Z"),
      })
      .returning()
      .get();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });

    const results = retention.anonymizeEligible();

    expect(results.map((result) => result.contact.id)).toContain(old.id);
    expect(
      database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, recent.id))
        .get()?.name,
    ).toBe("Synthetic Recent");
    expect(
      database.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.id, old.id),
            eq(contacts.name, ANONYMIZED_CONTACT_NAME),
          ),
        )
        .get(),
    ).toBeDefined();
  });

  it("keeps one consistent receipt when two sweep attempts race", async () => {
    const { signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => retention.anonymizeEligible()),
      Promise.resolve().then(() => retention.anonymizeEligible()),
    ]);

    expect([...first, ...second].map(({ contact }) => contact.id)).toEqual([
      signup.contact.id,
    ]);
    expect(retention.listReceipts()).toMatchObject([
      { contactId: signup.contact.id, action: "retention", version: 1 },
    ]);
    expect(retention.anonymizeEligible()).toEqual([]);
  });

  it("refuses a direct anonymization inside the retention window", () => {
    const { season } = fixtures();
    const recent = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Recent Direct",
        email: "synthetic-recent-direct@example.invalid",
        phone: "synthetic-recent-direct-phone",
        updatedAt: clock,
      })
      .returning()
      .get();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });

    expect(() =>
      retention.anonymizeParticipant({
        contactId: recent.id,
        expectedVersion: recent.version,
      }),
    ).toThrow(RetentionConflictError);
    expect(retention.findParticipant(recent.id)).toMatchObject({
      name: "Synthetic Recent Direct",
      email: "synthetic-recent-direct@example.invalid",
      phone: "synthetic-recent-direct-phone",
    });
  });

  it("anonymizes an old superseded identity while its canonical stays recent", () => {
    const { season, signup } = fixtures();
    const seasons = createSeasonRepository(database.db, { now: () => clock });
    const recentCanonical = seasons.updateContact(
      signup.contact.id,
      signup.contact.version,
      { name: "Synthetic Canonical Revised" },
    );
    const oldSuperseded = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Old Duplicate",
        email: "synthetic-old-duplicate@example.invalid",
        phone: "synthetic-old-duplicate-phone",
        canonicalContactId: signup.contact.id,
        createdAt: new Date("2030-07-14T12:00:00.000Z"),
        updatedAt: new Date("2030-07-14T12:00:00.000Z"),
      })
      .returning()
      .get();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });

    expect(retention.listEligible().map(({ id }) => id)).toContain(
      oldSuperseded.id,
    );
    retention.anonymizeEligible();

    expect(retention.findParticipant(oldSuperseded.id)).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
    });
    expect(retention.findParticipant(recentCanonical.id)).toMatchObject({
      name: "Synthetic Canonical Revised",
      email: "synthetic-host@example.invalid",
      phone: "synthetic-host-phone",
    });
  });

  it("reaches a contact newly superseded into an anonymized canonical", () => {
    const { season, signup } = fixtures();
    const retention = createRetentionRepository(database.db, {
      now: () => clock,
      retentionMonths: 24,
    });
    const canonicalResult = retention.anonymizeParticipant({
      contactId: signup.contact.id,
      expectedVersion: signup.contact.version,
    });
    const recentDuplicate = database.db
      .insert(contacts)
      .values({
        seasonId: season.id,
        name: "Synthetic Newly Superseded",
        email: "synthetic-newly-superseded@example.invalid",
        phone: "synthetic-newly-superseded-phone",
        createdAt: clock,
        updatedAt: clock,
      })
      .returning()
      .get();
    const seasons = createSeasonRepository(database.db, { now: () => clock });
    const superseded = seasons.supersedeContact(
      recentDuplicate.id,
      recentDuplicate.version,
      canonicalResult.contact.id,
    );

    expect(retention.listEligible().map(({ id }) => id)).toContain(
      superseded.id,
    );
    retention.anonymizeEligible();
    const versionAfterAnonymization = retention.findParticipant(
      superseded.id,
    )?.version;

    expect(retention.findParticipant(superseded.id)).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
    });
    expect(retention.listReceipts().map(({ contactId }) => contactId)).toEqual(
      expect.arrayContaining([canonicalResult.contact.id, superseded.id]),
    );
    expect(retention.anonymizeEligible()).toEqual([]);
    expect(retention.findParticipant(superseded.id)?.version).toBe(
      versionAfterAnonymization,
    );
  });
});
