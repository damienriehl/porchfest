import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundingBox,
  GeoPort,
  LocateOutcome,
  LocateRequest,
} from "../src/ports/geo.js";
import { createGeocodingRepository } from "../src/geocoding.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import { organizers, venueCoordinates } from "../src/storage/schema.js";
import { eq } from "drizzle-orm";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const BOX = { north: 11, south: 10, east: 21, west: 20 } as const;
const NOW = new Date("2034-05-01T12:00:00.000Z");
const ADDRESS = "101 Nebula Avenue";

function located(
  overrides: Partial<
    Extract<LocateOutcome, { kind: "located" }>["candidate"]
  > = {},
  crossCheck: { latitude: number; longitude: number } | null = {
    latitude: 10.5001,
    longitude: 20.5,
  },
): LocateOutcome {
  return {
    kind: "located",
    candidate: {
      latitude: 10.5,
      longitude: 20.5,
      precision: "parcel",
      interpolated: false,
      ref: "way/101",
      ...overrides,
    },
    crossCheck,
    reason: "Synthetic provider match.",
  };
}

class FakeGeoPort implements GeoPort {
  readonly name = "fake-geo";
  readonly configured = true;
  readonly locate = vi.fn<(request: LocateRequest) => Promise<LocateOutcome>>();

  constructor(outcome: LocateOutcome = located()) {
    this.locate.mockResolvedValue(outcome);
  }

  async geocode(request: LocateRequest) {
    const outcome = await this.locate(request);
    return outcome.kind === "located" ? outcome.candidate : null;
  }
}

