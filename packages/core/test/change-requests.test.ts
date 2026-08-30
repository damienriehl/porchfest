// R33 participant changes are proposals until an organizer accepts them. These
// tests use migrated SQLite so KTD7 is proved by affected rows, not source shape.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChangeRequestConflictError,
  ChangeRequestLifecycleError,
  ChangeRequestTargetConflictError,
  createChangeRequestRepository,
} from "../src/change-requests.js";
import { createSeasonRepository, SeasonActionError } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
const now = new Date("2031-04-01T12:00:00.000Z");

beforeEach(async () => {
  database = await openTestDatabase("porchfest-change-requests-");
});

afterEach(async () => {
  await database.close();
});

function fixtures() {
  const clock = () => now;
  const setup = createSeasonSetup(database.db, clock);
  const seasons = createSeasonRepository(database.db, { now: clock });
  const requests = createChangeRequestRepository(database.db, { now: clock });
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
  const host = seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "Host", email: "host@example.invalid" },
    venue: {
      title: "Test Porch",
      address: "1 Stored St",
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
    contact: { name: "Act contact", email: "act@example.invalid" },
    act: {
      name: "The Versions",
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
        startsAt: new Date("2031-09-13T14:00:00.000Z"),
        endsAt: new Date("2031-09-13T15:00:00.000Z"),
      },
    ],
  });
  return { season, seasons, requests, host, performer };
}

