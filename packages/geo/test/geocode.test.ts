import { describe, expect, it, vi } from "vitest";
import {
  InMemoryGeocodeCache,
  OpenStreetMapGeoAdapter,
  parseAddress,
  queryString,
  streetsMatch,
  verifyGeocodedCoordinate,
  type BoundingBox,
  type OpenStreetMapGeoAdapterOptions,
} from "../src/index.js";
import { geoPortContract } from "./contract.js";

const BOUNDS: BoundingBox = {
  south: 10,
  north: 11,
  west: 20,
  east: 21,
};
const LOCALITY = "Example Borough, ZZ";
const ADDRESS = "101 Nebula Ave";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(
  fetcher: typeof fetch,
  overrides: Partial<OpenStreetMapGeoAdapterOptions> = {},
): OpenStreetMapGeoAdapterOptions {
  return {
    boundingBox: BOUNDS,
    localitySuffix: LOCALITY,
    userAgent: "porchfest-geocoder-tests/1.0 (example.invalid)",
    fetcher,
    ...overrides,
  };
}

function overpassElement(
  type: "node" | "way",
  id: number,
  latitude: number,
  longitude: number,
) {
  return {
    type,
    id,
    ...(type === "node"
      ? { lat: latitude, lon: longitude }
      : { center: { lat: latitude, lon: longitude } }),
    tags: {
      "addr:housenumber": "101",
      "addr:street": "Nebula Avenue",
    },
  };
}

function nominatimHouse(
  latitude: string,
  longitude: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    lat: latitude,
    lon: longitude,
    type: "house",
    osm_type: "node",
    osm_id: 900,
    address: { house_number: "101", road: "Nebula Avenue" },
    ...overrides,
  };
}

function sequencedFetcher(
  overpassBody: unknown,
  ...nominatimBodies: unknown[]
) {
  let nominatimIndex = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("overpass-api.de")) return jsonResponse(overpassBody);
    const body = nominatimBodies[nominatimIndex] ?? [];
    nominatimIndex += 1;
    return jsonResponse(body);
  });
}

