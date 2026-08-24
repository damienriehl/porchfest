import { describe, expect, it } from "vitest";
import {
  boundingBoxContains,
  haversineDistanceMeters,
  isValidCoordinate,
  resolveCoordinatePrecedence,
  verifyGeocodedCoordinate,
  verifyOrganizerCoordinate,
  type BoundingBox,
  type CoordinateVerdict,
  type GeocodeCandidate,
  type VerifiedCoordinate,
} from "../src/index.js";

// A neighborhood-sized box, roughly the St. Anthony Park slice of St. Paul.
const NEIGHBORHOOD: BoundingBox = {
  south: 44.9,
  north: 45.0,
  west: -93.2,
  east: -93.05,
};

const INSIDE = { latitude: 44.95, longitude: -93.1 };

function parcelCandidate(
  overrides: Partial<GeocodeCandidate> = {},
): GeocodeCandidate {
  return {
    latitude: INSIDE.latitude,
    longitude: INSIDE.longitude,
    precision: "parcel",
    interpolated: false,
    ref: "ramsey-address-points:123456",
    ...overrides,
  };
}

function expectAccepted(verdict: CoordinateVerdict): VerifiedCoordinate {
  if (verdict.status !== "accepted") {
    throw new Error(
      `expected an accepted verdict, got: ${JSON.stringify(verdict)}`,
    );
  }
  return verdict.coordinate;
}

function expectRejected(verdict: CoordinateVerdict) {
  if (verdict.status !== "rejected") {
    throw new Error(
      `expected a rejected verdict, got: ${JSON.stringify(verdict)}`,
    );
  }
  return verdict;
}

describe("verifyGeocodedCoordinate: accepted results", () => {
  it("accepts a parcel-level address point inside the neighborhood", () => {
    const coordinate = expectAccepted(
      verifyGeocodedCoordinate(parcelCandidate(), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(coordinate).toEqual({
      latitude: 44.95,
      longitude: -93.1,
      source: "geocoded",
      ref: "ramsey-address-points:123456",
      precision: "parcel",
      crossCheckDistanceMeters: null,
    });
  });

  it("accepts a house-level fallback and carries its cross-check distance", () => {
    const coordinate = expectAccepted(
      verifyGeocodedCoordinate(
        parcelCandidate({ precision: "house", latitude: 44.95 }),
        {
          boundingBox: NEIGHBORHOOD,
          crossCheck: { latitude: 44.9501, longitude: -93.1 },
        },
      ),
    );

    expect(coordinate.precision).toBe("house");
    expect(coordinate.source).toBe("geocoded");
    expect(coordinate.crossCheckDistanceMeters).toBeGreaterThan(11);
    expect(coordinate.crossCheckDistanceMeters).toBeLessThan(11.2);
  });

  it("carries a zero cross-check distance when the reference is the same point", () => {
    const coordinate = expectAccepted(
      verifyGeocodedCoordinate(parcelCandidate({ precision: "house" }), {
        boundingBox: NEIGHBORHOOD,
        crossCheck: { ...INSIDE },
      }),
    );

    expect(coordinate.crossCheckDistanceMeters).toBe(0);
  });

  it("carries a cross-check distance for a parcel-level result too", () => {
    const coordinate = expectAccepted(
      verifyGeocodedCoordinate(parcelCandidate(), {
        boundingBox: NEIGHBORHOOD,
        crossCheck: { latitude: 44.9501, longitude: -93.1 },
      }),
    );

    expect(coordinate.crossCheckDistanceMeters).toBeGreaterThan(11);
  });
});

describe("verifyGeocodedCoordinate: precision gate", () => {
  it("rejects a street-level result outright", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ precision: "street" }), {
        boundingBox: NEIGHBORHOOD,
        crossCheck: { ...INSIDE },
      }),
    );

    expect(verdict.code).toBe("imprecise");
    expect(verdict.reason).toMatch(/street/i);
  });

  it("stores nothing for a street-level result", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ precision: "street" }), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(Object.hasOwn(verdict, "coordinate")).toBe(false);
  });
});

describe("verifyGeocodedCoordinate: interpolation gate", () => {
  it("refuses an interpolated result even when precise and in bounds", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ interpolated: true }), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(verdict.code).toBe("interpolated");
  });

  it("refuses an interpolated house-level result that has a cross-check", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(
        parcelCandidate({ interpolated: true, precision: "house" }),
        { boundingBox: NEIGHBORHOOD, crossCheck: { ...INSIDE } },
      ),
    );

    expect(verdict.failures.map((failure) => failure.code)).toContain(
      "interpolated",
    );
  });
});

