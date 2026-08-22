import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  createSeasonRepository,
  isSeasonActionLegal,
  type SeasonAction,
  type SeasonState,
} from "../src/season.js";
import { seasonStates } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("season domain", () => {
  let database: TestDatabase;
  let sqlite: Database.Database;
  let seasonRepository: ReturnType<typeof createSeasonRepository>;
  const pinnedNow = new Date("2105-06-01T12:00:00.000Z");

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-season-");
    sqlite = database.sqlite;
    seasonRepository = createSeasonRepository(database.db, {
      now: () => pinnedNow,
    });
  });

  afterEach(async () => {
    await database.close();
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

  function insertVersionedAct(
    seasonId: number,
    name: string,
    placeholder = false,
  ): { id: number; version: number } {
    return sqlite
      .prepare(
        "insert into acts (season_id, name, placeholder) values (?, ?, ?) returning id, version",
      )
      .get(seasonId, name, placeholder ? 1 : 0) as {
      id: number;
      version: number;
    };
  }

  function insertAct(seasonId: number, name: string): number {
    return insertVersionedAct(seasonId, name).id;
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

  it("matches the documented legality policy for every season state and action", () => {
    const legalByAction: Readonly<
      Record<SeasonAction, readonly SeasonState[]>
    > = {
      assignment: ["signups_open", "signups_closed", "assigning"],
      hold: ["setup", "signups_open", "signups_closed", "assigning"],
      hold_release: [
        "setup",
        "signups_open",
        "signups_closed",
        "assigning",
        "locked",
      ],
      correction: [
        "setup",
        "signups_open",
        "signups_closed",
        "assigning",
        "locked",
      ],
    };
    const actions = Object.keys(legalByAction) as SeasonAction[];

    for (const state of seasonStates) {
      for (const action of actions) {
        expect(isSeasonActionLegal(state, action)).toBe(
          legalByAction[action].includes(state),
        );
      }
    }
  });

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

  it("refuses a stale slot version when placing a hold and leaves the row unchanged", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Concurrent Hold Venue");
    const slot = insertSlot(season.id, venueId);
    sqlite
      .prepare("update slots set version = version + 1 where id = ?")
      .run(slot.id);
    const before = sqlite
      .prepare(
        "select state, held_decide_by, held_for_name, fallback_venue_id, version from slots where id = ?",
      )
      .get(slot.id);

    let thrown: unknown;
    try {
      seasonRepository.holdSlot(slot.id, slot.version, {
        heldForName: "Stale Hold",
        decideBy: new Date(pinnedNow.getTime() + 3600_000),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SeasonConflictError);
    expect(thrown).toMatchObject({
      recordType: "slot",
      recordId: slot.id,
      conflictingFields: [
        "state",
        "heldDecideBy",
        "heldForName",
        "fallbackVenueId",
      ],
    });
    expect(
      sqlite
        .prepare(
          "select state, held_decide_by, held_for_name, fallback_venue_id, version from slots where id = ?",
        )
        .get(slot.id),
    ).toEqual(before);
  });

  it("refuses a stale slot version when releasing a hold and leaves the row unchanged", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Concurrent Release Venue");
    const slot = insertSlot(season.id, venueId);
    const held = seasonRepository.holdSlot(slot.id, slot.version, {
      heldForName: "Held Across Concurrent Write",
      decideBy: new Date(pinnedNow.getTime() + 3600_000),
    });
    sqlite
      .prepare("update slots set version = version + 1 where id = ?")
      .run(slot.id);
    const before = sqlite
      .prepare(
        "select state, held_decide_by, held_for_name, fallback_venue_id, version from slots where id = ?",
      )
      .get(slot.id);

    let thrown: unknown;
    try {
      seasonRepository.releaseSlotHold(held.id, held.version);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SeasonConflictError);
    expect(thrown).toMatchObject({
      recordType: "slot",
      recordId: slot.id,
      conflictingFields: [
        "state",
        "heldDecideBy",
        "heldForName",
        "fallbackVenueId",
      ],
    });
    expect(
      sqlite
        .prepare(
          "select state, held_decide_by, held_for_name, fallback_venue_id, version from slots where id = ?",
        )
        .get(slot.id),
    ).toEqual(before);
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

  it("refuses record corrections, promotions, and supersessions after archival", () => {
    const season = insertSeason(2105, "archived");
    const correctionTarget = insertVersionedAct(
      season.id,
      "Archived Correction Target",
    );
    const placeholder = insertVersionedAct(
      season.id,
      "Archived Placeholder",
      true,
    );
    const submission = insertVersionedAct(season.id, "Archived Submission");
    const supersessionSource = insertVersionedAct(
      season.id,
      "Archived Supersession Source",
    );
    const canonical = insertVersionedAct(season.id, "Archived Canonical Act");

    expect(() =>
      seasonRepository.updateAct(
        correctionTarget.id,
        correctionTarget.version,
        { name: "Forbidden Correction" },
      ),
    ).toThrowError("season state archived refuses action correction");
    expect(() =>
      seasonRepository.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError("season state archived refuses action correction");
    expect(() =>
      seasonRepository.supersedeAct(
        supersessionSource.id,
        supersessionSource.version,
        canonical.id,
      ),
    ).toThrowError("season state archived refuses action correction");
    expect(
      sqlite
        .prepare("select name from acts where id = ?")
        .get(correctionTarget.id),
    ).toEqual({ name: "Archived Correction Target" });
  });

  it("excludes and refuses a canonical act already assigned under a superseded identity", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Supersession Venue");
    const assignedSlot = insertSlot(season.id, venueId);
    const openSlot = insertSlot(season.id, venueId, 2);
    const canonical = insertVersionedAct(season.id, "Canonical Band");
    const superseded = insertVersionedAct(season.id, "Former Band Name");
    seasonRepository.assignSlot(
      assignedSlot.id,
      assignedSlot.version,
      superseded.id,
    );
    seasonRepository.supersedeAct(
      superseded.id,
      superseded.version,
      canonical.id,
    );

    expect(seasonRepository.listAssignmentSuggestions(season.id)).toEqual([]);
    expect(() =>
      seasonRepository.assignSlot(openSlot.id, openSlot.version, canonical.id),
    ).toThrowError(
      `canonical act ${canonical.id} is already assigned in season ${season.id}`,
    );
    expect(
      sqlite
        .prepare("select state, version from slots where id = ?")
        .get(openSlot.id),
    ).toEqual({ state: "open", version: openSlot.version });
    expect(
      sqlite
        .prepare(
          "select count(*) as count from assignments where season_id = ?",
        )
        .get(season.id),
    ).toEqual({ count: 1 });
  });

  it("refuses an assignment correction that would duplicate a canonical act", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Correction Conflict Venue");
    const firstSlot = insertSlot(season.id, venueId);
    const secondSlot = insertSlot(season.id, venueId, 2);
    const canonical = insertVersionedAct(season.id, "Canonical Correction Act");
    const superseded = insertVersionedAct(season.id, "Old Correction Act");
    const other = insertVersionedAct(season.id, "Other Assigned Act");
    seasonRepository.assignSlot(firstSlot.id, firstSlot.version, superseded.id);
    const otherAssignment = seasonRepository.assignSlot(
      secondSlot.id,
      secondSlot.version,
      other.id,
    );
    seasonRepository.supersedeAct(
      superseded.id,
      superseded.version,
      canonical.id,
    );

    let thrown: unknown;
    try {
      seasonRepository.correctAssignment(
        otherAssignment.id,
        otherAssignment.version,
        { actId: canonical.id },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SeasonLifecycleError);
    expect(thrown).toMatchObject({
      message: `canonical act ${canonical.id} is already assigned in season ${season.id}`,
    });
    expect(
      sqlite
        .prepare("select act_id, version from assignments where id = ?")
        .get(otherAssignment.id),
    ).toEqual({
      act_id: other.id,
      version: otherAssignment.version,
    });
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
