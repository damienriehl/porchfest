// U8's participant bearer credentials and edits use migrated SQLite so expiry,
// revocation, scope, and KTD7's affected-row CAS are proved at the storage seam.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PARTICIPANT_TOKEN_TTL_MS,
  ParticipantTokenError,
  createParticipantTokenRepository,
  hashToken,
} from "../src/index.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import {
  annotations,
  contacts,
  participantMagicLinks,
} from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
let instant: Date;

beforeEach(async () => {
  database = await openTestDatabase("porchfest-participant-tokens-");
  instant = new Date("2031-04-01T12:00:00.000Z");
});

afterEach(async () => {
  await database.close();
});

function fixtures(options: { enabled?: boolean; reissueLimit?: number } = {}) {
  let tokenNumber = 0;
  const now = () => instant;
  const setup = createSeasonSetup(database.db, now);
  const seasons = createSeasonRepository(database.db, { now });
  const tokens = createParticipantTokenRepository(database.db, {
    enabled: options.enabled ?? true,
    now,
    createToken: () => `clear-participant-token-${++tokenNumber}`,
    reissueLimit: options.reissueLimit,
  });
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
  const firstHost = seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "First Host", email: "shared@example.invalid" },
    venue: {
      title: "First Porch",
      address: "1 Stored St",
      spaceDescription: "Front yard",
      hasPower: true,
      rainBackup: false,
      notes: "Participant note",
    },
    gear: ["pa"],
    drinks: ["water"],
    amenities: ["seating"],
  });
  const secondHost = seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "Second Host", email: "second@example.invalid" },
    venue: {
      title: "Second Porch",
      address: "2 Stored St",
      spaceDescription: "Back yard",
      hasPower: false,
      rainBackup: true,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
  const performer = seasons.createPerformerSignup({
    seasonId: season.id,
    contact: { name: "Act Contact", email: "shared@example.invalid" },
    act: {
      name: "The Tokens",
      durationMinutes: 45,
      requiresAmplification: false,
      genre: "Folk",
      description: "Songs about expiry",
      links: "https://example.invalid/tokens",
      housePreference: null,
      canLendGear: false,
      notes: "Act participant note",
    },
    availabilities: [],
  });
  return { tokens, seasons, season, firstHost, secondHost, performer };
}

