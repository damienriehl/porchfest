import { afterEach, describe, expect, it } from "vitest";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const openDatabases: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.close()),
  );
});

async function seasonIn(state: string) {
  const database = await openTestDatabase("porchfest-map-publication-");
  openDatabases.push(database);
  const setup = createSeasonSetup(
    database.db,
    () => new Date("2034-01-01T00:00:00.000Z"),
  );
  const { season } = setup.createSeason({
    year: 2034,
    displayName: "Synthetic Map Season",
    timezone: "UTC",
    eventDate: "2034-09-16",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [{ startsAt: "18:00", endsAt: "19:00" }],
    localityName: "Example Borough",
    bounds: { north: 11, south: 10, east: 21, west: 20 },
    openSignups: false,
  });
  database.sqlite
    .prepare("update seasons set state = ? where id = ?")
    .run(state, season.id);
  return {
    database,
    seasons: createSeasonRepository(database.db, {
      now: () => new Date("2034-08-29T20:00:00.000Z"),
    }),
    seasonId: season.id,
  };
}

describe("season map publication", () => {
  it.each(["setup", "signups_open", "signups_closed", "assigning", "archived"])(
    "R16/R28 refuses map publication while the season is %s",
    async (state) => {
      const fixture = await seasonIn(state);
      const season = fixture.seasons.getSeason(fixture.seasonId);

      expect(() =>
        fixture.seasons.publishSeasonMap(season.id, season.version, {
          eventCity: season.eventCity,
          eventState: season.eventState,
        }),
      ).toThrow(`season state ${state} refuses action map_publish`);
      expect(fixture.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
    },
  );

  it("R16 publishes and unpublishes a locked season with version guards", async () => {
    const fixture = await seasonIn("locked");
    const locked = fixture.seasons.getSeason(fixture.seasonId);

    const published = fixture.seasons.publishSeasonMap(
      locked.id,
      locked.version,
      { eventCity: locked.eventCity, eventState: locked.eventState },
    );
    expect(published.mapPublishedAt).toEqual(
      new Date("2034-08-29T20:00:00.000Z"),
    );
    expect(published.version).toBe(locked.version + 1);
    expect(() =>
      fixture.seasons.unpublishSeasonMap(published.id, locked.version),
    ).toThrow(/someone else changed|conflict/i);

    const unpublished = fixture.seasons.unpublishSeasonMap(
      published.id,
      published.version,
    );
    expect(unpublished.mapPublishedAt).toBeNull();
    expect(unpublished.version).toBe(published.version + 1);
  });

  it("R16 requires repairable event metadata before publication", async () => {
    const fixture = await seasonIn("locked");
    fixture.database.sqlite
      .prepare(
        "update seasons set event_city = 'Unconfigured', event_state = 'Unconfigured' where id = ?",
      )
      .run(fixture.seasonId);
    const locked = fixture.seasons.getSeason(fixture.seasonId);

    expect(() =>
      fixture.seasons.publishSeasonMap(locked.id, locked.version, {
        eventCity: "Unconfigured",
        eventState: "WI",
      }),
    ).toThrow(/event city/i);
    expect(() =>
      fixture.seasons.publishSeasonMap(locked.id, locked.version, {
        eventCity: "Exampleton",
        eventState: " ",
      }),
    ).toThrow(/event state/i);
    const published = fixture.seasons.publishSeasonMap(
      locked.id,
      locked.version,
      { eventCity: "Exampleton", eventState: "WI" },
    );

    expect(published.eventCity).toBe("Exampleton");
    expect(published.eventState).toBe("WI");
    expect(published.mapPublishedAt).not.toBeNull();
  });

  it("R16/R28 clears publication when a season is archived", async () => {
    const fixture = await seasonIn("locked");
    const locked = fixture.seasons.getSeason(fixture.seasonId);
    const published = fixture.seasons.publishSeasonMap(
      locked.id,
      locked.version,
      { eventCity: locked.eventCity, eventState: locked.eventState },
    );

    const archived = fixture.seasons.transitionSeason(
      published.id,
      published.version,
      "archived",
    );

    expect(archived.state).toBe("archived");
    expect(archived.mapPublishedAt).toBeNull();
  });

  it("updates event metadata and publication atomically on a version conflict", async () => {
    const fixture = await seasonIn("locked");
    const locked = fixture.seasons.getSeason(fixture.seasonId);
    fixture.database.sqlite
      .prepare("update seasons set version = version + 1 where id = ?")
      .run(locked.id);

    expect(() =>
      fixture.seasons.publishSeasonMap(locked.id, locked.version, {
        eventCity: "Changed City",
        eventState: "MN",
      }),
    ).toThrow(/someone else changed|conflict/i);

    expect(fixture.seasons.getSeason(locked.id)).toMatchObject({
      eventCity: "Exampleton",
      eventState: "WI",
      mapPublishedAt: null,
    });
  });
});
