// R6's statuses and AE2. The interesting behaviour is not the column — it is what
// withdrawing does to a booked slot, and what it must NOT do to the send history.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import {
  assignments,
  emailLog,
  slots,
  type Season,
} from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
let clock = new Date("2027-03-01T12:00:00.000Z");

beforeEach(async () => {
  database = await openTestDatabase("porchfest-status-");
  clock = new Date("2027-03-01T12:00:00.000Z");
});

afterEach(async () => {
  await database.close();
});

function fixtures() {
  const now = () => clock;
  const seasons = createSeasonRepository(database.db, { now });
  const { season } = createSeasonSetup(database.db, now).createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "UTC",
    eventDate: "2031-09-13",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [],
    openSignups: true,
  });

  const host = seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "Host", email: "host@example.invalid", phone: null },
    venue: {
      title: "The Test Porch",
      address: "1 Test St",
      spaceDescription: "Porch",
      hasPower: true,
      rainBackup: false,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
  const performer = seasons.createPerformerSignup({
    seasonId: season.id,
    contact: { name: "Act", email: "act@example.invalid", phone: null },
    act: {
      name: "The Sidewalk Trio",
      durationMinutes: 45,
      requiresAmplification: false,
      genre: "Folk",
      description: "Songs",
      links: "",
      housePreference: null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [
      {
        startsAt: new Date("2031-09-13T19:00:00.000Z"),
        endsAt: new Date("2031-09-13T21:00:00.000Z"),
      },
    ],
  });

  return { seasons, season, host, performer };
}

function bookSlot(
  season: Season,
  venueId: number,
  actId: number,
  recipientContactId: number,
) {
  const stamp = clock;
  const slot = database.db
    .insert(slots)
    .values({
      seasonId: season.id,
      venueId,
      startsAt: new Date("2031-09-13T19:00:00.000Z"),
      endsAt: new Date("2031-09-13T20:00:00.000Z"),
      state: "assigned",
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
  database.db
    .insert(assignments)
    .values({
      seasonId: season.id,
      actId,
      slotId: slot.id,
      version: 1,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .run();
  database.db
    .insert(emailLog)
    .values({
      seasonId: season.id,
      recordType: "act",
      recordId: actId,
      waveLabel: "match-notification",
      recipientContactId,
    })
    .run();
  return slot;
}

describe("record status", () => {
  it("defaults a fresh public submission to tentative", () => {
    const { host, performer } = fixtures();

    // Received is not the same as agreed.
    expect(host.venue.status).toBe("tentative");
    expect(performer.act.status).toBe("tentative");
  });

  it("records an organizer's confirmation", () => {
    const { seasons, host } = fixtures();

    seasons.setRecordStatus(
      "venue",
      host.venue.id,
      host.venue.version,
      "confirmed",
    );

    const venue = seasons
      .listActivityQueue(host.venue.seasonId)
      .find((item) => item.recordType === "venue");
    expect(venue?.recordType === "venue" && venue.record.status).toBe(
      "confirmed",
    );
  });

  it("refuses a stale status write instead of overwriting", () => {
    const { seasons, host } = fixtures();
    seasons.setRecordStatus(
      "venue",
      host.venue.id,
      host.venue.version,
      "confirmed",
    );

    // Same expected version a second time: someone else already moved it.
    expect(() =>
      seasons.setRecordStatus(
        "venue",
        host.venue.id,
        host.venue.version,
        "withdrawn",
      ),
    ).toThrowError(/conflict/i);
  });
});

describe("AE2: withdrawing an act", () => {
  it("reopens the slot it held", () => {
    const { seasons, season, host, performer } = fixtures();
    const slot = bookSlot(
      season,
      host.venue.id,
      performer.act.id,
      performer.contact.id,
    );

    const result = seasons.setRecordStatus(
      "act",
      performer.act.id,
      performer.act.version,
      "withdrawn",
    );

    expect(result.reopenedSlotIds).toEqual([slot.id]);
    const after = database.db
      .select()
      .from(slots)
      .where(eq(slots.id, slot.id))
      .get();
    // The evening must not keep a booked slot for an act that is not coming.
    expect(after?.state).toBe("open");
    expect(database.db.select().from(assignments).all()).toHaveLength(0);
  });

  it("leaves the email history intact", () => {
    const { seasons, season, host, performer } = fixtures();
    bookSlot(season, host.venue.id, performer.act.id, performer.contact.id);

    seasons.setRecordStatus(
      "act",
      performer.act.id,
      performer.act.version,
      "withdrawn",
    );

    // "We already wrote to them" stays true whatever happens next.
    const history = database.db.select().from(emailLog).all();
    expect(history).toHaveLength(1);
    expect(history[0]?.waveLabel).toBe("match-notification");
  });

  it("does not touch slots when the status is not a withdrawal", () => {
    const { seasons, season, host, performer } = fixtures();
    const slot = bookSlot(
      season,
      host.venue.id,
      performer.act.id,
      performer.contact.id,
    );

    seasons.setRecordStatus(
      "act",
      performer.act.id,
      performer.act.version,
      "confirmed",
    );

    const after = database.db
      .select()
      .from(slots)
      .where(eq(slots.id, slot.id))
      .get();
    expect(after?.state).toBe("assigned");
    expect(database.db.select().from(assignments).all()).toHaveLength(1);
  });

  it("reopens a withdrawn venue's slots too", () => {
    const { seasons, season, host, performer } = fixtures();
    const slot = bookSlot(
      season,
      host.venue.id,
      performer.act.id,
      performer.contact.id,
    );

    const result = seasons.setRecordStatus(
      "venue",
      host.venue.id,
      host.venue.version,
      "withdrawn",
    );

    // A porch pulling out strands its acts exactly the same way.
    expect(result.reopenedSlotIds).toEqual([slot.id]);
    expect(
      database.db.select().from(slots).where(eq(slots.id, slot.id)).get()
        ?.state,
    ).toBe("open");
  });

  it("is all-or-nothing", () => {
    const { seasons, season, host, performer } = fixtures();
    bookSlot(season, host.venue.id, performer.act.id, performer.contact.id);

    // A stale version refuses before anything is released.
    expect(() =>
      seasons.setRecordStatus("act", performer.act.id, 999, "withdrawn"),
    ).toThrowError();

    expect(database.db.select().from(assignments).all()).toHaveLength(1);
  });
});
