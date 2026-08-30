// R5 and R15. The property under test is that "new" belongs to an organizer, not
// to the record — and that a participant edit brings an item back without anything
// having to notice the edit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessRepository } from "../src/access.js";
import { createQueueRepository } from "../src/queue.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
let clock = new Date("2027-03-01T12:00:00.000Z");

beforeEach(async () => {
  database = await openTestDatabase("porchfest-queue-");
  clock = new Date("2027-03-01T12:00:00.000Z");
});

afterEach(async () => {
  await database.close();
});

function fixtures() {
  const now = () => clock;
  const setup = createSeasonSetup(database.db, now);
  const seasons = createSeasonRepository(database.db, { now });
  const queue = createQueueRepository(database.db, now);
  const access = createAccessRepository(database.db, { now });

  const { season } = setup.createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "UTC",
    eventDate: "2031-09-13",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [],
    openSignups: true,
  });

  const organizer = (email: string) => {
    const link = access.hasAnyOrganizer()
      ? access.issueInvite(email, 1)
      : access.issueBootstrapLink();
    return access.redeemLink({ token: link.token, displayName: email, email })
      .organizer;
  };

  const host = () =>
    seasons.createHostSignup({
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

  return { season, queue, seasons, organizer, host };
}

function advance(ms: number) {
  clock = new Date(clock.valueOf() + ms);
}

describe("new activity is per organizer", () => {
  it("shows a fresh signup as new to every organizer", () => {
    const { season, queue, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const bob = organizer("bob@example.invalid");
    host();

    expect(queue.countNewForOrganizer(season.id, alice.id)).toBeGreaterThan(0);
    expect(queue.countNewForOrganizer(season.id, bob.id)).toBeGreaterThan(0);
  });

  it("does not hide an item from a second organizer when the first dismisses it", () => {
    const { season, queue, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const bob = organizer("bob@example.invalid");
    const signup = host();

    queue.dismiss({
      organizerId: alice.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      version: signup.venue.version,
    });

    const aliceSees = queue
      .listNewForOrganizer(season.id, alice.id)
      .some((item) => item.recordType === "venue");
    const bobSees = queue
      .listNewForOrganizer(season.id, bob.id)
      .some((item) => item.recordType === "venue");

    // This is R5's whole point: the queue is a per-organizer worklist, not a
    // shared inbox that the fastest reader empties for everyone.
    expect(aliceSees).toBe(false);
    expect(bobSees).toBe(true);
  });
});

describe("an edit brings the item back", () => {
  it("re-surfaces a dismissed record after a participant edit", () => {
    const { season, queue, seasons, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const signup = host();
    queue.dismiss({
      organizerId: alice.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      version: signup.venue.version,
    });
    expect(
      queue
        .listNewForOrganizer(season.id, alice.id)
        .some((item) => item.recordType === "venue"),
    ).toBe(false);

    advance(60_000);
    seasons.updateVenue(signup.venue.id, signup.venue.version, {
      address: "2 Corrected St",
    });

    // R15. Nothing observed the edit; the version simply moved past the
    // dismissal, which is what makes this hard to forget to implement.
    expect(
      queue
        .listNewForOrganizer(season.id, alice.id)
        .some((item) => item.recordType === "venue"),
    ).toBe(true);
  });

  it("stays dismissed when the organizer re-reviews the newer version", () => {
    const { season, queue, seasons, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const signup = host();
    advance(60_000);
    const edited = seasons.updateVenue(signup.venue.id, signup.venue.version, {
      address: "2 Corrected St",
    });

    queue.dismiss({
      organizerId: alice.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: edited.id,
      version: edited.version,
    });

    expect(
      queue
        .listNewForOrganizer(season.id, alice.id)
        .some((item) => item.recordType === "venue"),
    ).toBe(false);
  });

  it("does not swallow an edit that landed while the organizer was reading", () => {
    const { season, queue, seasons, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const signup = host();
    const versionAliceSaw = signup.venue.version;

    // The participant edits after the page rendered but before the dismiss.
    advance(30_000);
    seasons.updateVenue(signup.venue.id, versionAliceSaw, {
      address: "2 Corrected St",
    });

    queue.dismiss({
      organizerId: alice.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      version: versionAliceSaw,
    });

    // Dismissing at the version actually seen leaves the newer one unreviewed.
    // Reading the current version inside dismiss() would have lost that edit.
    expect(
      queue
        .listNewForOrganizer(season.id, alice.id)
        .some((item) => item.recordType === "venue"),
    ).toBe(true);
  });
});

describe("the full record list", () => {
  it("keeps showing a dismissed record, marked as not new", () => {
    const { season, queue, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const signup = host();
    queue.dismiss({
      organizerId: alice.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      version: signup.venue.version,
    });

    // R5 asks for a queue PLUS full record lists; dismissing must not delete.
    const venue = queue
      .listForOrganizer(season.id, alice.id)
      .find((item) => item.recordType === "venue");
    expect(venue).toBeDefined();
    expect(venue?.isNew).toBe(false);
  });

  it("orders the most recently touched record first", () => {
    const { season, queue, seasons, organizer, host } = fixtures();
    const alice = organizer("alice@example.invalid");
    const signup = host();

    advance(60_000);
    seasons.updateContact(signup.contact.id, signup.contact.version, {
      name: "Corrected Host",
    });

    const [first] = queue.listForOrganizer(season.id, alice.id);
    expect(first?.recordType).toBe("contact");
  });
});
