import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryGeocodeCache,
  OpenStreetMapGeoAdapter,
  parseAddress,
  queryString,
  streetsMatch,
  verifyGeocodedCoordinate,
  type BoundingBox,
  type GeocodeCache,
  type GeocodeOutcome,
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
  tags: Record<string, string> = {},
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
      ...tags,
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

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(parsedUrl.searchParams.get("viewbox")).toBe("20,10,21,11");
    expect(parsedUrl.searchParams.get("bounded")).toBe("1");
    expect(parsedUrl.searchParams.get("countrycodes")).toBe("us");
    expect(nominatimInit?.headers).toMatchObject({
      "user-agent": "porchfest-geocoder-tests/1.0 (example.invalid)",
    });
    expect(nominatimInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes a configured countrycodes option to Nominatim", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, []);
    const adapter = new OpenStreetMapGeoAdapter(
      options(fetcher, { countryCodes: "ca,us" }),
    );

    await adapter.locate({ address: ADDRESS });

    const nominatimUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(nominatimUrl.searchParams.get("countrycodes")).toBe("ca,us");
  });

  it("discards out-of-box Nominatim results before ranking", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("12", "22", { osm_id: 901 }),
      { type: "amenity" },
      nominatimHouse("10.4", "20.4", { osm_id: 902 }),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher)).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({
      kind: "located",
      candidate: { ref: "node/902", latitude: 10.4, longitude: 20.4 },
    });
  });

  it("returns not-found when every Nominatim result is outside the box", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("12", "22"),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher)).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "not-found" });
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

  it("treats a cache read failure as a miss", async () => {
    const cache: GeocodeCache = {
      get: vi.fn(async () => Promise.reject(new Error("read failed"))),
      set: vi.fn(async () => undefined),
    };
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("10.4", "20.4"),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher, { cache })).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "located" });
  });

  it("returns the provider outcome when a cache write fails", async () => {
    const cache: GeocodeCache = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => Promise.reject(new Error("write failed"))),
    };
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("10.4", "20.4"),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher, { cache })).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "located" });
  });

  it("does not write unavailable outcomes to the cache", async () => {
    const stored = new Map<string, GeocodeOutcome>();
    const cache: GeocodeCache = {
      get: vi.fn(async (key) => stored.get(key)),
      set: vi.fn(async (key, value) => {
        stored.set(key, value);
      }),
    };
    let nominatimCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("overpass")) {
        return jsonResponse({ elements: [] });
      }
      nominatimCalls += 1;
      return nominatimCalls === 1
        ? new Response(null, { status: 503 })
        : jsonResponse([nominatimHouse("10.4", "20.4")]);
    });
    const cachedAdapter = new OpenStreetMapGeoAdapter(
      options(fetcher, { cache }),
    );

    await expect(
      cachedAdapter.locate({ address: ADDRESS }),
    ).resolves.toMatchObject({
      kind: "unavailable",
    });
    await expect(
      cachedAdapter.locate({ address: ADDRESS }),
    ).resolves.toMatchObject({
      kind: "located",
    });
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it("ignores an unavailable outcome already present in a cache", async () => {
    const cache: GeocodeCache = {
      get: vi.fn(async (): Promise<GeocodeOutcome> => ({
        kind: "unavailable",
        reason: "stale provider fault",
      })),
      set: vi.fn(async () => undefined),
    };
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("10.4", "20.4"),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher, { cache })).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "located" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("checks the in-flight map before awaiting a cache read", async () => {
    let releaseCache: (() => void) | undefined;
    const cacheRead = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    const cache: GeocodeCache = {
      get: vi.fn(async () => {
        await cacheRead;
        return undefined;
      }),
      set: vi.fn(async () => undefined),
    };
    const fetcher = sequencedFetcher({ elements: [] }, []);
    const adapter = new OpenStreetMapGeoAdapter(options(fetcher, { cache }));

    const first = adapter.locate({ address: ADDRESS });
    const second = adapter.locate({ address: ADDRESS.toUpperCase() });
    expect(cache.get).toHaveBeenCalledOnce();
    releaseCache?.();
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "a non-success response",
      async () => new Response(null, { status: 503 }),
      /returned 503/i,
    ],
    [
      "a malformed body",
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      /malformed JSON/i,
    ],
    [
      "a network throw",
      async () => Promise.reject(new Error("offline")),
      /could not be reached/i,
    ],
  ])(
    "maps Nominatim %s to unavailable without throwing",
    async (_label, failure, reason) => {
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("overpass")) {
          return jsonResponse({ elements: [] });
        }
        return failure();
      });
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
        kind: "unavailable",
        reason: expect.stringMatching(reason),
      });
      await expect(adapter.geocode({ address: ADDRESS })).resolves.toBeNull();
    },
  );

  it.each([
    [
      "a non-success response",
      async () => new Response(null, { status: 503 }),
      /returned 503/i,
    ],
    [
      "a malformed body",
      async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      /malformed JSON/i,
    ],
    [
      "a network throw",
      async () => Promise.reject(new Error("offline")),
      /could not be reached/i,
    ],
  ])(
    "maps Overpass %s to unavailable without throwing",
    async (_label, failure, reason) => {
      const fetcher = vi.fn<typeof fetch>(async (input) =>
        String(input).includes("overpass") ? failure() : jsonResponse([]),
      );
      const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

      await expect(adapter.locate({ address: ADDRESS })).resolves.toEqual({
        kind: "unavailable",
        reason: expect.stringMatching(reason),
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
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

  it("retries Overpass after a fault and still runs the Nominatim house path", async () => {
    let overpassCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("overpass")) {
        overpassCalls += 1;
        return overpassCalls === 1
          ? new Response(null, { status: 503 })
          : jsonResponse({ elements: [] });
      }
      return jsonResponse([nominatimHouse("10.4", "20.4")]);
    });
    const adapter = new OpenStreetMapGeoAdapter(options(fetcher));

    await expect(adapter.locate({ address: ADDRESS })).resolves.toMatchObject({
      kind: "located",
      candidate: { precision: "house" },
      reason: expect.stringMatching(/Overpass.*unavailable/i),
    });
    await adapter.locate({ address: "202 Quasar Pl" });
    expect(overpassCalls).toBe(2);
  });

  it("starts Overpass and Nominatim before either provider resolves", async () => {
    let releaseOverpass: ((response: Response) => void) | undefined;
    let releaseNominatim: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("overpass")
        ? new Promise<Response>((resolve) => {
            releaseOverpass = resolve;
          })
        : new Promise<Response>((resolve) => {
            releaseNominatim = resolve;
          }),
    );
    const pending = new OpenStreetMapGeoAdapter(options(fetcher)).locate({
      address: ADDRESS,
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releaseNominatim?.(jsonResponse([nominatimHouse("10.4", "20.4")]));
    releaseOverpass?.(jsonResponse({ elements: [] }));
    await expect(pending).resolves.toMatchObject({ kind: "located" });
  });

  it.each([
    ["Nominatim", 25, { nominatimTimeoutMs: 25 }],
    ["Overpass", 50, { overpassTimeoutMs: 50 }],
  ])(
    "reports when %s times out",
    async (service, timeoutMs, timeoutOptions) => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const isOverpass = String(input).includes("overpass");
        if ((service === "Overpass") === isOverpass) {
          return new Promise<Response>(() => undefined);
        }
        return isOverpass
          ? jsonResponse({ elements: [] })
          : jsonResponse([nominatimHouse("10.4", "20.4")]);
      });
      const pending = new OpenStreetMapGeoAdapter(
        options(fetcher, timeoutOptions),
      ).locate({ address: ADDRESS });

      await vi.advanceTimersByTimeAsync(timeoutMs);
      await expect(pending).resolves.toMatchObject({
        reason: expect.stringMatching(new RegExp(`${service}.*timed out`, "i")),
      });
    },
  );

  it("skips Nominatim candidates without an OSM feature ref", async () => {
    const fetcher = sequencedFetcher({ elements: [] }, [
      nominatimHouse("10.2", "20.2", {
        osm_type: undefined,
        osm_id: undefined,
      }),
    ]);

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher)).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "not-found" });
  });

  it("skips Overpass interpolation ways", async () => {
    const fetcher = sequencedFetcher(
      {
        elements: [
          overpassElement("way", 42, 10.2, 20.2, {
            "addr:interpolation": "all",
          }),
        ],
      },
      [],
    );

    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher)).locate({
        address: ADDRESS,
      }),
    ).resolves.toMatchObject({ kind: "not-found" });
  });
});