describe("participant change requests", () => {
  it("keeps a confirmed assignment until withdrawal is applied, then reopens its slot", () => {
    const { season, seasons, requests, host, performer } = fixtures();
    const confirmed = seasons.setRecordStatus(
      "act",
      performer.act.id,
      performer.act.version,
      "confirmed",
    );
    expect(confirmed.reopenedSlotIds).toEqual([]);
    const currentActVersion = performer.act.version + 1;
    const slot = database.sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(season.id, host.venue.id, 1_946_889_600, 1_946_893_200) as {
      id: number;
      version: number;
    };
    seasons.assignSlot(slot.id, slot.version, performer.act.id);

    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: currentActVersion,
      kind: "withdrawal",
    });

    expect(requests.listPendingForSeason(season.id)).toEqual([request]);
    expect(
      database.sqlite
        .prepare("select status from acts where id = ?")
        .get(performer.act.id),
    ).toEqual({ status: "confirmed" });
    expect(
      database.sqlite
        .prepare("select state from slots where id = ?")
        .get(slot.id),
    ).toEqual({ state: "assigned" });

    requests.apply(request.id, request.version);

    expect(
      database.sqlite
        .prepare("select status from acts where id = ?")
        .get(performer.act.id),
    ).toEqual({ status: "withdrawn" });
    expect(
      database.sqlite
        .prepare("select state from slots where id = ?")
        .get(slot.id),
    ).toEqual({ state: "open" });
    expect(
      database.sqlite
        .prepare("select count(*) as count from assignments")
        .get(),
    ).toEqual({ count: 0 });
    expect(requests.listPendingForSeason(season.id)).toEqual([]);
  });

  it("replaces availability only when the organizer applies it", () => {
    const { season, requests, performer } = fixtures();
    const proposal = [
      {
        startsAt: new Date("2031-09-13T16:00:00.000Z"),
        endsAt: new Date("2031-09-13T18:00:00.000Z"),
      },
    ];
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: proposal,
    });

    expect(
      database.sqlite
        .prepare("select starts_at from act_availabilities where act_id = ?")
        .get(performer.act.id),
    ).toEqual({ starts_at: 1_947_074_400 });

    requests.apply(request.id, request.version);

    expect(
      database.sqlite
        .prepare(
          "select starts_at, ends_at from act_availabilities where act_id = ?",
        )
        .all(performer.act.id),
    ).toEqual([{ starts_at: 1_947_081_600, ends_at: 1_947_088_800 }]);
  });

  it("deduplicates repeated proposed availability windows when applying", () => {
    const { season, requests, performer } = fixtures();
    const window = {
      startsAt: new Date("2031-09-13T16:00:00.000Z"),
      endsAt: new Date("2031-09-13T18:00:00.000Z"),
    };
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [window, window],
    });

    expect(() => requests.apply(request.id, request.version)).not.toThrow();
    expect(
      database.sqlite
        .prepare(
          "select starts_at, ends_at from act_availabilities where act_id = ?",
        )
        .all(performer.act.id),
    ).toEqual([{ starts_at: 1_947_081_600, ends_at: 1_947_088_800 }]);
    expect(requests.find(request.id)?.status).toBe("applied");
  });

  it("refuses an availability change after the season is archived", () => {
    const { season, seasons, requests, performer } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [
        {
          startsAt: new Date("2031-09-13T16:00:00.000Z"),
          endsAt: new Date("2031-09-13T18:00:00.000Z"),
        },
      ],
    });
    seasons.transitionSeason(season.id, season.version, "archived");

    expect(() => requests.apply(request.id, request.version)).toThrowError(
      SeasonActionError,
    );
    expect(requests.find(request.id)?.status).toBe("pending");
    expect(
      database.sqlite
        .prepare("select starts_at from act_availabilities where act_id = ?")
        .get(performer.act.id),
    ).toEqual({ starts_at: 1_947_074_400 });
  });

  it("refuses a withdrawal change after the season is archived", () => {
    const { season, seasons, requests, host, performer } = fixtures();
    seasons.setRecordStatus(
      "act",
      performer.act.id,
      performer.act.version,
      "confirmed",
    );
    const slot = database.sqlite
      .prepare(
        "insert into slots (season_id, venue_id, starts_at, ends_at) values (?, ?, ?, ?) returning id, version",
      )
      .get(season.id, host.venue.id, 1_946_889_600, 1_946_893_200) as {
      id: number;
      version: number;
    };
    seasons.assignSlot(slot.id, slot.version, performer.act.id);
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version + 1,
      kind: "withdrawal",
    });
    seasons.transitionSeason(season.id, season.version, "archived");

    expect(() => requests.apply(request.id, request.version)).toThrowError(
      SeasonActionError,
    );
    expect(requests.find(request.id)?.status).toBe("pending");
    expect(
      database.sqlite
        .prepare("select status from acts where id = ?")
        .get(performer.act.id),
    ).toEqual({ status: "confirmed" });
    expect(
      database.sqlite
        .prepare("select state from slots where id = ?")
        .get(slot.id),
    ).toEqual({ state: "assigned" });
    expect(
      database.sqlite
        .prepare("select count(*) as count from assignments where slot_id = ?")
        .get(slot.id),
    ).toEqual({ count: 1 });
  });

  it("keeps address requests pending until the editor save completes review", () => {
    const { season, seasons, requests, host } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "address",
      proposedAddress: "2 Proposed Ave",
    });

    expect(() => requests.apply(request.id, request.version)).toThrowError(
      ChangeRequestLifecycleError,
    );
    expect(requests.find(request.id)?.status).toBe("pending");

    seasons.updateVenue(host.venue.id, host.venue.version, {
      address: "2 Proposed Ave",
    });
    requests.completeAddressReview(request.id, request.version);

    expect(requests.find(request.id)?.status).toBe("applied");
  });

  it("rejects without touching the record", () => {
    const { season, requests, host } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "address",
      proposedAddress: "2 Proposed Ave",
    });

    requests.reject(request.id, request.version);

    expect(
      database.sqlite
        .prepare("select address from venues where id = ?")
        .get(host.venue.id),
    ).toEqual({ address: "1 Stored St" });
    expect(requests.listPendingForSeason(season.id)).toEqual([]);
    expect(requests.find(request.id)?.status).toBe("rejected");
  });

  it("rolls back the request claim when the target version is stale", () => {
    const { season, seasons, requests, performer } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "withdrawal",
    });
    seasons.updateAct(performer.act.id, performer.act.version, {
      genre: "Changed concurrently",
    });

    expect(() => requests.apply(request.id, request.version)).toThrow(
      ChangeRequestConflictError,
    );
    expect(requests.find(request.id)?.status).toBe("pending");
    expect(requests.listPendingForSeason(season.id)).toEqual([
      expect.objectContaining({ id: request.id, applicable: false }),
    ]);
  });

  it("names the moved target record when a request cannot be filed", () => {
    const { season, seasons, requests, host } = fixtures();
    seasons.updateVenue(host.venue.id, host.venue.version, {
      notes: "Moved before filing",
    });

    try {
      requests.record({
        seasonId: season.id,
        recordType: "venue",
        recordId: host.venue.id,
        recordVersion: host.venue.version,
        kind: "address",
        proposedAddress: "2 Proposed Ave",
      });
      throw new Error("expected the stale filing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ChangeRequestTargetConflictError);
      expect(error).toMatchObject({
        recordType: "venue",
        recordId: host.venue.id,
        conflictingFields: ["recordVersion"],
      });
      expect(String(error)).not.toContain("change_request 0");
    }
  });

  it("skips malformed requests in the pending listing but keeps direct lookup strict", () => {
    const { season, requests, host } = fixtures();
    const valid = requests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "withdrawal",
    });
    const inserted = database.sqlite
      .prepare(
        `insert into change_requests
          (season_id, record_type, record_id, record_version, kind, proposed_value)
         values (?, 'act', ?, ?, 'address', 'not valid for an act')
         returning id`,
      )
      .get(season.id, host.venue.id, host.venue.version) as { id: number };

    expect(requests.listPendingForSeason(season.id)).toEqual([valid]);
    expect(() => requests.find(inserted.id)).toThrowError(
      ChangeRequestLifecycleError,
    );

    requests.reject(inserted.id, 1, season.id);
    expect(
      database.sqlite
        .prepare("select status from change_requests where id = ?")
        .get(inserted.id),
    ).toEqual({ status: "rejected" });
  });

  it("allows only one of two organizers to apply the same request", () => {
    const { season, requests, performer } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [],
    });

    requests.apply(request.id, request.version);
    expect(() => requests.apply(request.id, request.version)).toThrow(
      ChangeRequestConflictError,
    );
    expect(requests.find(request.id)?.status).toBe("applied");
  });

  it("refuses a request whose target has been superseded", () => {
    const { season, seasons, requests, performer } = fixtures();
    const canonical = seasons.createPerformerSignup({
      seasonId: season.id,
      contact: { name: "Canonical", email: "canonical@example.invalid" },
      act: {
        name: "Canonical Act",
        durationMinutes: 30,
        requiresAmplification: false,
        genre: "Folk",
        description: "Songs",
        links: "",
        housePreference: null,
        canLendGear: false,
        notes: null,
      },
      availabilities: [],
    });
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "withdrawal",
    });
    seasons.supersedeAct(
      performer.act.id,
      performer.act.version,
      canonical.act.id,
    );

    expect(() => requests.apply(request.id, request.version)).toThrow(
      ChangeRequestConflictError,
    );
    expect(requests.find(request.id)?.status).toBe("pending");
  });
});
