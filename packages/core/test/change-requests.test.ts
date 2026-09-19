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
  it("returns an identical pending proposal instead of recording a duplicate", () => {
    const { season, requests, host } = fixtures();
    const input = {
      seasonId: season.id,
      recordType: "venue" as const,
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "address" as const,
      proposedAddress: "2 Proposed Ave",
    };

    const first = requests.record(input);
    const duplicate = requests.record(input);

    expect(duplicate).toEqual(first);
    expect(requests.listPendingForSeason(season.id)).toEqual([first]);
    expect(
      database.sqlite
        .prepare("select count(*) as count from change_requests")
        .get(),
    ).toEqual({ count: 1 });

    requests.reject(first.id, first.version);
    const replacement = requests.record(input);
    expect(replacement.id).not.toBe(first.id);
    expect(requests.find(first.id)?.status).toBe("rejected");
    expect(requests.listPendingForSeason(season.id)).toEqual([replacement]);
  });

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

describe("change request validation and recovery boundaries", () => {
  it("returns empty lookups and refuses decisions about missing requests", () => {
    const { season, requests } = fixtures();
    expect(requests.find(999999)).toBeNull();
    expect(requests.listPendingForSeason(season.id)).toEqual([]);
    for (const action of [
      requests.apply,
      requests.reject,
      requests.completeAddressReview,
    ]) {
      expect(() => action(999999, 1)).toThrow(ChangeRequestConflictError);
    }
  });

  it("trims address proposals before deduplicating and rejects blank input", () => {
    const { season, requests, host } = fixtures();
    const input = {
      seasonId: season.id,
      recordType: "venue" as const,
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "address" as const,
      proposedAddress: "  2 Proposed Ave  ",
    };
    const first = requests.record(input);
    expect(first.proposedAddress).toBe("2 Proposed Ave");
    expect(
      requests.record({ ...input, proposedAddress: "2 Proposed Ave" }),
    ).toEqual(first);
    expect(() =>
      requests.record({ ...input, proposedAddress: " \t " }),
    ).toThrow(ChangeRequestLifecycleError);
    expect(requests.listPendingForSeason(season.id)).toEqual([first]);
  });

  it.each([
    [new Date("invalid"), new Date("2031-09-13T15:00:00Z")],
    [new Date("2031-09-13T14:00:00Z"), new Date("invalid")],
    [new Date("2031-09-13T14:00:00Z"), new Date("2031-09-13T14:00:00Z")],
    [new Date("2031-09-13T15:00:00Z"), new Date("2031-09-13T14:00:00Z")],
  ])(
    "rejects an invalid availability interval without persisting a request (%#)",
    (startsAt, endsAt) => {
      const { season, requests, performer } = fixtures();
      expect(() =>
        requests.record({
          seasonId: season.id,
          recordType: "act",
          recordId: performer.act.id,
          recordVersion: performer.act.version,
          kind: "availability",
          proposedAvailability: [{ startsAt, endsAt }],
        }),
      ).toThrow(ChangeRequestLifecycleError);
      expect(requests.listPendingForSeason(season.id)).toEqual([]);
    },
  );

  it("does not let a rejection in the wrong season consume the pending version", () => {
    const { season, requests, host } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: host.venue.id,
      recordVersion: host.venue.version,
      kind: "withdrawal",
    });
    expect(() =>
      requests.reject(request.id, request.version, season.id + 1),
    ).toThrow(ChangeRequestConflictError);
    expect(requests.find(request.id)).toEqual(request);
    expect(
      requests.reject(request.id, request.version, season.id),
    ).toMatchObject({ status: "rejected", version: request.version + 1 });
    expect(() =>
      requests.reject(request.id, request.version, season.id),
    ).toThrow(ChangeRequestConflictError);
  });

  it("does not complete a non-address request through address review", () => {
    const { season, requests, performer } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [],
    });
    expect(() =>
      requests.completeAddressReview(request.id, request.version),
    ).toThrow(ChangeRequestLifecycleError);
    expect(requests.find(request.id)).toEqual(request);
    requests.apply(request.id, request.version);
    expect(
      database.sqlite
        .prepare("select * from act_availabilities where act_id = ?")
        .all(performer.act.id),
    ).toEqual([]);
    expect(
      database.sqlite
        .prepare("select version from acts where id = ?")
        .get(performer.act.id),
    ).toEqual({ version: performer.act.version + 1 });
  });

  it.each([
    "not-json",
    "null",
    "{}",
    "[null]",
    '[{"startsAt":"invalid","endsAt":"2031-09-13"}]',
    '[{"startsAt":"2031-09-14","endsAt":"2031-09-13"}]',
  ])(
    "isolates corrupt availability %s and still allows rejection",
    (proposal) => {
      const { season, requests, performer } = fixtures();
      const valid = requests.record({
        seasonId: season.id,
        recordType: "act",
        recordId: performer.act.id,
        recordVersion: performer.act.version,
        kind: "withdrawal",
      });
      const { id } = database.sqlite
        .prepare(
          "insert into change_requests (season_id, record_type, record_id, record_version, kind, proposed_value) values (?, 'act', ?, ?, 'availability', ?) returning id",
        )
        .get(season.id, performer.act.id, performer.act.version, proposal) as {
        id: number;
      };
      expect(() => requests.find(id)).toThrow(ChangeRequestLifecycleError);
      expect(requests.listPendingForSeason(season.id)).toEqual([valid]);
      expect(requests.reject(id, 1, season.id)).toMatchObject({
        status: "rejected",
        proposedAvailability: null,
        version: 2,
      });
      expect(requests.listPendingForSeason(season.id)).toEqual([valid]);
    },
  );

  it("rolls back the claim, act version, and deleted availability on storage failure", () => {
    const { season, requests, performer } = fixtures();
    const request = requests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [
        {
          startsAt: new Date("2031-09-13T18:00:00Z"),
          endsAt: new Date("2031-09-13T19:00:00Z"),
        },
      ],
    });
    const before = database.sqlite
      .prepare("select * from act_availabilities where act_id = ?")
      .all(performer.act.id);
    database.sqlite.exec(
      "create trigger refuse_availability before insert on act_availabilities begin select raise(abort, 'synthetic storage failure'); end;",
    );
    expect(() => requests.apply(request.id, request.version)).toThrow();
    expect(requests.find(request.id)).toEqual(request);
    expect(
      database.sqlite
        .prepare("select version from acts where id = ?")
        .get(performer.act.id),
    ).toEqual({ version: performer.act.version });
    expect(
      database.sqlite
        .prepare("select * from act_availabilities where act_id = ?")
        .all(performer.act.id),
    ).toEqual(before);
    database.sqlite.exec("drop trigger refuse_availability");
    expect(requests.apply(request.id, request.version).status).toBe("applied");
  });
});