describe("address parsing", () => {
  it("appends the default locality only when Saint Paul is absent", () => {
    expect(queryString(ADDRESS)).toBe(`${ADDRESS}, Saint Paul, MN`);
    expect(queryString(`${ADDRESS}, St. Paul, MN`)).toBe(
      `${ADDRESS}, St. Paul, MN`,
    );
  });

  it("recognizes locality aliases only in a trailing address tail", () => {
    expect(queryString("101 St. Paul Street", "St. Paul, MN")).toBe(
      "101 St. Paul Street, St. Paul, MN",
    );
    expect(queryString("101 Nebula Ave, Saint Paul MN", "St. Paul, MN")).toBe(
      "101 Nebula Ave, Saint Paul MN",
    );
    expect(
      parseAddress("123 Nebula St, Saint Paul, MN 55555", "St. Paul, MN"),
    ).toEqual({ houseNumber: "123", street: "Nebula St" });
  });

  it("accepts optional commas and flexible whitespace in any locality suffix", () => {
    expect(queryString(`${ADDRESS}, Example Borough,ZZ`, LOCALITY)).toBe(
      `${ADDRESS}, Example Borough,ZZ`,
    );
    expect(parseAddress(`${ADDRESS} Example Borough,ZZ`, LOCALITY)).toEqual({
      houseNumber: "101",
      street: "Nebula Ave",
    });
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

  it.each(["101", "101A", "101-A", "101 1/2"])(
    "accepts leading house-number form %s",
    (houseNumber) => {
      expect(parseAddress(`${houseNumber} Nebula Ave`, LOCALITY)).toEqual({
        houseNumber: houseNumber.toLowerCase(),
        street: "Nebula Ave",
      });
    },
  );

  it("rejects a unit-prefixed address instead of taking a later number", async () => {
    expect(() => parseAddress("Apt 3, 101 Nebula Ave", LOCALITY)).toThrowError(
      expect.objectContaining({ code: "house-number-missing" }),
    );
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new OpenStreetMapGeoAdapter(options(fetcher)).locate({
        address: "Apt 3, 101 Nebula Ave",
      }),
    ).resolves.toEqual({
      kind: "refused",
      reason: expect.stringMatching(/could not parse a house number/i),
    });
    expect(fetcher).not.toHaveBeenCalled();
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
    ["St Anthony Ave", "Saint Anthony Avenue", true],
    ["N Example St", "North Example Street", true],
    ["Example St N", "Example Street North", true],
    ["Example Blvd", "Example Boulevard", true],
    ["Example Dr", "Example Drive", true],
    ["Example Ct", "Example Court", true],
    ["Example Rd", "Example Road", true],
    ["Example Ln", "Example Lane", true],
    ["Example Pkwy", "Example Parkway", true],
  ])("matches %s against %s as %s", (submitted, osmStreet, expected) => {
    expect(streetsMatch(submitted, osmStreet)).toBe(expected);
  });
});