describe("OpenStreetMapGeoAdapter", () => {
  it("passes the shared geo port contract", async () => {
    await geoPortContract(
      () =>
        new OpenStreetMapGeoAdapter(
          options(async () => jsonResponse({ elements: [] })),
        ),
    );
  });

  it("prefers a parcel point and carries the Nominatim house as its cross-check", async () => {
    const fetcher = sequencedFetcher(
      { elements: [overpassElement("way", 42, 10.12345649, 20.76543251)] },
      [nominatimHouse("10.1235", "20.7655")],
    );
    const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

    await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
      kind: "located",
      candidate: {
        latitude: 10.123456,
        longitude: 20.765433,
        precision: "parcel",
        interpolated: false,
        ref: "way/42",
      },
      crossCheck: { latitude: 10.1235, longitude: 20.7655 },
    });
    await expect(adapter.geocode({ address: ADDRESS })).resolves.toEqual({
      latitude: 10.123456,
      longitude: 20.765433,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("prefers ways over nodes, then the lowest id within the same kind", async () => {
    const fetcher = sequencedFetcher(
      {
        elements: [
          overpassElement("node", 1, 10.1, 20.1),
          overpassElement("way", 30, 10.3, 20.3),
          overpassElement("way", 12, 10.2, 20.2),
        ],
      },
      [],
    );

    const result = await new OpenStreetMapGeoAdapter(options(fetcher)).locate({
      address: ADDRESS,
    });

    expect(result).toMatchObject({
      kind: "located",
      candidate: { ref: "way/12", latitude: 10.2, longitude: 20.2 },
      crossCheck: null,
    });
  });

  it.each([
    ["highway category", { category: "highway", type: "house" }],
    ["residential type", { category: "place", type: "residential" }],
    ["road address type", { type: "house", addresstype: "road" }],
  ])(
    "refuses an otherwise plausible street-level result by %s",
    async (_label, fields) => {
      const fetcher = sequencedFetcher({ elements: [] }, [
        nominatimHouse("10.4", "20.4", fields),
      ]);
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      const result = await adapter.locate({ address: ADDRESS });

      expect(result).toEqual({
        kind: "refused",
        reason: expect.stringMatching(/street|road/i),
      });
      await expect(adapter.geocode({ address: ADDRESS })).resolves.toBeNull();
    },
  );

  it("ranks the parcel's preferred feature ahead of an earlier house result", async () => {
    const fetcher = sequencedFetcher(
      { elements: [overpassElement("way", 42, 10.2, 20.2)] },
      [
        nominatimHouse("10.8", "20.8", { osm_id: 901 }),
        nominatimHouse("10.21", "20.21", {
          type: "amenity",
          osm_type: "way",
          osm_id: 42,
          address: {},
        }),
      ],
    );

    const result = await new OpenStreetMapGeoAdapter(options(fetcher)).locate({
      address: ADDRESS,
    });

    expect(result).toMatchObject({
      kind: "located",
      candidate: { ref: "way/42" },
      crossCheck: { latitude: 10.21, longitude: 20.21 },
    });
  });

  it("emits an uncorroborated house candidate for the verification gate to reject", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("10.5", "20.5"),
    ]);
    const result = await new OpenStreetMapGeoAdapter(options(fetcher)).locate({
      address: ADDRESS,
    });

    expect(result).toMatchObject({
      kind: "located",
      candidate: {
        latitude: 10.5,
        longitude: 20.5,
        precision: "house",
        interpolated: false,
        ref: "node/900",
      },
      crossCheck: null,
    });
    if (result.kind !== "located") throw new Error("expected a house result");

    expect(
      verifyGeocodedCoordinate(result.candidate, {
        boundingBox: BOUNDS,
        crossCheck: result.crossCheck,
      }),
    ).toMatchObject({ status: "rejected", code: "cross-check-missing" });
  });

  it("uses one bulk Overpass request, rate-limits distinct Nominatim requests, and caches repeats", async () => {
    let now = 5_000;
    const wait = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetcher = sequencedFetcher(
      { elements: [] },
      [nominatimHouse("10.1", "20.1")],
      [
        nominatimHouse("10.2", "20.2", {
          osm_id: 901,
          address: { house_number: "202", road: "Quasar Place" },
        }),
      ],
    );
    const adapter = new OpenStreetMapGeoAdapter(
      options(fetcher, { now: () => now, wait }),
    );

    await adapter.locate({ address: ADDRESS });
    await adapter.locate({ address: "202 Quasar Pl" });
    await adapter.locate({ address: `  ${ADDRESS.toUpperCase()}  ` });

    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("overpass")),
    ).toHaveLength(1);
  });

  it("deduplicates concurrent normalized-equivalent lookups", async () => {
    let releaseOverpass: ((response: Response) => void) | undefined;
    const pendingOverpass = new Promise<Response>((resolve) => {
      releaseOverpass = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("overpass")) return pendingOverpass;
      return jsonResponse([]);
    });
    const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

    const first = adapter.locate({ address: ADDRESS });
    const second = adapter.locate({ address: ` ${ADDRESS.toUpperCase()} ` });
    releaseOverpass?.(jsonResponse({ elements: [] }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "not-found", reason: expect.any(String) },
      { kind: "not-found", reason: expect.any(String) },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("overpass")),
    ).toHaveLength(1);
  });

  it("sends policy headers, the configured bbox, and the normalized query", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, []);
    const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

    await adapter.locate({ address: ADDRESS });

    const [overpassUrl, overpassInit] = fetcher.mock.calls[0] ?? [];
    expect(String(overpassUrl)).toBe("https://overpass-api.de/api/interpreter");
    expect(overpassInit?.method).toBe("POST");
    expect(overpassInit?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "porchfest-geocoder-tests/1.0 (example.invalid)",
    });
    expect((overpassInit?.body as URLSearchParams).get("data")).toContain(
      "(10,20,11,21);",
    );

    const [nominatimUrl, nominatimInit] = fetcher.mock.calls[1] ?? [];
    const parsedUrl = new URL(String(nominatimUrl));
    expect(parsedUrl.searchParams.get("q")).toBe(`${ADDRESS}, ${LOCALITY}`);
    expect(parsedUrl.searchParams.get("limit")).toBe("5");
    expect(nominatimInit?.headers).toMatchObject({
      "user-agent": "porchfest-geocoder-tests/1.0 (example.invalid)",
    });
    expect(nominatimInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("supports an explicitly shared in-memory cache seam", async () => {
    const cache = new InMemoryGeocodeCache();
    const firstFetcher = sequencedFetcher({ elements: [] }, []);
    await new OpenStreetMapGeoAdapter(options(firstFetcher, { cache })).locate({
      address: ADDRESS,
    });

    const secondFetcher = vi.fn<typeof fetch>();
    const result = await new OpenStreetMapGeoAdapter(
      options(secondFetcher, { cache }),
    ).locate({ address: ADDRESS.toUpperCase() });

    expect(result).toEqual({
      kind: "not-found",
      reason: expect.any(String),
    });
    expect(secondFetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-success response", async () => new Response(null, { status: 503 })],
    [
      "a malformed body",
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["a network throw", async () => Promise.reject(new Error("offline"))],
  ])(
    "maps Nominatim %s to unavailable without throwing",
    async (_label, failure) => {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("overpass")) {
          return jsonResponse({ elements: [] });
        }
        return failure();
      });
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
        kind: "unavailable",
        reason: expect.any(String),
      });
      await expect(adapter.geocode({ address: ADDRESS })).resolves.toBeNull();
    },
  );

  it.each([
    ["a non-success response", async () => new Response(null, { status: 503 })],
    [
      "a malformed body",
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["a network throw", async () => Promise.reject(new Error("offline"))],
  ])(
    "maps Overpass %s to unavailable without throwing",
    async (_label, failure) => {
      const fetcher = vi.fn<typeof fetch>(failure);
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
        kind: "unavailable",
        reason: expect.any(String),
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "Overpass",
      vi.fn<typeof fetch>(async () => jsonResponse({ unexpected: true })),
    ],
    [
      "Nominatim",
      vi.fn<typeof fetch>(async (input) =>
        String(input).includes("overpass")
          ? jsonResponse({ elements: [] })
          : jsonResponse({ unexpected: true }),
      ),
    ],
  ])(
    "maps a valid-JSON wrong-shape %s body to unavailable",
    async (_label, fetcher) => {
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
        kind: "unavailable",
        reason: expect.stringMatching(/malformed/i),
      });
    },
  );

  it("keeps a parcel candidate when Nominatim is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("overpass")
        ? jsonResponse({
            elements: [overpassElement("way", 42, 10.25, 20.25)],
          })
        : new Response(null, { status: 503 }),
    );
    const result = await new OpenStreetMapGeoAdapter(options(fetcher)).locate({
      address: ADDRESS,
    });

    expect(result).toMatchObject({
      kind: "located",
      candidate: { ref: "way/42", precision: "parcel" },
      crossCheck: null,
    });
    if (result.kind !== "located") throw new Error("expected a parcel result");
    expect(
      verifyGeocodedCoordinate(result.candidate, {
        boundingBox: BOUNDS,
        crossCheck: result.crossCheck,
      }),
    ).toMatchObject({ status: "accepted" });
  });
});

