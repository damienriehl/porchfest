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
        fixture.seasons.publishSeasonMap(season.id, 7, season.version),
      ).toThrow(`season state ${state} refuses action map_publish`);
      expect(fixture.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
    },
  );

  it("R16 publishes and unpublishes a locked season with version guards", async () => {
    const fixture = await seasonIn("locked");
    const locked = fixture.seasons.getSeason(fixture.seasonId);

    const published = fixture.seasons.publishSeasonMap(
      locked.id,
      7,
      locked.version,
    );
    expect(published.mapPublishedAt).toEqual(
      new Date("2034-08-29T20:00:00.000Z"),
    );
    expect(published.version).toBe(locked.version + 1);
    expect(() =>
      fixture.seasons.unpublishSeasonMap(published.id, 7, locked.version),
    ).toThrow(/someone else changed|conflict/i);

    const unpublished = fixture.seasons.unpublishSeasonMap(
      published.id,
      7,
      published.version,
    );
    expect(unpublished.mapPublishedAt).toBeNull();
    expect(unpublished.version).toBe(published.version + 1);
  });

  it("R16/R28 clears publication when a season is archived", async () => {
    const fixture = await seasonIn("locked");
    const locked = fixture.seasons.getSeason(fixture.seasonId);
    const published = fixture.seasons.publishSeasonMap(
      locked.id,
      null,
      locked.version,
    );

    const archived = fixture.seasons.transitionSeason(
      published.id,
      published.version,
      "archived",
    );

    expect(archived.state).toBe("archived");
    expect(archived.mapPublishedAt).toBeNull();
  });
});
