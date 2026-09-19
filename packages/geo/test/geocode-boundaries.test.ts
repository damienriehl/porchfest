import { describe, expect, it } from "vitest";
import {
  InMemoryGeocodeCache,
  OpenStreetMapGeoAdapter,
  verifyGeocodedCoordinate,
} from "../src/index.js";

const boundingBox = { south: 10, north: 11, west: 20, east: 21 };
const request = { address: "101 Nebula Ave" };
const parcel = {
  type: "node",
  id: 12,
  lat: 10.25,
  lon: 20.25,
  tags: { "addr:housenumber": "101", "addr:street": "Nebula Avenue" },
};

function adapterFor(elements: unknown[]) {
  return new OpenStreetMapGeoAdapter({
    boundingBox,
    fetcher: async (url) =>
      Response.json(String(url).includes("overpass") ? { elements } : []),
  });
}

describe("geocoder provider parsing and verification integration", () => {
  it.each(
    [
      null,
      [],
      { ...parcel, type: "relation" },
      { ...parcel, id: 1.5 },
      { ...parcel, tags: null },
      {
        ...parcel,
        tags: { "addr:housenumber": 101, "addr:street": "Nebula Avenue" },
      },
      { ...parcel, type: "way", center: null },
      { ...parcel, lat: "nonsense" },
      { ...parcel, lon: null },
      {
        ...parcel,
        tags: { ...parcel.tags, "addr:street": "Different Avenue" },
      },
    ].map((malformed) => ({ malformed })),
  )(
    "ignores unusable Overpass element $malformed without poisoning a valid parcel",
    async ({ malformed }) => {
      const adapter = adapterFor([malformed, parcel]);
      const outcome = await adapter.locate(request);
      expect(outcome.kind).toBe("located");
      if (outcome.kind !== "located") throw new Error("Expected parcel");
      expect(outcome.candidate.ref).toBe("node/12");
      expect(
        verifyGeocodedCoordinate(outcome.candidate, {
          boundingBox,
          crossCheck: outcome.crossCheck,
        }),
      ).toMatchObject({
        status: "accepted",
        coordinate: { precision: "parcel", source: "geocoded" },
      });
    },
  );
  it("accepts addr:place and numeric provider coordinate strings through the verification gate", async () => {
    const adapter = adapterFor([
      {
        ...parcel,
        lat: "10.2500001",
        lon: "20.2500001",
        tags: { "addr:housenumber": " 101 ", "addr:place": "Nebula Avenue" },
      },
    ]);
    const result = await adapter.locate(request);
    expect(result).toMatchObject({
      kind: "located",
      candidate: { latitude: 10.25, longitude: 20.25 },
    });
    if (result.kind !== "located") throw new Error("Expected parcel");
    expect(
      verifyGeocodedCoordinate(result.candidate, { boundingBox }).status,
    ).toBe("accepted");
  });
  it("keeps an out-of-bounds Overpass parcel from publication through the real verification gate", async () => {
    const result = await adapterFor([{ ...parcel, lat: 12 }]).locate(request);
    expect(result.kind).toBe("located");
    if (result.kind !== "located") throw new Error("Expected candidate");
    expect(
      verifyGeocodedCoordinate(result.candidate, { boundingBox }),
    ).toMatchObject({ status: "rejected", code: "out-of-bounds" });
  });
  it("returns unavailable without provider access when neither call nor adapter supplies bounds", async () => {
    const adapter = new OpenStreetMapGeoAdapter({
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(await adapter.locate(request)).toEqual({
      kind: "unavailable",
      reason: "No season bounding box was supplied for geocoding.",
    });
    expect(await adapter.geocode(request)).toBeNull();
  });
  it("shares cached parse refusals across adapter instances without provider requests", async () => {
    const cache = new InMemoryGeocodeCache();
    const options = {
      boundingBox,
      cache,
      fetcher: async () => {
        throw new Error("must not fetch");
      },
    };
    const first = new OpenStreetMapGeoAdapter(options);
    const second = new OpenStreetMapGeoAdapter(options);
    const result = await first.locate({ address: "101" });
    expect(result).toMatchObject({
      kind: "refused",
      reason: expect.stringContaining("no street"),
    });
    expect(await second.locate({ address: "101" })).toEqual(result);
  });
  it.each(["userAgent", "countryCodes"] as const)(
    "rejects blank %s configuration",
    (field) => {
      expect(() => new OpenStreetMapGeoAdapter({ [field]: " \n" })).toThrow(
        TypeError,
      );
    },
  );
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid provider timeout %s",
    (value) => {
      expect(
        () => new OpenStreetMapGeoAdapter({ overpassTimeoutMs: value }),
      ).toThrow(RangeError);
      expect(
        () => new OpenStreetMapGeoAdapter({ nominatimTimeoutMs: value }),
      ).toThrow(RangeError);
    },
  );
});