describe("verifyGeocodedCoordinate: bounding-box gate (R17)", () => {
  it("reports a result outside the bounding box rather than storing it", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(
        parcelCandidate({ latitude: 44.8, longitude: -93.1 }),
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    expect(verdict.code).toBe("out-of-bounds");
    expect(verdict.reason).toMatch(/bounding box/i);
    expect(Object.hasOwn(verdict, "coordinate")).toBe(false);
  });

  it("reports out-of-bounds independently of the precision gate", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(
        parcelCandidate({ precision: "street", longitude: -93.4 }),
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    const codes = verdict.failures.map((failure) => failure.code);
    expect(codes).toContain("imprecise");
    expect(codes).toContain("out-of-bounds");
  });

  it("accepts a point sitting exactly on each edge of the box", () => {
    const edges = [
      { latitude: NEIGHBORHOOD.south, longitude: -93.1 },
      { latitude: NEIGHBORHOOD.north, longitude: -93.1 },
      { latitude: 44.95, longitude: NEIGHBORHOOD.west },
      { latitude: 44.95, longitude: NEIGHBORHOOD.east },
      {
        latitude: NEIGHBORHOOD.south,
        longitude: NEIGHBORHOOD.west,
      },
    ];

    for (const edge of edges) {
      expect(
        verifyGeocodedCoordinate(parcelCandidate(edge), {
          boundingBox: NEIGHBORHOOD,
        }).status,
      ).toBe("accepted");
    }
  });

  it("rejects a point a hair outside an edge", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(
        parcelCandidate({ latitude: NEIGHBORHOOD.north + 1e-9 }),
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    expect(verdict.code).toBe("out-of-bounds");
  });

  it("refuses a zero-area bounding box, as createSeasonSetup does", () => {
    // core rejects north <= south and east <= west when a season's bounds are
    // set. A box that admits only a single line of points is a misconfiguration
    // either way, and the two validators must not disagree about it.
    expect(() =>
      boundingBoxContains(
        { ...NEIGHBORHOOD, north: NEIGHBORHOOD.south },
        INSIDE,
      ),
    ).toThrow(RangeError);
    expect(() =>
      boundingBoxContains({ ...NEIGHBORHOOD, east: NEIGHBORHOOD.west }, INSIDE),
    ).toThrow(RangeError);
  });

  it("refuses a misconfigured bounding box", () => {
    expect(() =>
      verifyGeocodedCoordinate(parcelCandidate(), {
        boundingBox: { ...NEIGHBORHOOD, south: 45.5 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      boundingBoxContains({ ...NEIGHBORHOOD, east: Number.NaN }, INSIDE),
    ).toThrow(RangeError);
    expect(() =>
      boundingBoxContains({ ...NEIGHBORHOOD, south: -91 }, INSIDE),
    ).toThrow(RangeError);
  });
});

describe("verifyGeocodedCoordinate: cross-check gate (KTD11)", () => {
  it("refuses a house-level fallback with no cross-check reference", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ precision: "house" }), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(verdict.code).toBe("cross-check-missing");
  });

  it("refuses a cross-check reference that is not a real point", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ precision: "house" }), {
        boundingBox: NEIGHBORHOOD,
        crossCheck: { latitude: Number.NaN, longitude: -93.1 },
      }),
    );

    expect(verdict.code).toBe("invalid-coordinate");
    expect(verdict.reason).toMatch(/cross-check/i);
  });
});

describe("verifyGeocodedCoordinate: structural gates", () => {
  it.each([
    ["a NaN latitude", { latitude: Number.NaN }],
    ["an infinite longitude", { longitude: Number.POSITIVE_INFINITY }],
    ["a latitude past the pole", { latitude: 91 }],
    ["a longitude past the antimeridian", { longitude: -181 }],
  ])("rejects %s", (_label, overrides) => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate(overrides), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(verdict.code).toBe("invalid-coordinate");
    expect(verdict.failures).toHaveLength(1);
  });

  it("rejects a candidate with no provenance reference", () => {
    const verdict = expectRejected(
      verifyGeocodedCoordinate(parcelCandidate({ ref: "  " }), {
        boundingBox: NEIGHBORHOOD,
      }),
    );

    expect(verdict.code).toBe("missing-ref");
  });
});

