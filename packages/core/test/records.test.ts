import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordConflictError, createRecordRepository } from "../src/records.js";
import {
  SeasonLifecycleError,
  createSeasonRepository,
} from "../src/season.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("record lifecycle", () => {
  let database: TestDatabase;
  let sqlite: Database.Database;
  let records: ReturnType<typeof createRecordRepository>;
  const pinnedNow = new Date("2102-06-01T12:00:00.123Z");

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-records-");
    sqlite = database.sqlite;
    records = createRecordRepository(database.db, {
      now: () => pinnedNow,
    });
  });

  afterEach(async () => {
    await database.close();
  });

  function insertSeason(): number {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2102, "CAS Fixture Season") as { id: number };
    return season.id;
  }

  it("refuses a stale write inside the update even when both writes share a timestamp", () => {
    const seasonId = insertSeason();
    const act = sqlite
      .prepare(
        "insert into acts (season_id, name, genre) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Fixture Act", "Initial Genre") as {
      id: number;
      version: number;
    };

    const winner = records.updateAct(act.id, act.version, {
      genre: "Winner Genre",
    });

    expect(winner.version).toBe(act.version + 1);
    expect(winner.updatedAt).toEqual(
      new Date(Math.floor(pinnedNow.getTime() / 1000) * 1000),
    );
    expect(() =>
      records.updateAct(act.id, act.version, { genre: "Stale Genre" }),
    ).toThrowError(RecordConflictError);
    expect(() =>
      records.updateAct(act.id, act.version, { genre: "Stale Genre" }),
    ).toThrowError(`act ${act.id} conflict: genre`);

    const stored = sqlite
      .prepare("select genre, version, updated_at from acts where id = ?")
      .get(act.id);
    expect(stored).toEqual({
      genre: "Winner Genre",
      version: act.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
  });

  it("refuses a stale venue write inside the update even when both writes share a timestamp", () => {
    const seasonId = insertSeason();
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title, notes) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Fixture Venue", "Initial notes") as {
      id: number;
      version: number;
    };

    const winner = records.updateVenue(venue.id, venue.version, {
      notes: "Winner notes",
    });

    expect(winner.version).toBe(venue.version + 1);
    expect(winner.updatedAt).toEqual(
      new Date(Math.floor(pinnedNow.getTime() / 1000) * 1000),
    );
    expect(() =>
      records.updateVenue(venue.id, venue.version, { notes: "Stale notes" }),
    ).toThrowError(RecordConflictError);
    expect(() =>
      records.updateVenue(venue.id, venue.version, { notes: "Stale notes" }),
    ).toThrowError(`venue ${venue.id} conflict: notes`);

    expect(
      sqlite
        .prepare("select notes, version, updated_at from venues where id = ?")
        .get(venue.id),
    ).toEqual({
      notes: "Winner notes",
      version: venue.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
  });

  it("refuses a stale contact write inside the update even when both writes share a timestamp", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Fixture Contact", "initial@example.invalid") as {
      id: number;
      version: number;
    };

    const winner = records.updateContact(contact.id, contact.version, {
      email: "winner@example.invalid",
    });

    expect(winner.version).toBe(contact.version + 1);
    expect(winner.updatedAt).toEqual(
      new Date(Math.floor(pinnedNow.getTime() / 1000) * 1000),
    );
    expect(() =>
      records.updateContact(contact.id, contact.version, {
        email: "stale@example.invalid",
      }),
    ).toThrowError(RecordConflictError);
    expect(() =>
      records.updateContact(contact.id, contact.version, {
        email: "stale@example.invalid",
      }),
    ).toThrowError(`contact ${contact.id} conflict: email`);

    expect(
      sqlite
        .prepare("select email, version, updated_at from contacts where id = ?")
        .get(contact.id),
    ).toEqual({
      email: "winner@example.invalid",
      version: contact.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
  });

  it("promotes a placeholder act without losing its assignment or email history", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(seasonId, "Fixture Contact", "fixture@example.invalid") as {
      id: number;
    };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Fixture Venue") as { id: number };
    const slot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, venue.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
    };
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links, placeholder, reach_via_contact_id) values (?, ?, ?, ?, ?, 1, ?) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Act",
        "Placeholder Genre",
        "Placeholder description",
        "https://example.invalid/placeholder",
        contact.id,
      ) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links) values (?, ?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        "Submitted Act",
        "Submitted Genre",
        "Submitted description",
        "https://example.invalid/submission",
      ) as { id: number; version: number };
    const assignment = sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, slot.id) as {
      id: number;
      version: number;
    };
    const email = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id, sent_at) values (?, ?, ?, ?, ?, ?) returning id",
      )
      .get(
        seasonId,
        "act",
        submission.id,
        "fixture-wave",
        contact.id,
        4_180_304_000,
      ) as { id: number };

    const promoted = records.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(
      sqlite
        .prepare(
          "select act_id, version, updated_at from assignments where id = ?",
        )
        .get(assignment.id),
    ).toEqual({
      act_id: promoted.id,
      version: assignment.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
    expect(
      sqlite
        .prepare("select record_type, record_id from email_log where id = ?")
        .get(email.id),
    ).toEqual({ record_type: "act", record_id: promoted.id });
    expect(
      sqlite
        .prepare("select canonical_act_id from acts where id = ?")
        .get(submission.id),
    ).toEqual({ canonical_act_id: promoted.id });
    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Submitted Act",
      genre: "Submitted Genre",
      description: "Submitted description",
      links: "https://example.invalid/submission",
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
  });

  it("preserves organizer-entered act fields omitted by the submission", () => {
    const seasonId = insertSeason();
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links, placeholder) values (?, ?, ?, ?, ?, 1) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Act",
        "Organizer Genre",
        "Organizer description",
        "https://example.invalid/organizer",
      ) as { id: number; version: number };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Submitted Act") as { id: number; version: number };

    const promoted = records.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Submitted Act",
      genre: "Organizer Genre",
      description: "Organizer description",
      links: "https://example.invalid/organizer",
    });
  });

  it("rolls back placeholder promotion when either version guard fails", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(seasonId, "Promotion Contact") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, placeholder, reach_via_contact_id) values (?, ?, 1, ?) returning id, version",
      )
      .get(seasonId, "Untouched Placeholder", contact.id) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Untouched Submission") as {
      id: number;
      version: number;
    };
    const before = sqlite
      .prepare(
        "select id, name, placeholder, canonical_act_id, version from acts order by id",
      )
      .all();

    expect(() =>
      records.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version + 1,
      ),
    ).toThrowError(`act ${submission.id} conflict: promotion`);
    expect(
      sqlite
        .prepare(
          "select id, name, placeholder, canonical_act_id, version from acts order by id",
        )
        .all(),
    ).toEqual(before);
  });

  it("refuses act promotion when the placeholder is already superseded", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(seasonId, "Canonical Act") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, placeholder, canonical_act_id) values (?, ?, 1, ?) returning id, version",
      )
      .get(seasonId, "Superseded Placeholder", canonical.id) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Submission") as { id: number; version: number };

    expect(() =>
      records.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError(`act ${placeholder.id} is already superseded`);
  });

  it("refuses act promotion when the submission is already superseded", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(seasonId, "Canonical Act") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, placeholder) values (?, ?, 1) returning id, version",
      )
      .get(seasonId, "Placeholder") as { id: number; version: number };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name, canonical_act_id) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Superseded Submission", canonical.id) as {
      id: number;
      version: number;
    };

    expect(() =>
      records.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError(`act ${submission.id} is already superseded`);
  });

  it("refuses act promotion when both records have assignments", () => {
    const seasonId = insertSeason();
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Collision Venue") as { id: number };
    const slot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, venue.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
    };
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, placeholder) values (?, ?, 1) returning id, version",
      )
      .get(seasonId, "Assigned Placeholder") as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Assigned Submission") as {
      id: number;
      version: number;
    };
    sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, slot.id);
    sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?)",
      )
      .run(seasonId, submission.id, slot.id);
    const seasonRecords = createSeasonRepository(database.db, {
      now: () => pinnedNow,
    });

    expect(() =>
      seasonRecords.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError("act promotion would merge assignments");
  });

  it("promotes a placeholder venue while preserving its slot and email history", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(seasonId, "Venue Contact") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, address, latitude, longitude, notes, host_contact_id, placeholder, reach_via_contact_id) values (?, ?, ?, ?, ?, ?, ?, 1, ?) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Venue",
        "Placeholder address",
        44.9778,
        -93.265,
        "Placeholder notes",
        contact.id,
        contact.id,
      ) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title, address, latitude, longitude, notes, host_contact_id) values (?, ?, ?, ?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        "Submitted Venue",
        "Submitted address",
        44.95,
        -93.09,
        "Submitted notes",
        contact.id,
      ) as { id: number; version: number };
    const otherVenue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Other Venue") as { id: number };
    const slot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
      version: number;
    };
    const fallbackSlot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, fallback_venue_id, starts_at, ends_at) values (?, ?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        otherVenue.id,
        submission.id,
        4_180_307_600,
        4_180_311_200,
      ) as { id: number; version: number };
    const email = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, ?, ?, ?, ?) returning id",
      )
      .get(
        seasonId,
        "venue",
        submission.id,
        "venue-fixture-wave",
        contact.id,
      ) as { id: number };

    const promoted = records.promotePlaceholderVenue(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(
      sqlite
        .prepare(
          "select venue_id, fallback_venue_id, version, updated_at from slots where id = ?",
        )
        .get(slot.id),
    ).toEqual({
      venue_id: promoted.id,
      fallback_venue_id: null,
      version: slot.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
    expect(
      sqlite
        .prepare(
          "select venue_id, fallback_venue_id, version, updated_at from slots where id = ?",
        )
        .get(fallbackSlot.id),
    ).toEqual({
      venue_id: otherVenue.id,
      fallback_venue_id: promoted.id,
      version: fallbackSlot.version + 1,
      updated_at: Math.floor(pinnedNow.getTime() / 1000),
    });
    expect(
      sqlite
        .prepare("select record_id from email_log where id = ?")
        .get(email.id),
    ).toEqual({ record_id: promoted.id });
    expect(promoted).toMatchObject({
      id: placeholder.id,
      title: "Submitted Venue",
      address: "Submitted address",
      latitude: 44.95,
      longitude: -93.09,
      notes: "Submitted notes",
      hostContactId: contact.id,
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
  });

  it("preserves organizer-entered venue fields omitted by the submission", () => {
    const seasonId = insertSeason();
    const host = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(seasonId, "Host Contact", "host@example.invalid") as {
      id: number;
    };
    const reachVia = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(seasonId, "Reach-via Contact", "reach@example.invalid") as {
      id: number;
    };
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, address, latitude, longitude, notes, host_contact_id, placeholder, reach_via_contact_id) values (?, ?, ?, ?, ?, ?, ?, 1, ?) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Venue",
        "Organizer address",
        44.9778,
        -93.265,
        "Organizer notes",
        host.id,
        reachVia.id,
      ) as { id: number; version: number };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, "Submitted Venue") as { id: number; version: number };

    const promoted = records.promotePlaceholderVenue(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      title: "Submitted Venue",
      address: "Organizer address",
      latitude: 44.9778,
      longitude: -93.265,
      notes: "Organizer notes",
      hostContactId: host.id,
      reachViaContactId: reachVia.id,
    });
    expect(
      records
        .resolveEmailRecipients("venue", promoted.id)
        .map((contact) => contact.id),
    ).toEqual([host.id, reachVia.id]);
  });

  it("refuses venue promotion when the placeholder is already superseded", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Canonical Venue") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, placeholder, canonical_venue_id) values (?, ?, 1, ?) returning id, version",
      )
      .get(seasonId, "Superseded Placeholder", canonical.id) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, "Submission") as { id: number; version: number };

    expect(() =>
      records.promotePlaceholderVenue(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError(`venue ${placeholder.id} is already superseded`);
  });

  it("refuses venue promotion when the submission is already superseded", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Canonical Venue") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, placeholder) values (?, ?, 1) returning id, version",
      )
      .get(seasonId, "Placeholder") as { id: number; version: number };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title, canonical_venue_id) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Superseded Submission", canonical.id) as {
      id: number;
      version: number;
    };

    expect(() =>
      records.promotePlaceholderVenue(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError(`venue ${submission.id} is already superseded`);
  });

  it("refuses venue promotion when both records have slots", () => {
    const seasonId = insertSeason();
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, placeholder) values (?, ?, 1) returning id, version",
      )
      .get(seasonId, "Scheduled Placeholder") as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, "Scheduled Submission") as {
      id: number;
      version: number;
    };
    sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?)",
      )
      .run(seasonId, placeholder.id, 4_180_304_000, 4_180_307_600);
    sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?)",
      )
      .run(seasonId, submission.id, 4_180_307_600, 4_180_311_200);

    expect(() =>
      records.promotePlaceholderVenue(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError("venue promotion would merge slots");
  });

  it("supersedes a venue onto its canonical record when both venues host slots", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, "Canonical Venue") as { id: number; version: number };
    const oldVenue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, "Old Venue") as { id: number; version: number };
    const canonicalSlot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, venue_id",
      )
      .get(seasonId, canonical.id, 4_180_304_000, 4_180_307_600);
    const oldVenueSlot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, venue_id",
      )
      .get(seasonId, oldVenue.id, 4_180_307_600, 4_180_311_200);

    const superseded = records.supersedeVenue(
      oldVenue.id,
      oldVenue.version,
      canonical.id,
    );

    expect(superseded).toMatchObject({
      id: oldVenue.id,
      canonicalVenueId: canonical.id,
      version: oldVenue.version + 1,
    });
    expect(records.resolveVenue(oldVenue.id)).toEqual({
      canonical: expect.objectContaining({ id: canonical.id }),
      superseded: [expect.objectContaining({ id: oldVenue.id })],
    });
    expect(
      sqlite
        .prepare("select id, venue_id from slots order by id")
        .all(),
    ).toEqual([canonicalSlot, oldVenueSlot]);
  });

  it("refuses supersession that would merge two assigned act families", () => {
    const seasonId = insertSeason();
    sqlite
      .prepare("update seasons set state = 'assigning' where id = ?")
      .run(seasonId);
    const canonical = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Canonical Assigned Act") as {
      id: number;
      version: number;
    };
    const source = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Source Assigned Act") as {
      id: number;
      version: number;
    };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Collision Venue") as { id: number };
    const firstSlot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, venue.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
      version: number;
    };
    const secondSlot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, venue.id, 4_180_307_600, 4_180_311_200) as {
      id: number;
      version: number;
    };
    const seasonRecords = createSeasonRepository(database.db, {
      now: () => pinnedNow,
    });
    seasonRecords.assignSlot(
      firstSlot.id,
      firstSlot.version,
      canonical.id,
    );
    seasonRecords.assignSlot(secondSlot.id, secondSlot.version, source.id);
    const assignmentsBefore = sqlite
      .prepare(
        "select id, season_id, act_id, slot_id, version, updated_at from assignments order by id",
      )
      .all();
    const slotsBefore = sqlite
      .prepare(
        "select id, state, version, updated_at from slots order by id",
      )
      .all();

    let thrown: unknown;
    try {
      seasonRecords.supersedeAct(
        source.id,
        source.version,
        canonical.id,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SeasonLifecycleError);
    expect(thrown).toMatchObject({
      message: `canonical act ${canonical.id} is already assigned in season ${seasonId}`,
    });
    expect(
      sqlite
        .prepare(
          "select id, season_id, act_id, slot_id, version, updated_at from assignments order by id",
        )
        .all(),
    ).toEqual(assignmentsBefore);
    expect(
      sqlite
        .prepare("select id, state, version, updated_at from slots order by id")
        .all(),
    ).toEqual(slotsBefore);
    expect(
      sqlite
        .prepare("select canonical_act_id, version from acts where id = ?")
        .get(source.id),
    ).toEqual({ canonical_act_id: null, version: source.version });
  });

  it("supersedes an unassigned act into an assigned canonical family", () => {
    const seasonId = insertSeason();
    sqlite
      .prepare("update seasons set state = 'assigning' where id = ?")
      .run(seasonId);
    const canonical = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Assigned Canonical Act") as {
      id: number;
      version: number;
    };
    const source = sqlite
      .prepare(
        "insert into acts (season_id, name) values (?, ?) returning id, version",
      )
      .get(seasonId, "Unassigned Source Act") as {
      id: number;
      version: number;
    };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Legal Supersession Venue") as { id: number };
    const slot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, venue.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
      version: number;
    };
    const seasonRecords = createSeasonRepository(database.db, {
      now: () => pinnedNow,
    });
    const assignment = seasonRecords.assignSlot(
      slot.id,
      slot.version,
      canonical.id,
    );

    const superseded = seasonRecords.supersedeAct(
      source.id,
      source.version,
      canonical.id,
    );

    expect(superseded).toMatchObject({
      id: source.id,
      canonicalActId: canonical.id,
      version: source.version + 1,
    });
    expect(
      sqlite
        .prepare(
          "select id, act_id, slot_id, version from assignments where season_id = ?",
        )
        .all(seasonId),
    ).toEqual([
      {
        id: assignment.id,
        act_id: canonical.id,
        slot_id: slot.id,
        version: assignment.version,
      },
    ]);
  });

  it("supersedes contacts when both contacts are referenced by records", () => {
    const seasonId = insertSeason();
    const canonical = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Canonical Contact", "canonical@example.invalid") as {
      id: number;
      version: number;
    };
    const source = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Source Contact", "source@example.invalid") as {
      id: number;
      version: number;
    };
    sqlite
      .prepare(
        "insert into venues (season_id, title, host_contact_id, reach_via_contact_id) values (?, ?, ?, ?)",
      )
      .run(seasonId, "Canonical Contact Venue", canonical.id, canonical.id);
    sqlite
      .prepare(
        "insert into acts (season_id, name, reach_via_contact_id) values (?, ?, ?)",
      )
      .run(seasonId, "Source Contact Act", source.id);

    const superseded = records.supersedeContact(
      source.id,
      source.version,
      canonical.id,
    );

    expect(superseded).toMatchObject({
      id: source.id,
      canonicalContactId: canonical.id,
      version: source.version + 1,
    });
    expect(records.resolveContact(source.id)).toEqual({
      canonical: expect.objectContaining({ id: canonical.id }),
      superseded: [expect.objectContaining({ id: source.id })],
    });
  });

  it("resolves supersession in both directions and omits superseded records from queues", () => {
    const seasonId = insertSeason();
    const canonicalContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Canonical Contact", "canonical@example.invalid") as {
      id: number;
      version: number;
    };
    const oldContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Old Contact", "old@example.invalid") as {
      id: number;
      version: number;
    };
    const canonicalAct = sqlite
      .prepare(
        "insert into acts (season_id, name, reach_via_contact_id) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Canonical Act", oldContact.id) as {
      id: number;
      version: number;
    };
    const oldAct = sqlite
      .prepare(
        "insert into acts (season_id, name, reach_via_contact_id) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Old Act", oldContact.id) as {
      id: number;
      version: number;
    };

    records.supersedeContact(
      oldContact.id,
      oldContact.version,
      canonicalContact.id,
    );
    records.supersedeAct(oldAct.id, oldAct.version, canonicalAct.id);

    const fromOld = records.resolveAct(oldAct.id);
    const fromCanonical = records.resolveAct(canonicalAct.id);
    expect(fromOld.canonical.id).toBe(canonicalAct.id);
    expect(fromOld.superseded.map((act) => act.id)).toContain(oldAct.id);
    expect(fromCanonical.canonical.id).toBe(canonicalAct.id);
    expect(fromCanonical.superseded.map((act) => act.id)).toContain(oldAct.id);

    const queueActIds = records
      .listActivityQueue(seasonId)
      .filter((item) => item.recordType === "act")
      .map((item) => item.record.id);
    expect(queueActIds).toContain(canonicalAct.id);
    expect(queueActIds).not.toContain(oldAct.id);

    expect(records.resolveEmailRecipients("act", oldAct.id)).toEqual([
      expect.objectContaining({
        id: canonicalContact.id,
        email: "canonical@example.invalid",
      }),
    ]);
  });
});
