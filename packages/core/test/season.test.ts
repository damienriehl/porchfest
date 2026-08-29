import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AssignmentConflictError,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  createSeasonRepository,
  isSeasonActionLegal,
  type SeasonAction,
  type SeasonState,
} from "../src/season.js";
import { seasonStates } from "../src/storage/schema.js";
import { rankPairings } from "../src/matching.js";
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
    return insertVersionedVenue(seasonId, title).id;
  }

  function insertVersionedVenue(
    seasonId: number,
    title: string,
  ): { id: number; version: number } {
    return sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id, version",
      )
      .get(seasonId, title) as { id: number; version: number };
  }

  function insertContact(seasonId: number, name: string): number {
    return (
      sqlite
        .prepare(
          "insert into contacts (season_id, name) values (?, ?) returning id",
        )
        .get(seasonId, name) as { id: number }
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

  function insertSeasonTimeSlot(
    seasonId: number,
    position: number,
    offsetHours: number,
  ): void {
    const startsAt =
      Math.floor(pinnedNow.getTime() / 1000) + offsetHours * 3600;
    sqlite
      .prepare(
        "insert into season_time_slots (season_id, position, starts_at, ends_at) values (?, ?, ?, ?)",
      )
      .run(seasonId, position, startsAt, startsAt + 3600);
  }

  it("materializes every season time slot for a venue idempotently", () => {
    const season = insertSeason(2105, "locked");
    const venueId = insertVenue(season.id, "Materialized Porch");
    insertSeasonTimeSlot(season.id, 1, 0);
    insertSeasonTimeSlot(season.id, 2, 1);
    expect(seasonRepository.ensureVenueSlots(venueId)).toHaveLength(2);
    expect(seasonRepository.ensureVenueSlots(venueId)).toHaveLength(2);
    expect(
      sqlite
        .prepare("select count(*) as count from slots where venue_id = ?")
        .get(venueId),
    ).toEqual({ count: 2 });
  });

  it("names filled, held, duplicate-act, and shared-member assignment conflicts", () => {
    const season = insertSeason(2105, "assigning");
    const firstVenueId = insertVenue(season.id, "12 Maple St");
    const secondVenueId = insertVenue(season.id, "22 Oak St");
    const firstSlot = insertSlot(season.id, firstVenueId);
    const secondSlot = insertSlot(season.id, secondVenueId);
    const thirdSlot = insertSlot(season.id, secondVenueId, 2);
    const cats = insertAct(season.id, "The Porch Cats");
    const dogs = insertAct(season.id, "The Porch Dogs");
    seasonRepository.assignSlot(firstSlot.id, firstSlot.version, cats);

    expect(() =>
      seasonRepository.assignSlot(secondSlot.id, secondSlot.version, cats),
    ).toThrowError(/The Porch Cats.*12 Maple St.*12:00–1:00 PM/);
    expect(() =>
      seasonRepository.assignSlot(firstSlot.id, firstSlot.version + 1, dogs),
    ).toThrowError(AssignmentConflictError);

    const held = seasonRepository.holdSlot(thirdSlot.id, thirdSlot.version, {
      heldForName: "Unknown Band",
      decideBy: new Date("2105-07-01T00:00:00.000Z"),
    });
    expect(() =>
      seasonRepository.assignSlot(held.id, held.version, dogs),
    ).toThrowError(/Unknown Band.*2105-07-01/);

    const link = seasonRepository.linkActs({
      seasonId: season.id,
      actId: dogs,
      linkedActId: cats,
      note: "shared drummer",
    });
    expect(link.actId).toBeLessThan(link.linkedActId);
    expect(() =>
      seasonRepository.assignSlot(secondSlot.id, secondSlot.version, dogs),
    ).toThrowError(AssignmentConflictError);
    const assignment = seasonRepository.assignSlot(
      secondSlot.id,
      secondSlot.version,
      dogs,
      { sharedMemberOverride: "Organizer confirmed separate player" },
    );
    expect(assignment.sharedMemberOverride).toBe(
      "Organizer confirmed separate player",
    );
  });

  it("refuses to assign a withdrawn act by name", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Withdrawal Porch");
    const slot = insertSlot(season.id, venueId);
    const act = insertVersionedAct(season.id, "The Porch Cats");
    seasonRepository.setRecordStatus("act", act.id, act.version, "withdrawn");

    let thrown: unknown;
    try {
      seasonRepository.assignSlot(slot.id, slot.version, act.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssignmentConflictError);
    expect(thrown).toMatchObject({
      kind: "act_withdrawn",
      message: "The Porch Cats have withdrawn and cannot be assigned",
    });
  });

  it("normalizes and guards act links and unassigns with a version guard", () => {
    const season = insertSeason(2105, "locked");
    const otherSeason = insertSeason(2106, "locked");
    const venueId = insertVenue(season.id, "Correction Porch");
    const slot = insertSlot(season.id, venueId);
    const first = insertAct(season.id, "First Act");
    const second = insertAct(season.id, "Second Act");
    const foreign = insertAct(otherSeason.id, "Foreign Act");
    const firstAlias = insertVersionedAct(season.id, "First Act Alias");
    seasonRepository.supersedeAct(firstAlias.id, firstAlias.version, first);
    const link = seasonRepository.linkActs({
      seasonId: season.id,
      actId: second,
      linkedActId: firstAlias.id,
    });
    expect(link).toMatchObject({ actId: first, linkedActId: second });
    expect(() =>
      seasonRepository.linkActs({
        seasonId: season.id,
        actId: first,
        linkedActId: first,
      }),
    ).toThrowError(/itself/);
    expect(() =>
      seasonRepository.linkActs({
        seasonId: season.id,
        actId: first,
        linkedActId: second,
      }),
    ).toThrowError(/already linked/);
    expect(() =>
      seasonRepository.linkActs({
        seasonId: season.id,
        actId: first,
        linkedActId: foreign,
      }),
    ).toThrowError(/same season/);
    expect(seasonRepository.listActLinksForAct(second)).toEqual([link]);
    expect(seasonRepository.listActLinksForAct(firstAlias.id)).toEqual([link]);

    const assigning = sqlite
      .prepare("update seasons set state = 'assigning' where id = ?")
      .run(season.id);
    expect(assigning.changes).toBe(1);
    const assignment = seasonRepository.assignSlot(
      slot.id,
      slot.version,
      firstAlias.id,
    );
    expect(assignment.actId).toBe(first);
    expect(() =>
      seasonRepository.unassignSlot(assignment.id, assignment.version + 1),
    ).toThrowError(SeasonConflictError);
    const reopened = seasonRepository.unassignSlot(
      assignment.id,
      assignment.version,
    );
    expect(reopened.state).toBe("open");
    seasonRepository.unlinkActs(link.id, link.version);
    expect(seasonRepository.listActLinks(season.id)).toEqual([]);
  });

  it("keeps links usable after an endpoint is superseded", () => {
    const season = insertSeason(2105, "locked");
    const first = insertVersionedAct(season.id, "First Act");
    const replacement = insertVersionedAct(season.id, "Replacement Act");
    const second = insertVersionedAct(season.id, "Second Act");
    const link = seasonRepository.linkActs({
      seasonId: season.id,
      actId: first.id,
      linkedActId: second.id,
    });

    seasonRepository.supersedeAct(first.id, first.version, replacement.id);

    expect(seasonRepository.listActLinksForAct(replacement.id)).toEqual([link]);
    expect(() =>
      seasonRepository.linkActs({
        seasonId: season.id,
        actId: replacement.id,
        linkedActId: second.id,
      }),
    ).toThrowError(/already linked/);

    seasonRepository.unlinkActs(link.id, link.version);
    expect(seasonRepository.listActLinksForAct(replacement.id)).toEqual([]);
  });

  it("refuses venue supersession until assignments and holds are cleared", () => {
    const season = insertSeason(2105, "assigning");
    const source = insertVersionedVenue(season.id, "Booked Porch");
    const target = insertVersionedVenue(season.id, "Canonical Porch");
    const firstSlot = insertSlot(season.id, source.id);
    const secondSlot = insertSlot(season.id, source.id, 1);
    const heldSlot = insertSlot(season.id, source.id, 2);
    seasonRepository.assignSlot(
      firstSlot.id,
      firstSlot.version,
      insertAct(season.id, "First Booked Act"),
    );
    seasonRepository.assignSlot(
      secondSlot.id,
      secondSlot.version,
      insertAct(season.id, "Second Booked Act"),
    );
    seasonRepository.holdSlot(heldSlot.id, heldSlot.version, {
      heldForName: "Held Act",
      decideBy: new Date("2105-07-01T00:00:00.000Z"),
    });

    expect(() =>
      seasonRepository.supersedeVenue(source.id, source.version, target.id),
    ).toThrowError(
      "Unassign 2 acts and release 1 hold before superseding this venue",
    );
    expect(seasonRepository.getVenue(source.id)).toMatchObject({
      canonicalVenueId: null,
      version: source.version,
    });

    const heldOnly = insertVersionedVenue(season.id, "Held Porch");
    const heldOnlySlot = insertSlot(season.id, heldOnly.id, 3);
    seasonRepository.holdSlot(heldOnlySlot.id, heldOnlySlot.version, {
      heldForName: "Another Held Act",
      decideBy: new Date("2105-07-02T00:00:00.000Z"),
    });
    expect(() =>
      seasonRepository.supersedeVenue(heldOnly.id, heldOnly.version, target.id),
    ).toThrowError(
      "Unassign 0 acts and release 1 hold before superseding this venue",
    );
    expect(seasonRepository.getVenue(heldOnly.id)).toMatchObject({
      canonicalVenueId: null,
      version: heldOnly.version,
    });

    const empty = insertVersionedVenue(season.id, "Empty Porch");
    expect(
      seasonRepository.supersedeVenue(empty.id, empty.version, target.id),
    ).toMatchObject({
      canonicalVenueId: target.id,
      version: empty.version + 1,
    });
  });

  it("matches the documented legality policy for every season state and action", () => {
    const legalByAction: Readonly<
      Record<SeasonAction, readonly SeasonState[]>
    > = {
      signup: ["signups_open", "assigning"],
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

  it("creates a complete host signup and exposes it in the activity queue", () => {
    const season = insertSeason(2105, "signups_open");
    insertSeasonTimeSlot(season.id, 1, 2);

    const signup = seasonRepository.createHostSignup({
      seasonId: season.id,
      contact: {
        name: "Host Person",
        email: "host@example.invalid",
        phone: "synthetic-host-phone",
      },
      venue: {
        title: "Host Person's Porch",
        address: "123 Example Ave",
        spaceDescription: "Front porch, yard, and driveway",
        hasPower: true,
        rainBackup: false,
        notes: "Please use the side gate.",
        requestedActNames: "The Porch Cats",
        genrePreferences: "folk / jazz",
      },
      gear: ["pa", "microphone", "extension_cord"],
      drinks: ["water", "non_alcoholic"],
      amenities: ["seating", "shade", "accessible_entry"],
    });

    expect(signup.contact).toMatchObject({
      seasonId: season.id,
      name: "Host Person",
      email: "host@example.invalid",
      phone: "synthetic-host-phone",
    });
    expect(signup.venue).toMatchObject({
      seasonId: season.id,
      title: "Host Person's Porch",
      address: "123 Example Ave",
      spaceDescription: "Front porch, yard, and driveway",
      hasPower: true,
      rainBackup: false,
      notes: "Please use the side gate.",
      requestedActNames: "The Porch Cats",
      genrePreferences: "folk / jazz",
      hostContactId: signup.contact.id,
      placeholder: false,
    });
    expect(signup.gear.map(({ value }) => value)).toEqual([
      "pa",
      "microphone",
      "extension_cord",
    ]);
    expect(signup.drinks.map(({ value }) => value)).toEqual([
      "water",
      "non_alcoholic",
    ]);
    expect(signup.amenities.map(({ value }) => value)).toEqual([
      "seating",
      "shade",
      "accessible_entry",
    ]);
    expect(seasonRepository.listActivityQueue(season.id)).toEqual(
      expect.arrayContaining([
        { recordType: "contact", record: signup.contact },
        { recordType: "venue", record: signup.venue },
      ]),
    );
    expect(
      sqlite
        .prepare("select count(*) as count from slots where venue_id = ?")
        .get(signup.venue.id),
    ).toEqual({ count: 1 });
  });

  it("creates a complete performer signup and exposes it in the activity queue", () => {
    const season = insertSeason(2105, "signups_open");
    const firstStartsAt = new Date("2105-06-01T14:00:00.000Z");
    const firstEndsAt = new Date("2105-06-01T14:45:00.000Z");
    const secondStartsAt = new Date("2105-06-01T16:00:00.000Z");
    const secondEndsAt = new Date("2105-06-01T16:45:00.000Z");

    const signup = seasonRepository.createPerformerSignup({
      seasonId: season.id,
      contact: {
        name: "Performer Person",
        email: "performer@example.invalid",
        phone: "synthetic-performer-phone",
      },
      act: {
        name: "The Typed Columns",
        durationMinutes: 45,
        requiresAmplification: true,
        genre: "Folk, rock",
        description: "Songs with harmonies.",
        links: "https://example.invalid/the-typed-columns",
        housePreference: "Near the park",
        canLendGear: true,
        notes: null,
        sharedMemberNote: "A drummer also plays with The Other Act",
      },
      availabilities: [
        { startsAt: firstStartsAt, endsAt: firstEndsAt },
        { startsAt: secondStartsAt, endsAt: secondEndsAt },
      ],
    });

    expect(signup.contact).toMatchObject({
      seasonId: season.id,
      name: "Performer Person",
      email: "performer@example.invalid",
      phone: "synthetic-performer-phone",
    });
    expect(signup.act).toMatchObject({
      seasonId: season.id,
      name: "The Typed Columns",
      durationMinutes: 45,
      requiresAmplification: true,
      genre: "Folk, rock",
      description: "Songs with harmonies.",
      links: "https://example.invalid/the-typed-columns",
      housePreference: "Near the park",
      canLendGear: true,
      notes: null,
      sharedMemberNote: "A drummer also plays with The Other Act",
      reachViaContactId: signup.contact.id,
      placeholder: false,
    });
    expect(signup.availabilities).toEqual([
      expect.objectContaining({
        seasonId: season.id,
        actId: signup.act.id,
        startsAt: firstStartsAt,
        endsAt: firstEndsAt,
      }),
      expect.objectContaining({
        seasonId: season.id,
        actId: signup.act.id,
        startsAt: secondStartsAt,
        endsAt: secondEndsAt,
      }),
    ]);
    expect(seasonRepository.listActivityQueue(season.id)).toEqual(
      expect.arrayContaining([
        { recordType: "contact", record: signup.contact },
        { recordType: "act", record: signup.act },
      ]),
    );
  });

  it("creates host and performer signups while assigning with empty child sets", () => {
    const season = insertSeason(2106, "assigning");

    const host = seasonRepository.createHostSignup({
      seasonId: season.id,
      contact: { name: "Rolling Host" },
      venue: {
        title: "Rolling Host Venue",
        address: "789 Rolling Signup Road",
        spaceDescription: "A venue with no selected extras",
        hasPower: false,
        rainBackup: false,
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    });
    const performer = seasonRepository.createPerformerSignup({
      seasonId: season.id,
      contact: { name: "Rolling Performer" },
      act: {
        name: "The Late Additions",
        durationMinutes: 30,
        requiresAmplification: false,
        genre: "",
        description: "",
        links: "",
        housePreference: null,
        canLendGear: false,
        notes: null,
      },
      availabilities: [],
    });

    expect(host.gear).toEqual([]);
    expect(host.drinks).toEqual([]);
    expect(host.amenities).toEqual([]);
    expect(performer.availabilities).toEqual([]);
    expect(seasonRepository.listActivityQueue(season.id)).toEqual(
      expect.arrayContaining([
        { recordType: "contact", record: host.contact },
        { recordType: "venue", record: host.venue },
        { recordType: "contact", record: performer.contact },
        { recordType: "act", record: performer.act },
      ]),
    );
  });

  it("refuses host and performer signup creation in closed states and persists nothing", () => {
    for (const state of seasonStates.filter(
      (candidate) => !["signups_open", "assigning"].includes(candidate),
    )) {
      const season = insertSeason(2200 + seasonStates.indexOf(state), state);

      expect(() =>
        seasonRepository.createHostSignup({
          seasonId: season.id,
          contact: { name: `Refused ${state}` },
          venue: {
            title: `Refused ${state} Venue`,
            address: "Not persisted",
            spaceDescription: "Not persisted",
            hasPower: false,
            rainBackup: false,
            notes: null,
          },
          gear: [],
          drinks: [],
          amenities: [],
        }),
      ).toThrowError(`season state ${state} refuses action signup`);

      expect(() =>
        seasonRepository.createPerformerSignup({
          seasonId: season.id,
          contact: { name: `Refused performer ${state}` },
          act: {
            name: `Refused ${state} Act`,
            durationMinutes: 30,
            requiresAmplification: false,
            genre: "",
            description: "",
            links: "",
            housePreference: null,
            canLendGear: false,
            notes: null,
          },
          availabilities: [],
        }),
      ).toThrowError(`season state ${state} refuses action signup`);
    }

    expect(
      sqlite.prepare("select count(*) as count from contacts").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("select count(*) as count from venues").get(),
    ).toEqual({ count: 0 });
    expect(sqlite.prepare("select count(*) as count from acts").get()).toEqual({
      count: 0,
    });
    for (const table of [
      "venue_gear",
      "venue_drinks",
      "venue_amenities",
      "act_availabilities",
    ]) {
      expect(
        sqlite.prepare(`select count(*) as count from ${table}`).get(),
      ).toEqual({ count: 0 });
    }
  });

  it("rolls back a signup when a delegated child-row write fails", () => {
    const season = insertSeason(2105, "signups_open");
    const delegatedFailure = new Error("delegated signup write failed");
    let timestampCalls = 0;
    const atomicRepository = createSeasonRepository(database.db, {
      now: () => {
        timestampCalls += 1;
        if (timestampCalls === 3) {
          sqlite
            .prepare("update seasons set state = 'archived' where id = ?")
            .run(season.id);
          throw delegatedFailure;
        }
        return pinnedNow;
      },
    });

    expect(() =>
      atomicRepository.createHostSignup({
        seasonId: season.id,
        contact: { name: "Atomic Host" },
        venue: {
          title: "Atomic Venue",
          address: "456 Rollback Road",
          spaceDescription: "A space that must not persist",
          hasPower: true,
          rainBackup: true,
          notes: null,
        },
        gear: ["pa"],
        drinks: [],
        amenities: [],
      }),
    ).toThrow(delegatedFailure);
    expect(
      sqlite.prepare("select state from seasons where id = ?").get(season.id),
    ).toEqual({ state: "signups_open" });
    expect(
      sqlite.prepare("select count(*) as count from contacts").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("select count(*) as count from venues").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("select count(*) as count from venue_gear").get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back a performer signup when a delegated availability write fails", () => {
    const season = insertSeason(2105, "signups_open");
    const delegatedFailure = new Error("delegated availability write failed");
    let timestampCalls = 0;
    const atomicRepository = createSeasonRepository(database.db, {
      now: () => {
        timestampCalls += 1;
        if (timestampCalls === 3) {
          sqlite
            .prepare("update seasons set state = 'archived' where id = ?")
            .run(season.id);
          throw delegatedFailure;
        }
        return pinnedNow;
      },
    });

    expect(() =>
      atomicRepository.createPerformerSignup({
        seasonId: season.id,
        contact: { name: "Atomic Performer" },
        act: {
          name: "Atomic Act",
          durationMinutes: 45,
          requiresAmplification: false,
          genre: "Folk",
          description: "Must not persist",
          links: "https://example.invalid/atomic-act",
          housePreference: null,
          canLendGear: false,
          notes: null,
        },
        availabilities: [
          {
            startsAt: new Date("2105-06-01T14:00:00.000Z"),
            endsAt: new Date("2105-06-01T14:45:00.000Z"),
          },
        ],
      }),
    ).toThrow(delegatedFailure);
    expect(
      sqlite.prepare("select state from seasons where id = ?").get(season.id),
    ).toEqual({ state: "signups_open" });
    expect(
      sqlite.prepare("select count(*) as count from contacts").get(),
    ).toEqual({ count: 0 });
    expect(sqlite.prepare("select count(*) as count from acts").get()).toEqual({
      count: 0,
    });
    expect(
      sqlite.prepare("select count(*) as count from act_availabilities").get(),
    ).toEqual({ count: 0 });
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
    ).toThrowError(/Named Act That Never Signed Up.*2105-06-01/);
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
    const concurrentActId = insertAct(season.id, "Concurrent Act");
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
        concurrentActId,
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

  it("refuses unassignment in a locked season and names the state", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Locked Unassign Venue");
    const slot = insertSlot(season.id, venueId);
    const actId = insertAct(season.id, "Locked Unassign Act");
    const assignment = seasonRepository.assignSlot(
      slot.id,
      slot.version,
      actId,
    );
    const current = seasonRepository.getSeason(season.id);
    seasonRepository.transitionSeason(season.id, current.version, "locked");

    expect(() =>
      seasonRepository.unassignSlot(assignment.id, assignment.version),
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
    const statusAct = insertVersionedAct(season.id, "Archived Status Act");
    const statusVenue = insertVersionedVenue(
      season.id,
      "Archived Status Venue",
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
      seasonRepository.setRecordStatus(
        "act",
        statusAct.id,
        statusAct.version,
        "withdrawn",
      ),
    ).toThrowError("season state archived refuses action correction");
    expect(() =>
      seasonRepository.setRecordStatus(
        "venue",
        statusVenue.id,
        statusVenue.version,
        "withdrawn",
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
    expect(
      sqlite.prepare("select status from acts where id = ?").get(statusAct.id),
    ).toEqual({ status: "tentative" });
    expect(
      sqlite
        .prepare("select status from venues where id = ?")
        .get(statusVenue.id),
    ).toEqual({ status: "tentative" });
  });

  it("rolls back season state changed during a failed delegated record write", () => {
    const season = insertSeason(2105, "setup");
    const act = insertVersionedAct(season.id, "Atomic Correction Target");
    const delegatedFailure = new Error("delegated write failed");
    const atomicRepository = createSeasonRepository(database.db, {
      now: () => {
        sqlite
          .prepare("update seasons set state = 'archived' where id = ?")
          .run(season.id);
        throw delegatedFailure;
      },
    });

    expect(() =>
      atomicRepository.updateAct(act.id, act.version, {
        name: "Uncommitted Correction",
      }),
    ).toThrow(delegatedFailure);
    expect(
      sqlite.prepare("select state from seasons where id = ?").get(season.id),
    ).toEqual({ state: "setup" });
    expect(
      sqlite.prepare("select name from acts where id = ?").get(act.id),
    ).toEqual({ name: "Atomic Correction Target" });
  });

  it("refuses act promotion when an assigned superseded child belongs to the placeholder family", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(
      season.id,
      "Placeholder-family Collision Venue",
    );
    const placeholderSlot = insertSlot(season.id, venueId);
    const submissionSlot = insertSlot(season.id, venueId, 2);
    const placeholder = insertVersionedAct(
      season.id,
      "Canonical Placeholder",
      true,
    );
    const placeholderChild = insertVersionedAct(
      season.id,
      "Duplicate Placeholder Child",
    );
    const submission = insertVersionedAct(season.id, "Assigned Submission");
    seasonRepository.assignSlot(
      placeholderSlot.id,
      placeholderSlot.version,
      placeholderChild.id,
    );
    seasonRepository.supersedeAct(
      placeholderChild.id,
      placeholderChild.version,
      placeholder.id,
    );
    seasonRepository.assignSlot(
      submissionSlot.id,
      submissionSlot.version,
      submission.id,
    );
    const actsBefore = sqlite
      .prepare(
        "select id, name, placeholder, canonical_act_id, version from acts order by id",
      )
      .all();

    expect(() =>
      seasonRepository.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError("act promotion would merge assignments");
    expect(
      sqlite
        .prepare(
          "select id, name, placeholder, canonical_act_id, version from acts order by id",
        )
        .all(),
    ).toEqual(actsBefore);
  });

  it("refuses act promotion when an assigned superseded child belongs to the submission family", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Submission-family Collision Venue");
    const placeholderSlot = insertSlot(season.id, venueId);
    const submissionSlot = insertSlot(season.id, venueId, 2);
    const placeholder = insertVersionedAct(
      season.id,
      "Assigned Placeholder",
      true,
    );
    const submission = insertVersionedAct(season.id, "Canonical Submission");
    const submissionChild = insertVersionedAct(
      season.id,
      "Duplicate Submission Child",
    );
    seasonRepository.assignSlot(
      placeholderSlot.id,
      placeholderSlot.version,
      placeholder.id,
    );
    seasonRepository.assignSlot(
      submissionSlot.id,
      submissionSlot.version,
      submissionChild.id,
    );
    seasonRepository.supersedeAct(
      submissionChild.id,
      submissionChild.version,
      submission.id,
    );

    expect(() =>
      seasonRepository.promotePlaceholderAct(
        placeholder.id,
        placeholder.version,
        submission.id,
        submission.version,
      ),
    ).toThrowError("act promotion would merge assignments");
    expect(
      sqlite
        .prepare("select placeholder, version from acts where id = ?")
        .get(placeholder.id),
    ).toEqual({ placeholder: 1, version: placeholder.version });
    expect(
      sqlite
        .prepare("select canonical_act_id, version from acts where id = ?")
        .get(submission.id),
    ).toEqual({ canonical_act_id: null, version: submission.version });
  });

  it("allows act promotion when only a superseded placeholder-family child is assigned", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Legal Promotion Venue");
    const slot = insertSlot(season.id, venueId);
    const placeholder = insertVersionedAct(
      season.id,
      "Legal Canonical Placeholder",
      true,
    );
    const placeholderChild = insertVersionedAct(
      season.id,
      "Legal Placeholder Child",
    );
    const submission = insertVersionedAct(season.id, "Legal Submission");
    seasonRepository.assignSlot(slot.id, slot.version, placeholderChild.id);
    seasonRepository.supersedeAct(
      placeholderChild.id,
      placeholderChild.version,
      placeholder.id,
    );

    const promoted = seasonRepository.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Legal Submission",
      placeholder: false,
    });
    expect(
      sqlite
        .prepare("select canonical_act_id from acts where id = ?")
        .get(submission.id),
    ).toEqual({ canonical_act_id: placeholder.id });
  });

  it("allows act promotion when only the submission family is assigned", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Submission-only Promotion Venue");
    const slot = insertSlot(season.id, venueId);
    const placeholder = insertVersionedAct(
      season.id,
      "Unassigned Placeholder",
      true,
    );
    const submission = insertVersionedAct(
      season.id,
      "Assigned Legal Submission",
    );
    seasonRepository.assignSlot(slot.id, slot.version, submission.id);

    const promoted = seasonRepository.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Assigned Legal Submission",
      placeholder: false,
    });
  });

  it("allows act promotion when it does not worsen an existing duplicate target family", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Non-worsening Promotion Venue");
    const firstSlot = insertSlot(season.id, venueId);
    const secondSlot = insertSlot(season.id, venueId, 2);
    const placeholder = insertVersionedAct(
      season.id,
      "Already-duplicated Placeholder",
      true,
    );
    const firstChild = insertVersionedAct(season.id, "First Existing Child");
    const secondChild = insertVersionedAct(season.id, "Second Existing Child");
    const submission = insertVersionedAct(
      season.id,
      "Non-worsening Submission",
    );
    sqlite
      .prepare("update acts set canonical_act_id = ? where id in (?, ?)")
      .run(placeholder.id, firstChild.id, secondChild.id);
    sqlite
      .prepare(
        "insert into assignments (season_id, act_id, slot_id) values (?, ?, ?), (?, ?, ?)",
      )
      .run(
        season.id,
        firstChild.id,
        firstSlot.id,
        season.id,
        secondChild.id,
        secondSlot.id,
      );

    const promoted = seasonRepository.promotePlaceholderAct(
      placeholder.id,
      placeholder.version,
      submission.id,
      submission.version,
    );

    expect(promoted).toMatchObject({
      id: placeholder.id,
      name: "Non-worsening Submission",
      placeholder: false,
    });
  });

  it("keeps descendant-family supersession collisions in the season wrapper", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Descendant Collision Venue");
    const targetSlot = insertSlot(season.id, venueId);
    const sourceSlot = insertSlot(season.id, venueId, 2);
    const target = insertVersionedAct(season.id, "Target Family");
    const targetChild = insertVersionedAct(season.id, "Target Child");
    const source = insertVersionedAct(season.id, "Source Family");
    const sourceChild = insertVersionedAct(season.id, "Source Child");
    seasonRepository.assignSlot(
      targetSlot.id,
      targetSlot.version,
      targetChild.id,
    );
    seasonRepository.supersedeAct(
      targetChild.id,
      targetChild.version,
      target.id,
    );
    seasonRepository.assignSlot(
      sourceSlot.id,
      sourceSlot.version,
      sourceChild.id,
    );
    seasonRepository.supersedeAct(
      sourceChild.id,
      sourceChild.version,
      source.id,
    );

    expect(() =>
      seasonRepository.supersedeAct(source.id, source.version, target.id),
    ).toThrowError(
      `canonical act ${target.id} is already assigned in season ${season.id}`,
    );
    expect(
      sqlite
        .prepare("select canonical_act_id, version from acts where id = ?")
        .get(source.id),
    ).toEqual({ canonical_act_id: null, version: source.version });
  });

  it("resolves a superseded target alias before checking assignment collisions", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Target-alias Collision Venue");
    const targetSlot = insertSlot(season.id, venueId);
    const sourceSlot = insertSlot(season.id, venueId, 2);
    const target = insertVersionedAct(season.id, "Canonical Alias Target");
    const targetAlias = insertVersionedAct(season.id, "Target Alias");
    const source = insertVersionedAct(season.id, "Alias-collision Source");
    seasonRepository.assignSlot(targetSlot.id, targetSlot.version, target.id);
    seasonRepository.supersedeAct(
      targetAlias.id,
      targetAlias.version,
      target.id,
    );
    seasonRepository.assignSlot(sourceSlot.id, sourceSlot.version, source.id);

    expect(() =>
      seasonRepository.supersedeAct(source.id, source.version, targetAlias.id),
    ).toThrowError(
      `canonical act ${target.id} is already assigned in season ${season.id}`,
    );
    expect(
      sqlite
        .prepare("select canonical_act_id, version from acts where id = ?")
        .get(source.id),
    ).toEqual({ canonical_act_id: null, version: source.version });
  });

  it("refuses an act correction that links a reach-via contact from another season", () => {
    const first = insertSeason(2104, "setup");
    const second = insertSeason(2105, "setup");
    const act = insertVersionedAct(first.id, "First-season Act");
    const secondContactId = insertContact(second.id, "Second-season Contact");

    expect(() =>
      seasonRepository.updateAct(act.id, act.version, {
        reachViaContactId: secondContactId,
      }),
    ).toThrowError("reach-via contact and act belong to different seasons");
    expect(
      sqlite
        .prepare("select reach_via_contact_id, version from acts where id = ?")
        .get(act.id),
    ).toEqual({ reach_via_contact_id: null, version: act.version });
  });

  it("refuses a venue correction that links a host contact from another season", () => {
    const first = insertSeason(2104, "setup");
    const second = insertSeason(2105, "setup");
    const venue = insertVersionedVenue(first.id, "First-season Venue");
    const secondContactId = insertContact(second.id, "Second-season Host");

    expect(() =>
      seasonRepository.updateVenue(venue.id, venue.version, {
        hostContactId: secondContactId,
      }),
    ).toThrowError("host contact and venue belong to different seasons");
    expect(
      sqlite
        .prepare("select host_contact_id, version from venues where id = ?")
        .get(venue.id),
    ).toEqual({ host_contact_id: null, version: venue.version });
  });

  it("refuses a venue correction that links a reach-via contact from another season", () => {
    const first = insertSeason(2104, "setup");
    const second = insertSeason(2105, "setup");
    const venue = insertVersionedVenue(first.id, "First-season Reach Venue");
    const secondContactId = insertContact(
      second.id,
      "Second-season Reach Contact",
    );

    expect(() =>
      seasonRepository.updateVenue(venue.id, venue.version, {
        reachViaContactId: secondContactId,
      }),
    ).toThrowError("reach-via contact and venue belong to different seasons");
    expect(
      sqlite
        .prepare(
          "select reach_via_contact_id, version from venues where id = ?",
        )
        .get(venue.id),
    ).toEqual({ reach_via_contact_id: null, version: venue.version });
  });

  it("allows same-season contact links and clearing them with null", () => {
    const season = insertSeason(2105, "setup");
    const contactId = insertContact(season.id, "Same-season Contact");
    const act = insertVersionedAct(season.id, "Same-season Contact Act");
    const venue = insertVersionedVenue(season.id, "Same-season Contact Venue");

    const linkedAct = seasonRepository.updateAct(act.id, act.version, {
      reachViaContactId: contactId,
    });
    const linkedVenue = seasonRepository.updateVenue(venue.id, venue.version, {
      hostContactId: contactId,
      reachViaContactId: contactId,
    });
    const clearedAct = seasonRepository.updateAct(
      linkedAct.id,
      linkedAct.version,
      { reachViaContactId: null },
    );
    const clearedVenue = seasonRepository.updateVenue(
      linkedVenue.id,
      linkedVenue.version,
      { hostContactId: null, reachViaContactId: null },
    );

    expect(clearedAct).toMatchObject({
      reachViaContactId: null,
      version: act.version + 2,
    });
    expect(clearedVenue).toMatchObject({
      hostContactId: null,
      reachViaContactId: null,
      version: venue.version + 2,
    });
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

    expect(
      rankPairings(seasonRepository.buildMatchingInput(season.id)),
    ).toEqual([]);
    expect(() =>
      seasonRepository.assignSlot(openSlot.id, openSlot.version, canonical.id),
    ).toThrowError(/Canonical Band.*Supersession Venue.*12:00–1:00 PM/);
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

  it("refuses assignment through a supersession cycle without changing the slot", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Cycle Venue");
    const slot = insertSlot(season.id, venueId);
    const first = insertVersionedAct(season.id, "Cycle Act One");
    const second = insertVersionedAct(season.id, "Cycle Act Two");
    sqlite
      .prepare(
        "update acts set canonical_act_id = case id when ? then ? else ? end where id in (?, ?)",
      )
      .run(first.id, second.id, first.id, first.id, second.id);

    expect(() =>
      seasonRepository.assignSlot(slot.id, slot.version, first.id),
    ).toThrowError(`act ${first.id} has a supersession cycle`);
    expect(
      sqlite
        .prepare("select state, version from slots where id = ?")
        .get(slot.id),
    ).toEqual({ state: "open", version: slot.version });
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

  it("stores canonical identity on assignment correction and withdrawal reopens the slot", () => {
    const season = insertSeason(2105, "assigning");
    const venueId = insertVenue(season.id, "Canonical Correction Venue");
    const slot = insertSlot(season.id, venueId);
    const original = insertVersionedAct(season.id, "Original Assignment");
    const canonical = insertVersionedAct(season.id, "Canonical Replacement");
    const alias = insertVersionedAct(season.id, "Replacement Alias");
    const assignment = seasonRepository.assignSlot(
      slot.id,
      slot.version,
      original.id,
    );
    seasonRepository.supersedeAct(alias.id, alias.version, canonical.id);

    const corrected = seasonRepository.correctAssignment(
      assignment.id,
      assignment.version,
      { actId: alias.id },
    );
    expect(corrected.actId).toBe(canonical.id);

    seasonRepository.setRecordStatus(
      "act",
      canonical.id,
      canonical.version,
      "withdrawn",
    );
    expect(seasonRepository.getSlot(slot.id).state).toBe("open");
    expect(seasonRepository.listAssignments(season.id)).toEqual([]);
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
    expect(rankPairings(seasonRepository.buildMatchingInput(first.id))).toEqual(
      [
        expect.objectContaining({
          act: expect.objectContaining({
            id: firstCandidateId,
          }),
          slot: expect.objectContaining({
            id: firstOpenSlot.id,
          }),
        }),
      ],
    );
    expect(
      seasonRepository.suggestForVenue(firstVenueId).map(({ act }) => act.id),
    ).toEqual([firstCandidateId]);
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

  it("refuses archival while held slots remain and exposes read-only slot lookups", () => {
    const season = insertSeason(2105, "locked");
    const venueId = insertVenue(season.id, "Held Archive Venue");
    const first = insertSlot(season.id, venueId);
    const second = insertSlot(season.id, venueId, 2);
    sqlite
      .prepare(
        "update slots set state = 'held', held_for_name = 'Synthetic Hold', held_decide_by = ? where id in (?, ?)",
      )
      .run(Math.floor(pinnedNow.getTime() / 1000), first.id, second.id);

    expect(() =>
      seasonRepository.transitionSeason(season.id, season.version, "archived"),
    ).toThrowError("2 slots are still held; release them before archiving");
    expect(seasonRepository.getSlot(first.id).id).toBe(first.id);
    expect(seasonRepository.listVenueSlots(venueId)).toHaveLength(2);
    expect(seasonRepository.listSeasonSlots(season.id)).toHaveLength(2);
  });
});