describe("verifyOrganizerCoordinate", () => {
  it("accepts an organizer-placed point with organizer-verified provenance", () => {
    const coordinate = expectAccepted(
      verifyOrganizerCoordinate(
        { ...INSIDE, ref: "organizer-edit:record-42" },
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    expect(coordinate).toEqual({
      latitude: 44.95,
      longitude: -93.1,
      source: "organizer-verified",
      ref: "organizer-edit:record-42",
      precision: null,
      crossCheckDistanceMeters: null,
    });
  });

  it("still applies the bounding-box sanity check to an organizer point", () => {
    const verdict = expectRejected(
      verifyOrganizerCoordinate(
        { latitude: 44.95, longitude: -93.4, ref: "organizer-edit:record-42" },
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    expect(verdict.code).toBe("out-of-bounds");
  });

  it("rejects an organizer point that is not a real coordinate", () => {
    const verdict = expectRejected(
      verifyOrganizerCoordinate(
        {
          latitude: 44.95,
          longitude: Number.NaN,
          ref: "organizer-edit:record-42",
        },
        { boundingBox: NEIGHBORHOOD },
      ),
    );

    expect(verdict.code).toBe("invalid-coordinate");
  });
});

describe("resolveCoordinatePrecedence (R29)", () => {
  const geocoded: VerifiedCoordinate = {
    latitude: 44.95,
    longitude: -93.1,
    source: "geocoded",
    ref: "ramsey-address-points:123456",
    precision: "parcel",
    crossCheckDistanceMeters: null,
  };
  const organizerVerified: VerifiedCoordinate = {
    latitude: 44.9512,
    longitude: -93.1034,
    source: "organizer-verified",
    ref: "organizer-edit:record-42",
    precision: null,
    crossCheckDistanceMeters: null,
  };

  it("keeps an organizer-verified coordinate against a geocoded challenger", () => {
    const decision = resolveCoordinatePrecedence(organizerVerified, geocoded);

    expect(decision.outcome).toBe("keep-existing");
    expect(decision.coordinate).toEqual(organizerVerified);
  });

  it("replaces a geocoded coordinate on regeneration", () => {
    const decision = resolveCoordinatePrecedence(geocoded, {
      ...geocoded,
      latitude: 44.9599,
    });

    expect(decision.outcome).toBe("adopt");
    expect(decision.coordinate.latitude).toBe(44.9599);
  });

  it("lets an organizer correction replace a geocoded coordinate", () => {
    const decision = resolveCoordinatePrecedence(geocoded, organizerVerified);

    expect(decision.outcome).toBe("adopt");
    expect(decision.coordinate).toEqual(organizerVerified);
  });

  it("lets a later organizer correction replace an earlier one", () => {
    const later = { ...organizerVerified, latitude: 44.9613 };
    const decision = resolveCoordinatePrecedence(organizerVerified, later);

    expect(decision.outcome).toBe("adopt");
    expect(decision.coordinate).toEqual(later);
  });

  it("adopts the incoming coordinate when nothing is stored yet", () => {
    const decision = resolveCoordinatePrecedence(null, geocoded);

    expect(decision.outcome).toBe("adopt");
    expect(decision.coordinate).toEqual(geocoded);
  });
});

describe("haversineDistanceMeters", () => {
  it("measures a degree of latitude as about 111 km", () => {
    const meters = haversineDistanceMeters(
      { latitude: 44.5, longitude: -93.1 },
      { latitude: 45.5, longitude: -93.1 },
    );

    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it("measures across the antimeridian as a short hop, not a lap", () => {
    const meters = haversineDistanceMeters(
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    );

    expect(meters).toBeGreaterThan(22_000);
    expect(meters).toBeLessThan(22_500);
  });

  it("measures pole to equator as a quarter of the meridian", () => {
    const meters = haversineDistanceMeters(
      { latitude: 90, longitude: 0 },
      { latitude: 0, longitude: 137 },
    );

    expect(meters).toBeGreaterThan(10_000_000);
    expect(meters).toBeLessThan(10_010_000);
  });

  it("measures the distance from a point to itself as zero", () => {
    expect(haversineDistanceMeters(INSIDE, { ...INSIDE })).toBe(0);
  });

  it("is symmetric", () => {
    const a = { latitude: 44.95, longitude: -93.1 };
    const b = { latitude: 44.96, longitude: -93.12 };

    expect(haversineDistanceMeters(a, b)).toBeCloseTo(
      haversineDistanceMeters(b, a),
      9,
    );
  });

  it("refuses a point that is not on Earth", () => {
    expect(() =>
      haversineDistanceMeters({ latitude: Number.NaN, longitude: 0 }, INSIDE),
    ).toThrow(RangeError);
    expect(() =>
      haversineDistanceMeters(INSIDE, { latitude: 0, longitude: 181 }),
    ).toThrow(RangeError);
  });
});

describe("isValidCoordinate", () => {
  it("accepts the poles and the antimeridian", () => {
    expect(isValidCoordinate({ latitude: 90, longitude: 180 })).toBe(true);
    expect(isValidCoordinate({ latitude: -90, longitude: -180 })).toBe(true);
  });

  it("refuses non-finite and out-of-range values", () => {
    expect(isValidCoordinate({ latitude: 90.0001, longitude: 0 })).toBe(false);
    expect(
      isValidCoordinate({ latitude: 0, longitude: Number.NEGATIVE_INFINITY }),
    ).toBe(false);
  });
});
