import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordConflictError, createRecordRepository } from "../src/records.js";

describe("record lifecycle", () => {
  let temporaryDirectory: string;
  let sqlite: Database.Database;
  let records: ReturnType<typeof createRecordRepository>;
  const pinnedNow = new Date("2102-06-01T12:00:00.123Z");

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "porchfest-records-"));
    sqlite = new Database(join(temporaryDirectory, "records.db"));
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    records = createRecordRepository(drizzle(sqlite), {
      now: () => pinnedNow,
    });
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
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
        "insert into acts (season_id, name, placeholder, reach_via_contact_id) values (?, ?, 1, ?) returning id, version",
      )
      .get(seasonId, "Placeholder Act", contact.id) as {
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
        "Fixture Genre",
        "Synthetic fixture description",
        "https://example.invalid/act",
      ) as { id: number; version: number };
    const assignment = sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?) returning id",
      )
      .get(seasonId, placeholder.id, slot.id) as { id: number };
    const email = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id, sent_at) values (?, ?, ?, ?, ?, ?) returning id",
      )
      .get(
        seasonId,
        "act",
        placeholder.id,
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

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Submitted Act",
      genre: "Fixture Genre",
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
    expect(
      sqlite
        .prepare("select act_id from assignments where id = ?")
        .get(assignment.id),
    ).toEqual({ act_id: promoted.id });
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

  it("promotes a placeholder venue while preserving its slot and email history", () => {
    const seasonId = insertSeason();
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(seasonId, "Venue Contact") as { id: number };
    const placeholder = sqlite
      .prepare(
        "insert into venues (season_id, title, placeholder, reach_via_contact_id) values (?, ?, 1, ?) returning id, version",
      )
      .get(seasonId, "Placeholder Venue", contact.id) as {
      id: number;
      version: number;
    };
    const submission = sqlite
      .prepare(
        "insert into venues (season_id, title, address, notes) values (?, ?, ?, ?) returning id, version",
      )
      .get(
        seasonId,
        "Submitted Venue",
        "Synthetic fixture address",
        "Synthetic fixture notes",
      ) as { id: number; version: number };
    const slot = sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id",
      )
      .get(seasonId, placeholder.id, 4_180_304_000, 4_180_307_600) as {
      id: number;
    };
    const email = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, ?, ?, ?, ?) returning id",
      )
      .get(
        seasonId,
        "venue",
        placeholder.id,
        "venue-fixture-wave",
        contact.id,
      ) as { id: number };

    const promoted = records.promotePlaceholderVenue(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      title: "Submitted Venue",
      address: "Synthetic fixture address",
      placeholder: false,
      reachViaContactId: contact.id,
      version: placeholder.version + 1,
    });
    expect(
      sqlite.prepare("select venue_id from slots where id = ?").get(slot.id),
    ).toEqual({ venue_id: promoted.id });
    expect(
      sqlite
        .prepare("select record_id from email_log where id = ?")
        .get(email.id),
    ).toEqual({ record_id: promoted.id });
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