describe("participant magic-link lifecycle", () => {
  it("stores only a hash, scopes the link, and refuses it after expiry", () => {
    const { tokens, firstHost } = fixtures();
    const issued = tokens.issue("venue", firstHost.venue.id);

    expect(issued.link.tokenHash).toBe(hashToken(issued.token));
    expect(JSON.stringify(issued.link)).not.toContain(issued.token);
    expect(issued.link.expiresAt.valueOf() - instant.valueOf()).toBe(
      DEFAULT_PARTICIPANT_TOKEN_TTL_MS,
    );
    expect(database.db.select().from(participantMagicLinks).all()).toHaveLength(
      1,
    );
    expect(tokens.resolve(issued.token)).toMatchObject({
      recordType: "venue",
      recordId: firstHost.venue.id,
      contactId: firstHost.contact.id,
    });

    instant = new Date(issued.link.expiresAt.valueOf());
    expect(() => tokens.resolve(issued.token)).toThrowError(
      expect.objectContaining({ reason: "expired" }),
    );
  });

  it("revokes the previous credential when the same record is reissued", () => {
    const { tokens, firstHost } = fixtures();
    const first = tokens.issue("venue", firstHost.venue.id);
    const second = tokens.issue("venue", firstHost.venue.id);

    expect(() => tokens.resolve(first.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(tokens.resolve(second.token).recordId).toBe(firstHost.venue.id);
  });

  it("keeps a reissue pending until delivery activation", () => {
    const { tokens, firstHost } = fixtures();
    const existing = tokens.issue("venue", firstHost.venue.id);
    const candidate = tokens
      .reissueForEmail("shared@example.invalid")
      .find(
        ({ link }) =>
          link.recordType === "venue" && link.recordId === firstHost.venue.id,
      )!;

    expect(candidate.link.activatedAt).toBeNull();
    expect(() => tokens.resolve(candidate.token)).toThrowError(
      expect.objectContaining({ reason: "invalid-token" }),
    );
    expect(tokens.resolve(existing.token).recordId).toBe(firstHost.venue.id);

    const activated = tokens.activateReissue(candidate.token);
    expect(activated.activatedAt).toEqual(instant);
    expect(() => tokens.resolve(existing.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(tokens.resolve(candidate.token).recordId).toBe(firstHost.venue.id);
  });

  it("keeps a newer pending reissue alive when the older delivery activates first", () => {
    const { tokens, firstHost } = fixtures();
    const existing = tokens.issue("venue", firstHost.venue.id);
    const older = tokens
      .reissueForEmail("shared@example.invalid")
      .find(
        ({ link }) =>
          link.recordType === "venue" && link.recordId === firstHost.venue.id,
      )!;
    const newer = tokens
      .reissueForEmail("shared@example.invalid")
      .find(
        ({ link }) =>
          link.recordType === "venue" && link.recordId === firstHost.venue.id,
      )!;

    expect(older.link.createdAt).toEqual(newer.link.createdAt);
    expect(older.link.id).toBeLessThan(newer.link.id);

    tokens.activateReissue(older.token);
    expect(tokens.resolve(older.token).recordId).toBe(firstHost.venue.id);
    expect(() => tokens.resolve(newer.token)).toThrowError(
      expect.objectContaining({ reason: "invalid-token" }),
    );

    tokens.activateReissue(newer.token);
    expect(() => tokens.resolve(existing.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(() => tokens.resolve(older.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(tokens.resolve(newer.token).recordId).toBe(firstHost.venue.id);
  });

  it("keeps the newest reissue active when the older delivery completes last", () => {
    const { tokens, firstHost } = fixtures();
    const existing = tokens.issue("venue", firstHost.venue.id);
    const older = tokens
      .reissueForEmail("shared@example.invalid")
      .find(
        ({ link }) =>
          link.recordType === "venue" && link.recordId === firstHost.venue.id,
      )!;
    const newer = tokens
      .reissueForEmail("shared@example.invalid")
      .find(
        ({ link }) =>
          link.recordType === "venue" && link.recordId === firstHost.venue.id,
      )!;

    tokens.activateReissue(newer.token);
    expect(() => tokens.resolve(existing.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(() => tokens.resolve(older.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(tokens.resolve(newer.token).recordId).toBe(firstHost.venue.id);

    expect(() => tokens.activateReissue(older.token)).toThrowError(
      expect.objectContaining({ reason: "invalid-token" }),
    );
    expect(tokens.resolve(newer.token).recordId).toBe(firstHost.venue.id);
  });

  it("abandons a failed delivery without revoking the live link or using success capacity", () => {
    const { tokens, firstHost } = fixtures({ reissueLimit: 1 });
    const existing = tokens.issue("venue", firstHost.venue.id);
    const firstAttempt = tokens
      .reissueForEmail("shared@example.invalid")
      .find(({ link }) => link.recordId === firstHost.venue.id)!;

    tokens.abandonReissue(firstAttempt.token);
    expect(tokens.resolve(existing.token).recordId).toBe(firstHost.venue.id);
    expect(() => tokens.resolve(firstAttempt.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );

    const retry = tokens
      .reissueForEmail("shared@example.invalid")
      .find(({ link }) => link.recordId === firstHost.venue.id)!;
    tokens.activateReissue(retry.token);
    expect(tokens.resolve(retry.token).recordId).toBe(firstHost.venue.id);
    expect(
      tokens
        .reissueForEmail("shared@example.invalid")
        .some(({ link }) => link.recordId === firstHost.venue.id),
    ).toBe(false);
  });

  it("caps reissues per target record without coupling records on one address", () => {
    const { tokens, firstHost, performer } = fixtures({ reissueLimit: 2 });

    expect(tokens.reissueForEmail("SHARED@example.invalid")).toHaveLength(2);
    expect(tokens.reissueForEmail("shared@example.invalid")).toHaveLength(2);
    expect(tokens.reissueForEmail("shared@example.invalid")).toEqual([]);

    instant = new Date(instant.valueOf() + 60 * 60_000 + 1);
    expect(tokens.reissueForEmail("shared@example.invalid")).toHaveLength(2);
    expect(
      tokens.resolve(tokens.issue("venue", firstHost.venue.id).token),
    ).toMatchObject({ recordId: firstHost.venue.id });
    expect(tokens.issue("act", performer.act.id).link.recordId).toBe(
      performer.act.id,
    );
  });

  it("cannot mint any link when participant self-serve is disabled", () => {
    const { tokens, firstHost } = fixtures({ enabled: false });

    expect(() => tokens.issue("venue", firstHost.venue.id)).toThrowError(
      expect.objectContaining({ reason: "disabled" }),
    );
    expect(() => tokens.reissueForEmail("shared@example.invalid")).toThrowError(
      ParticipantTokenError,
    );
  });

  it("revokes links when a record is withdrawn or superseded", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    const withdrawn = tokens.issue("venue", firstHost.venue.id);
    seasons.setRecordStatus(
      "venue",
      firstHost.venue.id,
      firstHost.venue.version,
      "withdrawn",
    );
    expect(() => tokens.resolve(withdrawn.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );

    const superseded = tokens.issue("venue", secondHost.venue.id);
    seasons.supersedeVenue(
      secondHost.venue.id,
      secondHost.venue.version,
      firstHost.venue.id,
    );
    expect(() => tokens.resolve(superseded.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
  });

  it("revokes links immediately when their contact is superseded", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    const issued = tokens.issue("venue", firstHost.venue.id);

    seasons.supersedeContact(
      firstHost.contact.id,
      firstHost.contact.version,
      secondHost.contact.id,
    );

    expect(() => tokens.resolve(issued.token)).toThrowError(
      expect.objectContaining({ reason: "revoked" }),
    );
  });

  it("falls back to a usable reach contact when a venue host contact is unusable", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    const noEmail = seasons.updateContact(
      secondHost.contact.id,
      secondHost.contact.version,
      { email: null },
    );
    const venue = seasons.updateVenue(
      firstHost.venue.id,
      firstHost.venue.version,
      {
        hostContactId: noEmail.id,
        reachViaContactId: firstHost.contact.id,
      },
    );

    const issued = tokens.issue("venue", venue.id);
    expect(issued.link.contactId).toBe(firstHost.contact.id);
    expect(issued.email).toBe("shared@example.invalid");
    expect(
      tokens
        .reissueForEmail("shared@example.invalid")
        .some(
          ({ link }) =>
            link.recordType === "venue" && link.recordId === venue.id,
        ),
    ).toBe(true);
  });

  it("refuses a token for one record from writing another record", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    const issued = tokens.issue("venue", firstHost.venue.id);

    expect(() =>
      tokens.update(issued.token, {
        recordType: "venue",
        recordId: secondHost.venue.id,
        recordVersion: secondHost.venue.version,
        contactVersion: secondHost.contact.version,
        contact: { name: "Trespass", email: "trespass@example.invalid" },
        record: { title: "Trespassed" },
        gear: [],
        drinks: [],
        amenities: [],
      }),
    ).toThrowError(expect.objectContaining({ reason: "wrong-record" }));
    expect(seasons.getVenue(secondHost.venue.id).title).toBe("Second Porch");
  });

  it("rolls an edit back when the organizer changed the record mid-session", () => {
    const { tokens, seasons, firstHost } = fixtures();
    const issued = tokens.issue("venue", firstHost.venue.id);
    seasons.updateVenue(firstHost.venue.id, firstHost.venue.version, {
      spaceDescription: "Organizer correction",
    });

    expect(() =>
      tokens.update(issued.token, {
        recordType: "venue",
        recordId: firstHost.venue.id,
        recordVersion: firstHost.venue.version,
        contactVersion: firstHost.contact.version,
        contact: {
          name: "Participant changed",
          email: "changed@example.invalid",
          phone: "555-0100",
        },
        record: { spaceDescription: "Participant correction" },
        gear: ["microphone"],
        drinks: [],
        amenities: [],
      }),
    ).toThrowError(/conflict/i);
    expect(seasons.getContact(firstHost.contact.id)).toMatchObject({
      name: "First Host",
      email: "shared@example.invalid",
    });
    expect(seasons.getVenue(firstHost.venue.id).spaceDescription).toBe(
      "Organizer correction",
    );
  });

  it("round-trips participant fields while leaving organizer annotations alone", () => {
    const { tokens, season, firstHost } = fixtures();
    database.db
      .insert(annotations)
      .values({
        seasonId: season.id,
        recordType: "venue",
        recordId: firstHost.venue.id,
        note: "Organizer-only annotation",
      })
      .run();
    const issued = tokens.issue("venue", firstHost.venue.id);

    const updated = tokens.update(issued.token, {
      recordType: "venue",
      recordId: firstHost.venue.id,
      recordVersion: firstHost.venue.version,
      contactVersion: firstHost.contact.version,
      contact: {
        name: "First Host",
        email: "shared@example.invalid",
        phone: "555-0199",
      },
      record: {
        title: "First Porch",
        spaceDescription: "Front yard and driveway",
        hasPower: true,
        rainBackup: true,
        requestedActNames: "The Tokens",
        genrePreferences: "Folk",
        notes: "Updated participant note",
      },
      gear: ["pa", "microphone"],
      drinks: ["water"],
      amenities: ["seating", "shade"],
    });

    expect(updated.record.notes).toBe("Updated participant note");
    expect(updated.contact.phone).toBe("555-0199");
    expect(
      database.sqlite
        .prepare("select note from annotations where record_id = ?")
        .all(firstHost.venue.id),
    ).toEqual([{ note: "Organizer-only annotation" }]);
  });

  it("clones a shared contact and repoints only the granted record and its live links", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    const sharedVenue = seasons.updateVenue(
      secondHost.venue.id,
      secondHost.venue.version,
      { hostContactId: firstHost.contact.id },
    );
    const issued = tokens.issue("venue", firstHost.venue.id);

    const updated = tokens.update(issued.token, {
      recordType: "venue",
      recordId: firstHost.venue.id,
      recordVersion: firstHost.venue.version,
      contactVersion: firstHost.contact.version,
      contact: {
        name: "First Host Corrected",
        email: "corrected@example.invalid",
        phone: "555-0112",
      },
      record: { title: "First Porch Corrected" },
      gear: ["pa"],
      drinks: ["water"],
      amenities: ["seating"],
    });

    expect(updated.contact.id).not.toBe(firstHost.contact.id);
    expect(seasons.getContact(firstHost.contact.id)).toMatchObject({
      name: "First Host",
      email: "shared@example.invalid",
    });
    expect(seasons.getVenue(sharedVenue.id).hostContactId).toBe(
      firstHost.contact.id,
    );
    if (updated.recordType !== "venue") {
      throw new Error("expected a venue edit result");
    }
    expect(updated.record.hostContactId).toBe(updated.contact.id);
    expect(tokens.resolve(issued.token).contactId).toBe(updated.contact.id);
    expect(tokens.read(issued.token).contact.email).toBe(
      "corrected@example.invalid",
    );
  });

  it("guards a shared-contact clone with the submitted contact version", () => {
    const { tokens, seasons, firstHost, secondHost } = fixtures();
    seasons.updateVenue(secondHost.venue.id, secondHost.venue.version, {
      hostContactId: firstHost.contact.id,
    });
    const issued = tokens.issue("venue", firstHost.venue.id);
    seasons.updateContact(firstHost.contact.id, firstHost.contact.version, {
      phone: "555-0101",
    });
    const contactCount = database.db.select().from(contacts).all().length;

    expect(() =>
      tokens.update(issued.token, {
        recordType: "venue",
        recordId: firstHost.venue.id,
        recordVersion: firstHost.venue.version,
        contactVersion: firstHost.contact.version,
        contact: { email: "stale@example.invalid" },
        record: { title: "Must roll back" },
        gear: ["pa"],
        drinks: ["water"],
        amenities: ["seating"],
      }),
    ).toThrowError(/contact.*conflict/i);
    expect(database.db.select().from(contacts).all()).toHaveLength(
      contactCount,
    );
    expect(seasons.getVenue(firstHost.venue.id).title).toBe("First Porch");
  });
});
