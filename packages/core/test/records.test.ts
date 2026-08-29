import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordConflictError, createRecordRepository } from "../src/records.js";
import { SeasonLifecycleError, createSeasonRepository } from "../src/season.js";
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

  it("creates placeholders reachable through an existing contact or a manual address", () => {
    const seasonId = insertSeason();
    const host = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(seasonId, "Fixture Host", "host@example.invalid") as {
      id: number;
    };

    const act = records.createPlaceholderAct({
      seasonId,
      reach: { reachViaContactId: host.id },
      act: {
        name: "Host-reached act",
        genre: "Folk",
        notes: "Ask the host to pass this along.",
      },
    });
    const venue = records.createPlaceholderVenue({
      seasonId,
      reach: {
        contact: {
          name: "Manual venue contact",
          email: "manual@example.invalid",
          phone: "synthetic-manual-reach-phone",
        },
      },
      venue: {
        title: "Manual-address venue",
        address: "10 Placeholder Ave",
        notes: "Added by an organizer.",
      },
    });

    expect(act).toMatchObject({
      name: "Host-reached act",
      placeholder: true,
      reachViaContactId: host.id,
      version: 1,
    });
    expect(venue).toMatchObject({
      title: "Manual-address venue",
      address: "10 Placeholder Ave",
      placeholder: true,
      version: 1,
    });
    expect(records.resolveEmailRecipients("act", act.id)).toEqual([
      expect.objectContaining({
        id: host.id,
        email: "host@example.invalid",
      }),
    ]);
    expect(records.resolveEmailRecipients("venue", venue.id)).toEqual([
      expect.objectContaining({
        id: venue.reachViaContactId,
        name: "Manual venue contact",
        email: "manual@example.invalid",
        phone: "synthetic-manual-reach-phone",
      }),
    ]);
  });

  it("refuses a placeholder reached through a contact from another season", () => {
    const seasonId = insertSeason();
    const otherSeasonId = insertSeason();
    const otherContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(otherSeasonId, "Other Season", "other@example.invalid") as {
      id: number;
    };

    expect(() =>
      records.createPlaceholderAct({
        seasonId,
        reach: { reachViaContactId: otherContact.id },
        act: { name: "Wrong-season reach" },
      }),
    ).toThrowError("placeholder contact belongs to a different season");
    expect(
      sqlite
        .prepare("select count(*) as total from acts where season_id = ?")
        .get(seasonId),
    ).toEqual({ total: 0 });
  });

  it("promotes a placeholder act without losing assignment, email, or annotation history", () => {
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
    const placeholder = records.createPlaceholderAct({
      seasonId,
      reach: { reachViaContactId: contact.id },
      act: {
        name: "Placeholder Act",
        genre: "Placeholder Genre",
        description: "Placeholder description",
        links: "https://example.invalid/placeholder",
      },
    });
    const submission = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links, duration_minutes, requires_amplification, house_preference, can_lend_gear) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        "Submitted Act",
        "Submitted Genre",
        "Submitted description",
        "https://example.invalid/submission",
        45,
        1,
        "Submitted house preference",
        1,
      ) as { id: number; version: number };
    const availability = sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
      version: number;
    };
    const otherSubmittedAvailability = sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, 4_180_311_200, 4_180_314_800) as {
      id: number;
      version: number;
    };
    const overlappingPlaceholderAvailability = sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, placeholder.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
    };
    const placeholderOnlyAvailability = sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, placeholder.id, 4_180_307_600, 4_180_311_200) as {
      id: number;
    };
    const unrelatedAct = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(seasonId, "Unrelated Act") as { id: number };
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
    const annotation = sqlite
      .prepare(
        "insert into annotations (season_id, record_type, record_id, note) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, "act", submission.id, "Submission note") as {
      id: number;
    };
    const otherTypeAnnotation = sqlite
      .prepare(
        "insert into annotations (season_id, record_type, record_id, note) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, "venue", submission.id, "Same id, other type") as {
      id: number;
    };
    const otherActAnnotation = sqlite
      .prepare(
        "insert into annotations (season_id, record_type, record_id, note) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, "act", unrelatedAct.id, "Other act note") as {
      id: number;
    };

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
        .prepare("select record_type, record_id from annotations where id = ?")
        .get(annotation.id),
    ).toEqual({ record_type: "act", record_id: promoted.id });
    expect(
      sqlite
        .prepare("select record_type, record_id from annotations where id = ?")
        .get(otherTypeAnnotation.id),
    ).toEqual({ record_type: "venue", record_id: submission.id });
    expect(
      sqlite
        .prepare("select record_type, record_id from annotations where id = ?")
        .get(otherActAnnotation.id),
    ).toEqual({ record_type: "act", record_id: unrelatedAct.id });
    expect(
      sqlite
        .prepare("select canonical_act_id from acts where id = ?")
        .get(submission.id),
    ).toEqual({ canonical_act_id: promoted.id });
    expect(
      sqlite
        .prepare(
          "select act_id, version, updated_at from act_availabilities where id = ?",
        )
        .get(availability.id),
    ).toEqual({
      act_id: submission.id,
      version: availability.version,
      updated_at: expect.any(Number),
    });
    expect(
      sqlite
        .prepare(
          "select starts_at, ends_at from act_availabilities where act_id = ? order by starts_at",
        )
        .all(promoted.id),
    ).toEqual([
      { starts_at: 4_180_304_000, ends_at: 4_180_307_600 },
      { starts_at: 4_180_307_600, ends_at: 4_180_311_200 },
      { starts_at: 4_180_311_200, ends_at: 4_180_314_800 },
    ]);
    expect(
      sqlite
        .prepare(
          "select id, starts_at, ends_at from act_availabilities where act_id = ? order by starts_at",
        )
        .all(submission.id),
    ).toEqual([
      {
        id: availability.id,
        starts_at: 4_180_304_000,
        ends_at: 4_180_307_600,
      },
      {
        id: otherSubmittedAvailability.id,
        starts_at: 4_180_311_200,
        ends_at: 4_180_314_800,
      },
    ]);
    expect(
      sqlite
        .prepare(
          "select id from act_availabilities where id in (?, ?) order by id",
        )
        .all(
          overlappingPlaceholderAvailability.id,
          placeholderOnlyAvailability.id,
        ),
    ).toEqual([
      { id: overlappingPlaceholderAvailability.id },
      { id: placeholderOnlyAvailability.id },
    ]);
    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Submitted Act",
      genre: "Submitted Genre",
      description: "Submitted description",
      links: "https://example.invalid/submission",
      durationMinutes: 45,
      requiresAmplification: true,
      housePreference: "Submitted house preference",
      canLendGear: true,
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
  });

  it("keeps a host-reached placeholder act's assignment and email history after promotion", () => {
    const seasonId = insertSeason();
    sqlite
      .prepare("update seasons set state = 'assigning' where id = ?")
      .run(seasonId);
    const host = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(seasonId, "Placeholder Host", "host@example.invalid") as {
      id: number;
    };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(seasonId, "Assignment Venue") as { id: number };
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
    const placeholder = seasonRecords.createPlaceholderAct({
      seasonId,
      reach: { reachViaContactId: host.id },
      act: { name: "Host's penciled-in act" },
    });
    const submission = records.createPerformerSignup({
      seasonId,
      contact: {
        name: "Filed performer",
        email: "performer@example.invalid",
      },
      act: {
        name: "Filed act name",
        durationMinutes: 45,
        requiresAmplification: false,
        genre: "Folk",
        description: "Filed description",
        links: "",
        housePreference: null,
        canLendGear: false,
        notes: null,
      },
      availabilities: [],
    });
    const assignment = seasonRecords.assignSlot(
      slot.id,
      slot.version,
      placeholder.id,
    );
    const email = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, 'act', ?, ?, ?) returning id",
      )
      .get(seasonId, placeholder.id, "placeholder-intro", host.id) as {
      id: number;
    };

    const promoted = seasonRecords.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.act.id,
      submission.act.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Filed act name",
      placeholder: false,
      reachViaContactId: submission.contact.id,
    });
    expect(
      sqlite
        .prepare("select act_id, version from assignments where id = ?")
        .get(assignment.id),
    ).toEqual({ act_id: placeholder.id, version: assignment.version });
    expect(
      sqlite
        .prepare("select record_id from email_log where id = ?")
        .get(email.id),
    ).toEqual({ record_id: placeholder.id });
    expect(
      seasonRecords
        .listActivityQueue(seasonId)
        .filter((item) => item.recordType === "act")
        .map((item) => item.record.id),
    ).toEqual([placeholder.id]);
  });

  it("preserves organizer-entered act fields omitted by the submission", () => {
    const seasonId = insertSeason();
    const placeholder = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links, duration_minutes, requires_amplification, house_preference, can_lend_gear, placeholder) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Act",
        "Organizer Genre",
        "Organizer description",
        "https://example.invalid/organizer",
        60,
        1,
        "Organizer house preference",
        0,
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
      durationMinutes: 60,
      requiresAmplification: true,
      housePreference: "Organizer house preference",
      canLendGear: false,
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
    const placeholder = records.createPlaceholderVenue({
      seasonId,
      reach: { reachViaContactId: contact.id },
      venue: {
        title: "Placeholder Venue",
        address: "Placeholder address",
        notes: "Placeholder notes",
        hostContactId: contact.id,
      },
    });
    sqlite
      .prepare(
        "insert into venue_coordinates (venue_id, latitude, longitude, source, precision, provider, ref, status, address_at_geocode) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        placeholder.id,
        44.9778,
        -93.265,
        "geocoded",
        "parcel",
        "fixture",
        "way/1",
        "verified",
        "Placeholder address",
      );
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title, address, space_description, has_power, rain_backup, notes, host_contact_id) values (?, ?, ?, ?, ?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        "Submitted Venue",
        "Submitted address",
        "Submitted porch and yard",
        1,
        1,
        "Submitted notes",
        contact.id,
      ) as { id: number; version: number };
    sqlite
      .prepare(
        "insert into venue_coordinates (venue_id, latitude, longitude, source, provider, ref, status, address_at_geocode) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        submission.id,
        44.95,
        -93.09,
        "organizer-verified",
        "organizer",
        "organizer/1",
        "verified",
        "Submitted address",
      );
    const gear = sqlite
      .prepare(
        "insert into venue_gear (season_id, venue_id, value) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, "pa") as {
      id: number;
      version: number;
    };
    const drink = sqlite
      .prepare(
        "insert into venue_drinks (season_id, venue_id, value) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, "water") as {
      id: number;
      version: number;
    };
    const amenity = sqlite
      .prepare(
        "insert into venue_amenities (season_id, venue_id, value) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, submission.id, "shade") as {
      id: number;
      version: number;
    };
    sqlite
      .prepare(
        "insert into venue_gear (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, submission.id, "microphone");
    sqlite
      .prepare(
        "insert into venue_drinks (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, submission.id, "beer");
    sqlite
      .prepare(
        "insert into venue_amenities (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, submission.id, "seating");
    sqlite
      .prepare(
        "insert into venue_gear (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "pa");
    sqlite
      .prepare(
        "insert into venue_drinks (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "water");
    sqlite
      .prepare(
        "insert into venue_amenities (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "shade");
    sqlite
      .prepare(
        "insert into venue_gear (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "extension_cord");
    sqlite
      .prepare(
        "insert into venue_drinks (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "wine");
    sqlite
      .prepare(
        "insert into venue_amenities (season_id, venue_id, value) values (?, ?, ?)",
      )
      .run(seasonId, placeholder.id, "restroom");
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
    for (const [table, row] of [
      ["venue_gear", gear],
      ["venue_drinks", drink],
      ["venue_amenities", amenity],
    ] as const) {
      expect(
        sqlite
          .prepare(
            `select venue_id, version, updated_at from ${table} where id = ?`,
          )
          .get(row.id),
      ).toEqual({
        venue_id: submission.id,
        version: row.version,
        updated_at: expect.any(Number),
      });
    }
    expect(
      sqlite
        .prepare(
          "select value from venue_gear where venue_id = ? order by value",
        )
        .all(promoted.id),
    ).toEqual([
      { value: "extension_cord" },
      { value: "microphone" },
      { value: "pa" },
    ]);
    expect(
      sqlite
        .prepare(
          "select value from venue_drinks where venue_id = ? order by value",
        )
        .all(promoted.id),
    ).toEqual([{ value: "beer" }, { value: "water" }, { value: "wine" }]);
    expect(
      sqlite
        .prepare(
          "select value from venue_amenities where venue_id = ? order by value",
        )
        .all(promoted.id),
    ).toEqual([
      { value: "restroom" },
      { value: "seating" },
      { value: "shade" },
    ]);
    expect(
      sqlite
        .prepare(
          "select value from venue_gear where venue_id = ? order by value",
        )
        .all(submission.id),
    ).toEqual([{ value: "microphone" }, { value: "pa" }]);
    expect(
      sqlite
        .prepare(
          "select value from venue_drinks where venue_id = ? order by value",
        )
        .all(submission.id),
    ).toEqual([{ value: "beer" }, { value: "water" }]);
    expect(
      sqlite
        .prepare(
          "select value from venue_amenities where venue_id = ? order by value",
        )
        .all(submission.id),
    ).toEqual([{ value: "seating" }, { value: "shade" }]);
    expect(promoted).toMatchObject({
      id: placeholder.id,
      title: "Submitted Venue",
      address: "Submitted address",
      spaceDescription: "Submitted porch and yard",
      hasPower: true,
      rainBackup: true,
      notes: "Submitted notes",
      hostContactId: contact.id,
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
    expect(
      sqlite
        .prepare(
          "select latitude, longitude, source from venue_coordinates where venue_id = ?",
        )
        .get(placeholder.id),
    ).toEqual({
      latitude: 44.95,
      longitude: -93.09,
      source: "organizer-verified",
    });
    expect(
      sqlite
        .prepare(
          "select count(*) as count from venue_coordinates where venue_id = ?",
        )
        .get(submission.id),
    ).toEqual({ count: 0 });
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
        "insert into venues (season_id, title, address, space_description, has_power, rain_backup, notes, host_contact_id, placeholder, reach_via_contact_id) values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) returning id, version",
      )
      .get(
        seasonId,
        "Placeholder Venue",
        "Organizer address",
        "Organizer porch and yard",
        0,
        1,
        "Organizer notes",
        host.id,
        reachVia.id,
      ) as { id: number; version: number };
    sqlite
      .prepare(
        "insert into venue_coordinates (venue_id, latitude, longitude, source, provider, ref, status, address_at_geocode) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        placeholder.id,
        44.9778,
        -93.265,
        "organizer-verified",
        "organizer",
        "organizer/1",
        "verified",
        "Organizer address",
      );
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
      spaceDescription: "Organizer porch and yard",
      hasPower: false,
      rainBackup: true,
      notes: "Organizer notes",
      hostContactId: host.id,
      reachViaContactId: reachVia.id,
    });
    expect(
      sqlite
        .prepare(
          "select latitude, longitude, source from venue_coordinates where venue_id = ?",
        )
        .get(placeholder.id),
    ).toEqual({
      latitude: 44.9778,
      longitude: -93.265,
      source: "organizer-verified",
    });
    expect(
      records
        .resolveEmailRecipients("venue", promoted.id)
        .map((contact) => contact.id),
    ).toEqual([host.id, reachVia.id]);
  });

  it("preserves an organizer pin when promoting a differently addressed geocoded submission", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(seasonId, "Promotion Contact") as { id: number };
    const placeholder = records.createPlaceholderVenue({
      seasonId,
      reach: { reachViaContactId: contact.id },
      venue: {
        title: "Organizer Placeholder",
        address: "301 Orbit Lane",
      },
    });
    sqlite
      .prepare(
        "insert into venue_coordinates (venue_id, latitude, longitude, source, provider, ref, status, address_at_geocode) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        placeholder.id,
        10.4,
        20.4,
        "organizer-verified",
        "organizer",
        "organizer/1",
        "verified",
        "301 Orbit Lane",
      );
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title, address) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, "Submitted Venue", "302 Orbit Lane") as {
      id: number;
      version: number;
    };
    sqlite
      .prepare(
        "insert into venue_coordinates (venue_id, latitude, longitude, source, precision, provider, ref, status, address_at_geocode) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        submission.id,
        10.8,
        20.8,
        "geocoded",
        "parcel",
        "fixture",
        "way/302",
        "verified",
        "302 Orbit Lane",
      );

    records.promotePlaceholderVenue(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(
      sqlite
        .prepare(
          "select latitude, longitude, source, status, rejection_code from venue_coordinates where venue_id = ?",
        )
        .get(placeholder.id),
    ).toEqual({
      latitude: 10.4,
      longitude: 20.4,
      source: "organizer-verified",
      status: "needs-review",
      rejection_code: "address-changed",
    });
    expect(
      sqlite
        .prepare(
          "select count(*) as count from venue_coordinates where venue_id = ?",
        )
        .get(submission.id),
    ).toEqual({ count: 0 });
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
      sqlite.prepare("select id, venue_id from slots order by id").all(),
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
    seasonRecords.assignSlot(firstSlot.id, firstSlot.version, canonical.id);
    seasonRecords.assignSlot(secondSlot.id, secondSlot.version, source.id);
    const assignmentsBefore = sqlite
      .prepare(
        "select id, season_id, act_id, slot_id, version, updated_at from assignments order by id",
      )
      .all();
    const slotsBefore = sqlite
      .prepare("select id, state, version, updated_at from slots order by id")
      .all();

    let thrown: unknown;
    try {
      seasonRecords.supersedeAct(source.id, source.version, canonical.id);
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