describe("address parsing", () => {
  it("appends the default locality only when Saint Paul is absent", () => {
    expect(queryString(ADDRESS)).toBe(`${ADDRESS}, Saint Paul, MN`);
    expect(queryString(`${ADDRESS}, St. Paul, MN`)).toBe(
      `${ADDRESS}, St. Paul, MN`,
    );
  });

  it("strips a configured trailing locality, state, and ZIP tail", () => {
    expect(
      parseAddress(`${ADDRESS}, ${LOCALITY} 55555-1234`, LOCALITY),
    ).toEqual({ houseNumber: "101", street: "Nebula Ave" });
  });

  it("strips the default Saint Paul city, state, and ZIP tail", () => {
    expect(parseAddress(`${ADDRESS}, Saint Paul, MN 55555`)).toEqual({
      houseNumber: "101",
      street: "Nebula Ave",
    });
  });

  it("returns a typed failure when the address has no house number", () => {
    expect(() => parseAddress("Nebula Avenue", LOCALITY)).toThrowError(
      expect.objectContaining({ code: "house-number-missing" }),
    );
  });

  it("returns a typed failure when no street follows the house number", () => {
    expect(() => parseAddress("101, Saint Paul, MN")).toThrowError(
      expect.objectContaining({ code: "street-missing" }),
    );
  });
});

describe("streetsMatch", () => {
  it.each([
    ["Nebula Ave", "Nebula Avenue", true],
    ["Orbit St", "Orbit Street", true],
    ["Quasar Place", "North Quasar Pl", true],
    ["W Comet Avenue", "East Comet Ave", false],
  ])("matches %s against %s as %s", (submitted, osmStreet, expected) => {
    expect(streetsMatch(submitted, osmStreet)).toBe(expected);
  });
});
