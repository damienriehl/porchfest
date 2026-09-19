import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createGeocodingRepository,
  invalidateCoordinateForAddressChange,
  GeocodingConflictError,
  type ImportedGeocodedCoordinateInput,
} from "../src/geocoding.js";
import { createSeasonSetup } from "../src/setup.js";
import { seasons, venues, venueCoordinates } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const point: ImportedGeocodedCoordinateInput = {
  latitude: 10.5,
  longitude: 20.5,
  provider: " offline-provider ",
  ref: " parcel/1 ",
  crossCheckDistanceM: null,
  precision: "parcel",
  interpolated: false,
};
describe("geocoding offline provenance and mutation boundaries", () => {
  let database: TestDatabase;
  let seasonId: number;
  let venue: typeof venues.$inferSelect;
  const stamp = new Date("2034-01-01T00:00:00Z");
  let repo: ReturnType<typeof createGeocodingRepository>;
  beforeEach(async () => {
    database = await openTestDatabase("geocoding-import-");
    seasonId = createSeasonSetup(database.db, () => stamp).createSeason({
      year: 2034,
      displayName: "Import season",
      timezone: "UTC",
      eventDate: "2034-09-01",
      eventCity: "Example",
      eventState: "WI",
      timeSlots: [],
      openSignups: true,
      bounds: { north: 11, south: 10, east: 21, west: 20 },
    }).season.id;
    venue = database.db
      .insert(venues)
      .values({
        seasonId,
        title: "Offline porch",
        address: " 101  Example\nRoad ",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    repo = createGeocodingRepository(
      database.db,
      {
        geo: {
          name: "unused",
          configured: false,
          locate: async () => {
            throw new Error("offline only");
          },
          geocode: async () => null,
        },
      },
      { now: () => stamp },
    );
  });
  afterEach(async () => {
    await database.close();
  });
  const saved = () =>
    database.db
      .select()
      .from(venueCoordinates)
      .where(eq(venueCoordinates.venueId, venue.id))
      .get();
  it("imports, reviews, manually verifies and publishes through the real SQLite chain", () => {
    const imported = repo.importGeocodedCoordinate(venue.id, {
      ...point,
      precision: "street",
    });
    expect(imported.coordinate).toMatchObject({
      provider: "offline-provider",
      ref: "parcel/1",
      addressAtGeocode: "101 Example Road",
      status: "needs-review",
    });
    expect(repo.publishableCoordinate(venue.id)).toBeNull();
    expect(repo.listVenuesNeedingCoordinateReview(seasonId)).toHaveLength(1);
    const verified = repo.verifyVenueCoordinate(
      venue.id,
      { latitude: 10.6, longitude: 20.6 },
      null,
      venue.version,
    );
    expect(verified).toMatchObject({
      version: 2,
      source: "organizer-verified",
      ref: "organizer/manual",
      rejectionCode: null,
    });
    expect(repo.listVenuesNeedingCoordinateReview(seasonId)).toEqual([]);
    expect(
      repo.publishableCoordinatesForSeason(seasonId).get(venue.id),
    ).toEqual({ latitude: 10.6, longitude: 20.6 });
    expect(repo.importGeocodedCoordinate(venue.id, point)).toEqual({
      kind: "preserved",
      coordinate: verified,
    });
  });
  it("reimporting identical rejected evidence is idempotent and changed evidence increments the coordinate version", () => {
    const input = { ...point, precision: "street" as const };
    const first = repo.importGeocodedCoordinate(venue.id, input);
    expect(repo.importGeocodedCoordinate(venue.id, input)).toEqual(first);
    const updated = repo.importGeocodedCoordinate(venue.id, {
      ...input,
      ref: "parcel/2",
    });
    expect(updated.coordinate).toMatchObject({
      id: first.coordinate.id,
      version: 2,
      ref: "parcel/2",
      status: "needs-review",
    });
  });
  it("stores malformed numeric evidence without publishing a point", () => {
    const result = repo.importGeocodedCoordinate(venue.id, {
      ...point,
      latitude: NaN,
      ref: " ",
    });
    expect(result.coordinate).toMatchObject({
      latitude: null,
      longitude: null,
      ref: null,
      status: "needs-review",
      rejectionCode: "invalid-coordinate",
    });
    expect(repo.publishableCoordinate(venue.id)).toBeNull();
  });
  it.each([Infinity, -Infinity, 31])(
    "rejects imported cross-check distance %s",
    (distance) => {
      expect(
        repo.importGeocodedCoordinate(venue.id, {
          ...point,
          crossCheckDistanceM: distance,
        }).coordinate,
      ).toMatchObject({
        status: "needs-review",
        rejectionCode: "cross-check-distance",
      });
    },
  );
  it("retains a forced rejection even when the imported point passes structural verification", () => {
    expect(
      repo.importGeocodedCoordinate(venue.id, {
        ...point,
        forcedRejectionCode: "address-changed",
      }).coordinate,
    ).toMatchObject({
      status: "needs-review",
      rejectionCode: "address-changed",
      latitude: 10.5,
    });
  });
  it("refuses blank source labels without creating provenance", () => {
    expect(() =>
      repo.importGeocodedCoordinate(venue.id, { ...point, provider: " \n " }),
    ).toThrow("provider/source label");
    expect(saved()).toBeUndefined();
  });
  it("missing venue rejects all coordinate writes and yields empty read models", async () => {
    await expect(repo.geocodeVenue(999, null)).rejects.toThrow(
      "does not exist",
    );
    expect(() => repo.importGeocodedCoordinate(999, point)).toThrow(
      "does not exist",
    );
    expect(() => repo.verifyVenueCoordinate(999, point, null, 1)).toThrow(
      "does not exist",
    );
    expect(repo.publishableCoordinate(999)).toBeNull();
    expect(repo.publishableCoordinatesForSeason(999).size).toBe(0);
    expect(repo.listVenuesNeedingCoordinateReview(999)).toEqual([]);
    expect(invalidateCoordinateForAddressChange(database.db, 999, stamp)).toBe(
      false,
    );
  });
  it("addressless venues fail imports and bypass live lookup", async () => {
    database.db
      .update(venues)
      .set({ address: " \t " })
      .where(eq(venues.id, venue.id))
      .run();
    expect(() => repo.importGeocodedCoordinate(venue.id, point)).toThrow(
      "no address",
    );
    expect(await repo.geocodeVenue(venue.id, null)).toMatchObject({
      kind: "unavailable",
      reason: "The venue has no address to geocode.",
    });
    expect(saved()).toBeUndefined();
  });
  it.each(["boundsNorth", "boundsSouth", "boundsEast", "boundsWest"] as const)(
    "incomplete %s rejects import and verification without mutation",
    async (field) => {
      database.db
        .update(seasons)
        .set({ [field]: null })
        .where(eq(seasons.id, seasonId))
        .run();
      expect(() => repo.importGeocodedCoordinate(venue.id, point)).toThrow(
        "no complete geocoding bounding box",
      );
      expect(() =>
        repo.verifyVenueCoordinate(venue.id, point, null, venue.version),
      ).toThrow("no complete geocoding bounding box");
      expect(await repo.geocodeVenue(venue.id, null)).toMatchObject({
        kind: "unavailable",
      });
      expect(saved()).toBeUndefined();
    },
  );
  it("stale manual verification preserves both the existing coordinate and venue version", () => {
    const first = repo.importGeocodedCoordinate(venue.id, point).coordinate;
    expect(() =>
      repo.verifyVenueCoordinate(
        venue.id,
        { latitude: 10.7, longitude: 20.7 },
        null,
        venue.version + 1,
      ),
    ).toThrow(GeocodingConflictError);
    expect(saved()).toEqual(first);
    expect(
      database.db.select().from(venues).where(eq(venues.id, venue.id)).get(),
    ).toEqual(venue);
  });
  it("rolls back the venue version claim if coordinate persistence fails", () => {
    database.sqlite.exec(
      "CREATE TRIGGER fail_coordinate BEFORE INSERT ON venue_coordinates BEGIN SELECT RAISE(ABORT, 'coordinate write failed'); END",
    );
    expect(() =>
      repo.verifyVenueCoordinate(venue.id, point, null, venue.version),
    ).toThrow("coordinate write failed");
    expect(
      database.db.select().from(venues).where(eq(venues.id, venue.id)).get(),
    ).toEqual(venue);
    expect(saved()).toBeUndefined();
    database.sqlite.exec("DROP TRIGGER fail_coordinate");
    expect(
      repo.verifyVenueCoordinate(venue.id, point, null, venue.version).status,
    ).toBe("verified");
  });
  it("repeated address invalidation does not increment versions and organizer review stays required", () => {
    repo.verifyVenueCoordinate(venue.id, point, null, venue.version);
    expect(
      invalidateCoordinateForAddressChange(database.db, venue.id, stamp),
    ).toBe(false);
    database.db
      .update(venues)
      .set({ address: "202 Example Road" })
      .where(eq(venues.id, venue.id))
      .run();
    expect(
      invalidateCoordinateForAddressChange(database.db, venue.id, stamp),
    ).toBe(true);
    const first = saved();
    expect(
      invalidateCoordinateForAddressChange(
        database.db,
        venue.id,
        new Date(stamp.valueOf() + 1000),
      ),
    ).toBe(false);
    expect(saved()).toEqual(first);
    expect(first).toMatchObject({
      source: "organizer-verified",
      status: "needs-review",
      rejectionCode: "address-changed",
    });
    expect(repo.publishableCoordinate(venue.id)).toBeNull();
  });
});