describe("core venue geocoding (U9 / KTD11)", () => {
  let database: TestDatabase;
  let fake: FakeGeoPort;
  let seasons: ReturnType<typeof createSeasonRepository>;
  let actor: number;

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-geocoding-");
    fake = new FakeGeoPort();
    seasons = createSeasonRepository(database.db, { now: () => NOW });
    actor = database.db
      .insert(organizers)
      .values({
        email: "coordinate-reviewer@example.invalid",
        displayName: "Coordinate Reviewer",
        createdAt: NOW,
        updatedAt: NOW,
      })
      .returning({ id: organizers.id })
      .get().id;
  });

  afterEach(async () => {
    await database.close();
  });

  function fixture(
    year = 2034,
    box: BoundingBox = BOX,
    localityName: string | null = "Example Borough",
  ) {
    const setup = createSeasonSetup(database.db, () => NOW);
    const { season } = setup.createSeason({
      year,
      displayName: `Synthetic ${year}`,
      timezone: "UTC",
      eventDate: `${year}-09-10`,
      timeSlots: [],
      localityName,
      bounds: box,
      openSignups: true,
    });
    const signup = seasons.createHostSignup({
      seasonId: season.id,
      contact: {
        name: "Synthetic Host",
        email: `host-${year}@example.invalid`,
      },
      venue: {
        title: `Synthetic Porch ${year}`,
        address: ADDRESS,
        spaceDescription: "A synthetic porch",
        hasPower: true,
        rainBackup: false,
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    });
    return { season, venue: signup.venue };
  }

  function geocoding() {
    return createGeocodingRepository(
      database.db,
      { geo: fake },
      { now: () => NOW },
    );
  }

  function stored(venueId: number) {
    return database.db
      .select()
      .from(venueCoordinates)
      .where(eq(venueCoordinates.venueId, venueId))
      .get();
  }

  it("R29/AE10: regeneration preserves organizer-verified and overwrites geocoded coordinates", async () => {
    const first = fixture();
    await geocoding().geocodeVenue(first.venue.id, actor);
    geocoding().verifyVenueCoordinate(
      first.venue.id,
      { latitude: 10.6, longitude: 20.6 },
      actor,
      first.venue.version,
    );
    fake.locate.mockClear();

    const preserved = await geocoding().geocodeVenue(first.venue.id, actor);
    expect(preserved.kind).toBe("preserved");
    expect(fake.locate).not.toHaveBeenCalled();
    expect(stored(first.venue.id)).toMatchObject({
      source: "organizer-verified",
      latitude: 10.6,
      longitude: 20.6,
    });
    seasons.updateVenue(first.venue.id, first.venue.version + 1, {
      address: "105 Nebula Avenue",
    });
    expect(stored(first.venue.id)).toMatchObject({
      source: "organizer-verified",
      status: "needs-review",
      rejectionCode: "address-changed",
    });

    const second = fixture(2035);
    fake.locate.mockResolvedValue(located({ latitude: 10.4, ref: "way/1" }));
    await geocoding().geocodeVenue(second.venue.id, actor);
    seasons.updateVenue(second.venue.id, second.venue.version, {
      address: "102 Nebula Avenue",
    });
    fake.locate.mockResolvedValue(located({ latitude: 10.7, ref: "way/2" }));
    await geocoding().geocodeVenue(second.venue.id, actor);
    expect(stored(second.venue.id)).toMatchObject({
      source: "geocoded",
      provider: "fake-geo",
      latitude: 10.7,
      ref: "way/2",
      addressAtGeocode: "102 Nebula Avenue",
    });
  });

  it("R29/AE10: an address edit marks a geocoded coordinate for re-verification and unpublishes it", async () => {
    const { venue } = fixture();
    await geocoding().geocodeVenue(venue.id, actor);
    expect(geocoding().publishableCoordinate(venue.id)).toEqual({
      latitude: 10.5,
      longitude: 20.5,
    });

    seasons.updateVenue(venue.id, venue.version, {
      address: "103 Nebula Avenue",
    });

    expect(stored(venue.id)).toMatchObject({
      status: "needs-review",
      rejectionCode: "address-changed",
    });
    expect(geocoding().publishableCoordinate(venue.id)).toBeNull();
  });

  it("R17: an out-of-bounds result is stored for review and never published", async () => {
    const { season, venue } = fixture();
    fake.locate.mockResolvedValue(located({ latitude: 12 }));

    await geocoding().geocodeVenue(venue.id, actor);

    expect(stored(venue.id)).toMatchObject({
      status: "needs-review",
      rejectionCode: "out-of-bounds",
    });
    expect(geocoding().publishableCoordinate(venue.id)).toBeNull();
    expect(
      geocoding().listVenuesNeedingCoordinateReview(season.id),
    ).toHaveLength(1);
  });

  it.each([
    [
      "house-only (no cross-check) -> needs-review cross-check-missing",
      located({ precision: "house" }, null),
      "cross-check-missing",
    ],
    [
      "parcel with cross-check > 30 m -> needs-review cross-check-distance",
      located({}, { latitude: 10.501, longitude: 20.5 }),
      "cross-check-distance",
    ],
    [
      "parcel with cross-check <= 30 m -> verified",
      located({}, { latitude: 10.5001, longitude: 20.5 }),
      null,
    ],
  ] as const)("%s", async (_label, outcome, rejectionCode) => {
    const { venue } = fixture();
    fake.locate.mockResolvedValue(outcome);

    await geocoding().geocodeVenue(venue.id, actor);

    expect(stored(venue.id)).toMatchObject({
      status: rejectionCode === null ? "verified" : "needs-review",
      rejectionCode,
    });
  });

  it("interpolated candidate -> needs-review, never verified", async () => {
    const { venue } = fixture();
    fake.locate.mockResolvedValue(located({ interpolated: true }));
    await geocoding().geocodeVenue(venue.id, actor);
    expect(stored(venue.id)).toMatchObject({
      status: "needs-review",
      rejectionCode: "interpolated",
    });
    expect(geocoding().publishableCoordinate(venue.id)).toBeNull();
  });

  it("an invalid numeric candidate is retained as reviewable provenance", async () => {
    const { venue } = fixture();
    fake.locate.mockResolvedValue(located({ latitude: Number.NaN }));

    await geocoding().geocodeVenue(venue.id, actor);

    expect(stored(venue.id)).toMatchObject({
      latitude: null,
      longitude: null,
      status: "needs-review",
      rejectionCode: "invalid-coordinate",
      ref: "way/101",
    });
  });

  it("unavailable stores nothing and does not clear an existing coordinate", async () => {
    const { venue } = fixture();
    await geocoding().geocodeVenue(venue.id, actor);
    const before = stored(venue.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "104 Nebula Avenue",
    });
    fake.locate.mockResolvedValue({
      kind: "unavailable",
      reason: "Synthetic provider outage.",
    });

    const result = await geocoding().geocodeVenue(venue.id, actor);

    expect(result).toEqual({
      kind: "unavailable",
      reason: "Synthetic provider outage.",
    });
    expect(stored(venue.id)).toMatchObject({
      id: before?.id,
      latitude: before?.latitude,
      status: "needs-review",
      rejectionCode: "address-changed",
    });
  });

  it("a rejected provider call degrades to unavailable without changing provenance", async () => {
    const { venue } = fixture();
    fake.locate.mockRejectedValue(new Error("synthetic provider failure"));

    await expect(geocoding().geocodeVenue(venue.id, actor)).resolves.toEqual({
      kind: "unavailable",
      reason: "fake-geo failed before returning a geocoding outcome.",
    });
    expect(stored(venue.id)).toBeUndefined();
  });

  it.each([
    [
      "not-found is retained as a pending provenance attempt",
      { kind: "not-found", reason: "Synthetic address miss." },
      "pending",
      "not-found",
    ],
    [
      "refused is retained as rejected provenance",
      { kind: "refused", reason: "Synthetic street-only match." },
      "rejected",
      "refused",
    ],
  ] as const)("%s", async (_label, outcome, status, rejectionCode) => {
    const { venue } = fixture();
    fake.locate.mockResolvedValue(outcome);

    await geocoding().geocodeVenue(venue.id, actor);

    expect(stored(venue.id)).toMatchObject({
      latitude: null,
      longitude: null,
      source: "geocoded",
      provider: "fake-geo",
      status,
      rejectionCode,
      addressAtGeocode: ADDRESS,
      updatedBy: actor,
    });
    expect(geocoding().publishableCoordinate(venue.id)).toBeNull();
  });

  it("an address edit while locate is pending prevents a stale provider write", async () => {
    const { venue } = fixture();
    let resolveLocate!: (outcome: LocateOutcome) => void;
    fake.locate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLocate = resolve;
        }),
    );

    const pending = geocoding().geocodeVenue(venue.id, actor);
    seasons.updateVenue(venue.id, venue.version, {
      address: "106 Nebula Avenue",
    });
    resolveLocate(located());

    await expect(pending).resolves.toEqual({
      kind: "unavailable",
      reason:
        "The venue changed while geocoding; retry with the current address.",
    });
    expect(stored(venue.id)).toBeUndefined();
  });

  it("organizer verification while locate is pending wins the write race", async () => {
    const { venue } = fixture();
    let resolveLocate!: (outcome: LocateOutcome) => void;
    fake.locate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLocate = resolve;
        }),
    );

    const pending = geocoding().geocodeVenue(venue.id, actor);
    geocoding().verifyVenueCoordinate(
      venue.id,
      { latitude: 10.7, longitude: 20.7 },
      actor,
      venue.version,
    );
    resolveLocate(located({ latitude: 10.4 }));

    await expect(pending).resolves.toMatchObject({ kind: "unavailable" });
    expect(stored(venue.id)).toMatchObject({
      latitude: 10.7,
      longitude: 20.7,
      source: "organizer-verified",
      status: "verified",
    });
  });

  it("a cached address issues no provider call", async () => {
    const { venue } = fixture();
    await geocoding().geocodeVenue(venue.id, actor);
    fake.locate.mockClear();

    const result = await geocoding().geocodeVenue(venue.id, actor);

    expect(result.kind).toBe("cached");
    expect(fake.locate).not.toHaveBeenCalled();
  });

  it("bounds come from each season row for the same address", async () => {
    const first = fixture();
    const second = fixture(2035, {
      north: 31,
      south: 30,
      east: 41,
      west: 40,
    });
    fake.locate.mockResolvedValue(located());

    await geocoding().geocodeVenue(first.venue.id, actor);
    await geocoding().geocodeVenue(second.venue.id, actor);

    expect(stored(first.venue.id)?.status).toBe("verified");
    expect(stored(second.venue.id)).toMatchObject({
      status: "needs-review",
      rejectionCode: "out-of-bounds",
    });
    expect(
      fake.locate.mock.calls.map(([request]) => request.boundingBox),
    ).toEqual([BOX, { north: 31, south: 30, east: 41, west: 40 }]);
  });

  it("a season without a locality leaves the adapter fallback available", async () => {
    const { venue } = fixture(2036, BOX, null);

    await geocoding().geocodeVenue(venue.id, actor);

    expect(fake.locate).toHaveBeenCalledWith({
      address: ADDRESS,
      boundingBox: BOX,
      localityName: undefined,
    });
  });

  it("an organizer pin is box-checked, verified inside, and never overwritten by geocoding", async () => {
    const { venue } = fixture();

    expect(() =>
      geocoding().verifyVenueCoordinate(
        venue.id,
        { latitude: 12, longitude: 20.5 },
        actor,
        venue.version,
      ),
    ).toThrow(/Example Borough bounding box/);

    const verified = geocoding().verifyVenueCoordinate(
      venue.id,
      { latitude: 10.8, longitude: 20.8 },
      actor,
      venue.version,
    );
    expect(verified).toMatchObject({
      source: "organizer-verified",
      status: "verified",
      updatedBy: actor,
    });
    fake.locate.mockClear();
    await geocoding().geocodeVenue(venue.id, actor);
    expect(fake.locate).not.toHaveBeenCalled();
    expect(geocoding().publishableCoordinate(venue.id)).toEqual({
      latitude: 10.8,
      longitude: 20.8,
    });
  });
});
