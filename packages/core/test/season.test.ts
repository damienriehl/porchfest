import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SeasonActionError,
  SeasonConflictError,
  createSeasonRepository,
  isSeasonActionLegal,
} from "../src/season.js";
import * as schema from "../src/storage/schema.js";

describe("season domain", () => {
  let temporaryDirectory: string;
  let sqlite: Database.Database;
  let seasonRepository: ReturnType<typeof createSeasonRepository>;
  const pinnedNow = new Date("2105-06-01T12:00:00.000Z");

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "porchfest-season-"));
    sqlite = new Database(join(temporaryDirectory, "season.db"));
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    seasonRepository = createSeasonRepository(db, {
      now: () => pinnedNow,
    });
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function insertSeason(
    year: number,
    state:
      | "setup"
      | "signups_open"
      | "signups_closed"
      | "assigning"
      | "locked"
      | "archived",
  ): { id: number; version: number } {
    return sqlite
      .prepare(
        "insert into seasons (year, display_name, state) values (?, ?, ?) returning id, version",
      )
      .get(year, `Synthetic ${year}`, state) as {
      id: number;
      version: number;
    };
  }

  function insertVenue(seasonId: number, title: string): number {
    return (
      sqlite
        .prepare(
          "insert into venues (season_id, title) values (?, ?) returning id",
        )
        .get(seasonId, title) as { id: number }
    ).id;
  }

  function insertAct(seasonId: number, name: string): number {
    return (
      sqlite
        .prepare(
          "insert into acts (season_id, name) values (?, ?) returning id",
        )
        .get(seasonId, name) as { id: number }
    ).id;
  }

  function insertSlot(
    seasonId: number,
    venueId: number,
    offsetHours = 0,
  ): { id: number; version: number } {
    const startsAt =
      Math.floor(pinnedNow.getTime() / 1000) + offsetHours * 3600;
    return sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(seasonId, venueId, startsAt, startsAt + 3600) as {
      id: number;
      version: number;
    };
  }

  it("reports an expired named hold as releasable but keeps it blocking until explicitly released", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Hold Venue");
    const heldSlot = insertSlot(season.id, venueId);
    const otherSlot = insertSlot(season.id, venueId, 2);
    const heldActId = insertAct(season.id, "Would-be Held Act");
    const otherActId = insertAct(season.id, "Already Assigned Act");
    const held = seasonRepository.holdSlot(heldSlot.id, heldSlot.version, {
      heldForName: "Named Act That Never Signed Up",
      decideBy: new Date(pinnedNow.getTime() - 1),
    });
    const otherAssignment = seasonRepository.assignSlot(
      otherSlot.id,
      otherSlot.version,
      otherActId,
    );

    expect(seasonRepository.listReleasableHolds(season.id)).toEqual([
      expect.objectContaining({ id: heldSlot.id, state: "held" }),
    ]);
    expect(() =>
      seasonRepository.assignSlot(held.id, held.version, heldActId),
    ).toThrowError(`slot ${held.id} is held; assignment requires an open slot`);
    expect(
      sqlite.prepare("select state from slots where id = ?").get(heldSlot.id),
    ).toEqual({ state: "held" });

    const released = seasonRepository.releaseSlotHold(held.id, held.version);

    expect(released).toMatchObject({
      slot: {
        id: heldSlot.id,
        state: "open",
        heldDecideBy: null,
        heldForName: null,
        fallbackVenueId: null,
      },
      assignmentTargetVenueId: null,
    });
    expect(
      sqlite.prepare("select id, act_id, slot_id from assignments").all(),
    ).toEqual([
      {
        id: otherAssignment.id,
        act_id: otherActId,
        slot_id: otherSlot.id,
      },
    ]);
  });

  it("offers a released hold's fallback venue as the assignment target", () => {
    const season = insertSeason(2105, "signups_open");
    const venueId = insertVenue(season.id, "Original Venue");
    const fallbackVenueId = insertVenue(season.id, "Fallback Venue");
    const slot = insertSlot(season.id, venueId);
    const held = seasonRepository.holdSlot(slot.id, slot.version, {
      heldForName: "Act-side Pencil",
      decideBy: new Date(pinnedNow.getTime() + 3600_000),
      fallbackVenueId,
    });

    const released = seasonRepository.releaseSlotHold(held.id, held.version);

    expect(released.assignmentTargetVenueId).toBe(fallbackVenueId);
    expect(released.slot).toMatchObject({
      state: "open",
      fallbackVenueId: null,
    });
  });

  it("assigns while signups are open and applies the slot version guard", () => {
    const season = insertSeason(2105, "signups_open");
    const venueId = insertVenue(season.id, "Open-signups Venue");
    const actId = insertAct(season.id, "Open-signups Act");
    const slot = insertSlot(season.id, venueId);
    const concurrentlyChangedSlot = insertSlot(season.id, venueId, 2);

    const assignment = seasonRepository.assignSlot(
      slot.id,
      slot.version,
      actId,
    );

    expect(assignment).toMatchObject({
      seasonId: season.id,
      actId,
      slotId: slot.id,
    });
    sqlite
      .prepare("update slots set version = version + 1 where id = ?")
      .run(concurrentlyChangedSlot.id);
    expect(() =>
      seasonRepository.assignSlot(
        concurrentlyChangedSlot.id,
        concurrentlyChangedSlot.version,
        actId,
      ),
    ).toThrowError(SeasonConflictError);
  });

  it("refuses assignment in a locked season and names the state and action", () => {
    const season = insertSeason(2105, "locked");
    const venueId = insertVenue(season.id, "Locked Venue");
    const actId = insertAct(season.id, "Locked Act");
    const slot = insertSlot(season.id, venueId);

    expect(isSeasonActionLegal("locked", "assignment")).toBe(false);
    expect(() =>
      seasonRepository.assignSlot(slot.id, slot.version, actId),
    ).toThrowError(SeasonActionError);
    expect(() =>
      seasonRepository.assignSlot(slot.id, slot.version, actId),
    ).toThrowError("season state locked refuses action assignment");
  });

  it("allows a version-guarded assignment correction after lock", () => {
    const season = insertSeason(2105, "locked");
    const venueId = insertVenue(season.id, "Correction Venue");
    const oldActId = insertAct(season.id, "Incorrect Act");
    const correctedActId = insertAct(season.id, "Correct Act");
    const slot = insertSlot(season.id, venueId);
    sqlite
      .prepare("update slots set state = 'assigned' where id = ?")
      .run(slot.id);
    const assignment = sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?) returning id, version",
      )
      .get(season.id, oldActId, slot.id) as { id: number; version: number };

    const corrected = seasonRepository.correctAssignment(
      assignment.id,
      assignment.version,
      { actId: correctedActId },
    );

    expect(corrected).toMatchObject({
      id: assignment.id,
      actId: correctedActId,
      version: assignment.version + 1,
    });
    expect(() =>
      seasonRepository.correctAssignment(assignment.id, assignment.version, {
        actId: oldActId,
      }),
    ).toThrowError(`assignment ${assignment.id} conflict: actId`);
  });

  it("keeps queues, assignments, suggestions, and email waves season-scoped", () => {
    const first = insertSeason(2104, "assigning");
    const second = insertSeason(2105, "assigning");
    const firstContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(first.id, "First Contact", "first@example.invalid") as {
      id: number;
    };
    const secondContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(second.id, "Second Contact", "second@example.invalid") as {
      id: number;
    };
    const firstVenueId = insertVenue(first.id, "First Venue");
    const secondVenueId = insertVenue(second.id, "Second Venue");
    const firstAssignedActId = insertAct(first.id, "First Assigned Act");
    const firstCandidateId = insertAct(first.id, "First Candidate");
    const secondActId = insertAct(second.id, "Second Act");
    const firstAssignedSlot = insertSlot(first.id, firstVenueId);
    const firstOpenSlot = insertSlot(first.id, firstVenueId, 2);
    const secondSlot = insertSlot(second.id, secondVenueId);
    const firstAssignment = seasonRepository.assignSlot(
      firstAssignedSlot.id,
      firstAssignedSlot.version,
      firstAssignedActId,
    );
    const secondAssignment = seasonRepository.assignSlot(
      secondSlot.id,
      secondSlot.version,
      secondActId,
    );
    sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, 'act', ?, 'invite', ?)",
      )
      .run(first.id, firstCandidateId, firstContact.id);
    sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, 'act', ?, 'invite', ?)",
      )
      .run(second.id, secondActId, secondContact.id);

    const queueSeasonIds = seasonRepository
      .listActivityQueue(first.id)
      .map((item) => item.record.seasonId);
    expect(new Set(queueSeasonIds)).toEqual(new Set([first.id]));
    expect(
      seasonRepository.listAssignments(first.id).map(({ id }) => id),
    ).toEqual([firstAssignment.id]);
    expect(
      seasonRepository.listAssignments(first.id).map(({ id }) => id),
    ).not.toContain(secondAssignment.id);
    expect(seasonRepository.listAssignmentSuggestions(first.id)).toEqual([
      expect.objectContaining({
        act: expect.objectContaining({
          id: firstCandidateId,
          seasonId: first.id,
        }),
        slot: expect.objectContaining({
          id: firstOpenSlot.id,
          seasonId: first.id,
        }),
      }),
    ]);
    expect(seasonRepository.listEmailWave(first.id, "invite")).toEqual([
      expect.objectContaining({
        seasonId: first.id,
        recordId: firstCandidateId,
      }),
    ]);
    expect(
      seasonRepository.listEmailWaves(first.id).map(({ seasonId }) => seasonId),
    ).toEqual([first.id]);
  });

  it("finds a prior-season contact explicitly and records its source season", () => {
    const oldest = insertSeason(2103, "archived");
    const prior = insertSeason(2104, "archived");
    const current = insertSeason(2105, "setup");
    sqlite
      .prepare("insert into contacts (season_id, name, email) values (?, ?, ?)")
      .run(oldest.id, "Old Contact", "returning@example.invalid");
    const priorContact = sqlite
      .prepare(
        "insert into contacts (season_id, name, email) values (?, ?, ?) returning id",
      )
      .get(prior.id, "Prior Contact", "returning@example.invalid") as {
      id: number;
    };

    const match = seasonRepository.findPriorSeasonContact(
      current.id,
      "returning@example.invalid",
    );

    expect(match).toMatchObject({
      contact: { id: priorContact.id, seasonId: prior.id },
      sourceSeason: { id: prior.id, year: 2104 },
    });
  });

  it("allows only forward season transitions and guards the version in the update", () => {
    const season = insertSeason(2105, "setup");

    const open = seasonRepository.transitionSeason(
      season.id,
      season.version,
      "signups_open",
    );

    expect(open).toMatchObject({
      state: "signups_open",
      version: season.version + 1,
    });
    expect(() =>
      seasonRepository.transitionSeason(
        season.id,
        season.version,
        "signups_closed",
      ),
    ).toThrowError(`season ${season.id} conflict: state`);
    expect(() =>
      seasonRepository.transitionSeason(open.id, open.version, "setup"),
    ).toThrowError(
      "season state signups_open refuses action transition_to_setup",
    );
  });
});
