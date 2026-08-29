import type { Coordinates, GeocodeRequest, GeoPort } from "@porchfest/core";
import { isValidCoordinate } from "./verify.js";
import type { BoundingBox, GeocodeCandidate } from "./verify.js";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const DEFAULT_LOCALITY_SUFFIX = "Saint Paul, MN";
export const DEFAULT_OPENSTREETMAP_USER_AGENT =
  "porchfest-openstreetmap-geocoder/0.1 (self-hosted neighborhood event mapping)";
export const DEFAULT_GEOCODE_TIMEOUT_MS = 180_000;
export const NOMINATIM_INTERVAL_MS = 1_000;

const DEFAULT_LOCALITY_PATTERN = String.raw`(?:saint|st\.?)\s+paul`;
const HOUSE_LEVEL_TYPES = new Set(["house", "building"]);
const STREET_LEVEL_TYPES = new Set([
  "living_street",
  "motorway",
  "pedestrian",
  "primary",
  "residential",
  "road",
  "secondary",
  "service",
  "street",
  "tertiary",
  "trunk",
  "unclassified",
]);
const DIRECTION_WORDS = new Set(["north", "south", "east", "west"]);
const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  ave: "avenue",
  av: "avenue",
  st: "street",
  pl: "place",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
};

export type GeocodeOutcome =
  | {
      readonly kind: "located";
      readonly candidate: GeocodeCandidate;
      readonly crossCheck: Coordinates | null;
    }
  | { readonly kind: "not-found"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GeocodeCache {
  get(key: string): Promise<GeocodeOutcome | undefined>;
  set(key: string, value: GeocodeOutcome): Promise<void>;
}

export class InMemoryGeocodeCache implements GeocodeCache {
  readonly #entries = new Map<string, GeocodeOutcome>();

  async get(key: string): Promise<GeocodeOutcome | undefined> {
    return this.#entries.get(key);
  }

  async set(key: string, value: GeocodeOutcome): Promise<void> {
    this.#entries.set(key, value);
  }
}

export type AddressParseFailureCode = "house-number-missing" | "street-missing";

export class AddressParseError extends TypeError {
  readonly code: AddressParseFailureCode;

  constructor(code: AddressParseFailureCode, message: string) {
    super(message);
    this.name = "AddressParseError";
    this.code = code;
  }
}

export interface ParsedAddress {
  readonly houseNumber: string;
  readonly street: string;
}

export interface OpenStreetMapGeoAdapterOptions {
  /** Core's season bounds. The adapter never supplies a city-specific box. */
  readonly boundingBox: BoundingBox;
  readonly localitySuffix?: string;
  /**
   * Nominatim requires an identifying User-Agent. Deployments should replace
   * the descriptive software default with their own application/contact value.
   */
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** Persistence seam for the later database-backed cache migration. */
  readonly cache?: GeocodeCache;
}

interface OverpassAddressPoint {
  readonly houseNumber: string;
  readonly street: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly ref: string;
  readonly kind: "node" | "way";
  readonly id: number;
}

type ProviderResult<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string };

type NominatimResult =
  | { readonly kind: "hit"; readonly point: Coordinates; readonly ref: string }
  | { readonly kind: "miss"; readonly streetLevelOnly: boolean };

/** Append the deployment locality unless the address already names it. */
export function queryString(
  address: string,
  localitySuffix = DEFAULT_LOCALITY_SUFFIX,
): string {
  const locality = requireNonEmpty(localitySuffix, "localitySuffix");
  if (containsLocality(address, locality)) return address;
  return `${address}, ${locality}`;
}

/** Extract the first house number and the submitted street that follows it. */
export function parseAddress(
  address: string,
  localitySuffix = DEFAULT_LOCALITY_SUFFIX,
): ParsedAddress {
  const locality = requireNonEmpty(localitySuffix, "localitySuffix");
  const houseMatch = /\b(\d+[A-Za-z]?)\b/.exec(address);
  if (houseMatch === null) {
    throw new AddressParseError(
      "house-number-missing",
      "The address has no house number.",
    );
  }

  const houseNumber = caseFold(houseMatch[1] ?? "");
  let street = address.slice(houseMatch.index + houseMatch[0].length).trim();
  street = stripLocalityTail(street, locality).replace(/^[ ,.]+|[ ,.]+$/g, "");
  if (street.length === 0) {
    throw new AddressParseError(
      "street-missing",
      "The address has no street after its house number.",
    );
  }

  return { houseNumber, street };
}

/** Match street tokens while treating an omitted direction as unspecified. */
export function streetsMatch(submitted: string, osmStreet: string): boolean {
  const submittedTokens = normalizedStreetTokens(submitted);
  const osmTokens = normalizedStreetTokens(osmStreet);
  const submittedBase = submittedTokens.filter(
    (token) => !DIRECTION_WORDS.has(token),
  );
  const osmBase = osmTokens.filter((token) => !DIRECTION_WORDS.has(token));
  if (!tuplesEqual(submittedBase, osmBase)) return false;

  const submittedDirections = submittedTokens.filter((token) =>
    DIRECTION_WORDS.has(token),
  );
  if (submittedDirections.length === 0) return true;
  const osmDirections = osmTokens.filter((token) => DIRECTION_WORDS.has(token));
  return tuplesEqual(submittedDirections, osmDirections);
}

export class OpenStreetMapGeoAdapter implements GeoPort {
  readonly name = "openstreetmap";
  readonly configured = true;
  readonly #boundingBox: BoundingBox;
  readonly #localitySuffix: string;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #cache: GeocodeCache;
  readonly #inFlight = new Map<string, Promise<GeocodeOutcome>>();
  #overpassPoints: Promise<
    ProviderResult<ReadonlyMap<string, readonly OverpassAddressPoint[]>>
  > | null = null;
  #lastNominatimRequestAt: number | null = null;
  #nominatimQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenStreetMapGeoAdapterOptions) {
    assertBoundingBox(options.boundingBox);
    this.#boundingBox = { ...options.boundingBox };
    this.#localitySuffix = requireNonEmpty(
      options.localitySuffix ?? DEFAULT_LOCALITY_SUFFIX,
      "localitySuffix",
    );
    this.#userAgent = requireNonEmpty(
      options.userAgent ?? DEFAULT_OPENSTREETMAP_USER_AGENT,
      "userAgent",
    );
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GEOCODE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive safe integer.");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? defaultWait;
    this.#cache = options.cache ?? new InMemoryGeocodeCache();
  }

  async geocode(request: GeocodeRequest): Promise<Coordinates | null> {
    const outcome = await this.locate(request);
    if (outcome.kind !== "located") return null;
    return {
      latitude: outcome.candidate.latitude,
      longitude: outcome.candidate.longitude,
    };
  }

  async locate(request: GeocodeRequest): Promise<GeocodeOutcome> {
    const key = normalizedAddressKey(request.address, this.#localitySuffix);
    const cached = await this.#cache.get(key);
    if (cached !== undefined) return cached;

    const active = this.#inFlight.get(key);
    if (active !== undefined) return active;

    const operation = this.#locateUncached(request.address).then(
      async (outcome) => {
        await this.#cache.set(key, outcome);
        return outcome;
      },
    );
    this.#inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #locateUncached(address: string): Promise<GeocodeOutcome> {
    let parsed: ParsedAddress;
    try {
      parsed = parseAddress(address, this.#localitySuffix);
    } catch (error) {
      if (error instanceof AddressParseError) {
        return { kind: "refused", reason: error.message };
      }
      throw error;
    }

    const overpass = await this.#loadOverpassPoints();
    if (overpass.kind === "unavailable") return overpass;
    const parcel = selectParcelPoint(parsed, overpass.value);

    const nominatim = await this.#lookupNominatim(address, parsed, parcel?.ref);
    if (nominatim.kind === "unavailable") {
      if (parcel !== null) return locatedParcel(parcel, null);
      return nominatim;
    }

    if (parcel !== null) {
      return locatedParcel(
        parcel,
        nominatim.value.kind === "hit" ? nominatim.value.point : null,
      );
    }
    if (nominatim.value.kind === "hit") {
      return {
        kind: "located",
        candidate: {
          ...nominatim.value.point,
          precision: "house",
          interpolated: false,
          ref: nominatim.value.ref,
        },
        crossCheck: null,
      };
    }
    if (nominatim.value.streetLevelOnly) {
      return {
        kind: "refused",
        reason:
          "Nominatim returned only street- or road-level results, which are not precise enough to publish.",
      };
    }
    return {
      kind: "not-found",
      reason: "OpenStreetMap returned no acceptable address match.",
    };
  }

  #loadOverpassPoints(): Promise<
    ProviderResult<ReadonlyMap<string, readonly OverpassAddressPoint[]>>
  > {
    this.#overpassPoints ??= this.#fetchOverpassPoints();
    return this.#overpassPoints;
  }

  async #fetchOverpassPoints(): Promise<
    ProviderResult<ReadonlyMap<string, readonly OverpassAddressPoint[]>>
  > {
    const form = new URLSearchParams({
      data: overpassQuery(this.#boundingBox),
    });
    try {
      const response = await this.#fetcher(OVERPASS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.#userAgent,
        },
        body: form,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        return {
          kind: "unavailable",
          reason:
            "The Overpass address-point service returned a non-success response.",
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          kind: "unavailable",
          reason: "The Overpass address-point service returned malformed JSON.",
        };
      }
      const elements = objectProperty(body, "elements");
      if (!Array.isArray(elements)) {
        return {
          kind: "unavailable",
          reason:
            "The Overpass address-point service returned a malformed body.",
        };
      }
      return { kind: "available", value: indexOverpassElements(elements) };
    } catch {
      return {
        kind: "unavailable",
        reason: "The Overpass address-point service could not be reached.",
      };
    }
  }

  #lookupNominatim(
    address: string,
    parsed: ParsedAddress,
    preferredRef?: string,
  ): Promise<ProviderResult<NominatimResult>> {
    const operation = this.#nominatimQueue.then(() =>
      this.#fetchNominatim(address, parsed, preferredRef),
    );
    this.#nominatimQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #fetchNominatim(
    address: string,
    parsed: ParsedAddress,
    preferredRef?: string,
  ): Promise<ProviderResult<NominatimResult>> {
    try {
      if (this.#lastNominatimRequestAt !== null) {
        const remaining =
          NOMINATIM_INTERVAL_MS - (this.#now() - this.#lastNominatimRequestAt);
        if (remaining > 0) await this.#wait(remaining);
      }
      this.#lastNominatimRequestAt = this.#now();

      const url = new URL(NOMINATIM_URL);
      url.search = new URLSearchParams({
        format: "jsonv2",
        limit: "5",
        addressdetails: "1",
        countrycodes: "us",
        q: queryString(address, this.#localitySuffix),
      }).toString();
      const response = await this.#fetcher(url, {
        headers: { "user-agent": this.#userAgent },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        return {
          kind: "unavailable",
          reason: "Nominatim returned a non-success response.",
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          kind: "unavailable",
          reason: "Nominatim returned malformed JSON.",
        };
      }
      if (!Array.isArray(body)) {
        return {
          kind: "unavailable",
          reason: "Nominatim returned a malformed body.",
        };
      }

      return {
        kind: "available",
        value: selectNominatimResult(body, parsed, preferredRef),
      };
    } catch {
      return {
        kind: "unavailable",
        reason: "Nominatim could not be reached.",
      };
    }
  }
}

function overpassQuery(box: BoundingBox): string {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  return (
    "[out:json][timeout:180];\n" +
    "(\n" +
    `  node["addr:housenumber"](${bbox});\n` +
    `  way["addr:housenumber"](${bbox});\n` +
    ");\n" +
    "out center tags;\n"
  );
}

function parseOverpassElement(element: unknown): OverpassAddressPoint[] {
  if (!isObject(element)) return [];
  const type = element.type;
  const id = element.id;
  if (
    (type !== "node" && type !== "way") ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id)
  ) {
    return [];
  }
  if (!isObject(element.tags)) return [];
  const houseNumber = element.tags["addr:housenumber"];
  const street = element.tags["addr:street"] ?? element.tags["addr:place"];
  if (typeof houseNumber !== "string" || typeof street !== "string") return [];

  const source = type === "node" ? element : element.center;
  if (!isObject(source)) return [];
  const latitude = finiteNumber(source.lat);
  const longitude = finiteNumber(source.lon);
  if (latitude === null || longitude === null) return [];

  return [
    {
      houseNumber: caseFold(houseNumber.trim()),
      street,
      latitude,
      longitude,
      ref: `${type}/${id}`,
      kind: type,
      id,
    },
  ];
}

function selectParcelPoint(
  address: ParsedAddress,
  pointsByHouseNumber: ReadonlyMap<string, readonly OverpassAddressPoint[]>,
): OverpassAddressPoint | null {
  let selected: OverpassAddressPoint | null = null;
  for (const point of pointsByHouseNumber.get(address.houseNumber) ?? []) {
    if (!streetsMatch(address.street, point.street)) continue;
    if (selected === null || parcelPointPrecedes(point, selected)) {
      selected = point;
    }
  }
  return selected;
}

function locatedParcel(
  parcel: OverpassAddressPoint,
  crossCheck: Coordinates | null,
): GeocodeOutcome {
  return {
    kind: "located",
    candidate: {
      latitude: roundCoordinate(parcel.latitude),
      longitude: roundCoordinate(parcel.longitude),
      precision: "parcel",
      interpolated: false,
      ref: parcel.ref,
    },
    crossCheck,
  };
}

function selectNominatimResult(
  body: readonly unknown[],
  submitted: ParsedAddress,
  preferredRef?: string,
): NominatimResult {
  let sawStreetLevel = false;
  let sawNonStreetLevel = false;
  let selected: {
    readonly rank: number;
    readonly index: number;
    readonly point: Coordinates;
    readonly ref: string;
  } | null = null;

  for (const [index, value] of body.entries()) {
    if (!isObject(value)) continue;
    if (isStreetLevelNominatimResult(value)) {
      sawStreetLevel = true;
      continue;
    }
    sawNonStreetLevel = true;

    const latitude = finiteNumber(value.lat);
    const longitude = finiteNumber(value.lon);
    if (latitude === null || longitude === null) continue;
    const type = stringValue(value.type);
    const ref = nominatimReference(value, type);
    let rank: number | null = null;
    if (preferredRef !== undefined && ref === preferredRef) {
      rank = 0;
    } else if (nominatimAddressMatches(value, submitted)) {
      rank = 1;
    } else if (HOUSE_LEVEL_TYPES.has(type)) {
      rank = 2;
    }
    if (rank === null) continue;
    const candidate = {
      rank,
      index,
      point: {
        latitude: roundCoordinate(latitude),
        longitude: roundCoordinate(longitude),
      },
      ref,
    };
    if (
      selected === null ||
      candidate.rank < selected.rank ||
      (candidate.rank === selected.rank && candidate.index < selected.index)
    ) {
      selected = candidate;
    }
  }

  if (selected !== null) {
    return { kind: "hit", point: selected.point, ref: selected.ref };
  }
  return {
    kind: "miss",
    streetLevelOnly: sawStreetLevel && !sawNonStreetLevel,
  };
}

function isStreetLevelNominatimResult(value: Record<string, unknown>): boolean {
  const category = stringValue(value.category);
  const providerClass = stringValue(value.class);
  const type = stringValue(value.type);
  const addressType = stringValue(value.addresstype);
  return (
    category === "highway" ||
    providerClass === "highway" ||
    STREET_LEVEL_TYPES.has(type) ||
    addressType === "road" ||
    addressType === "street"
  );
}

function nominatimReference(
  value: Record<string, unknown>,
  type: string,
): string {
  const osmType = stringValue(value.osm_type);
  const osmId = value.osm_id;
  if (
    (osmType === "node" || osmType === "way" || osmType === "relation") &&
    osmId !== null &&
    osmId !== undefined
  ) {
    return `${osmType}/${String(osmId)}`;
  }
  return type;
}

function nominatimAddressMatches(
  value: Record<string, unknown>,
  submitted: ParsedAddress,
): boolean {
  if (!isObject(value.address)) return false;
  const houseNumber = value.address.house_number;
  const street = value.address.road ?? value.address.street;
  return (
    typeof houseNumber === "string" &&
    caseFold(houseNumber.trim()) === submitted.houseNumber &&
    typeof street === "string" &&
    streetsMatch(submitted.street, street)
  );
}

function normalizedStreetTokens(street: string): string[] {
  return [...caseFold(street).matchAll(/[a-z0-9]+/g)].map((match) => {
    const token = match[0];
    return TOKEN_ALIASES[token] ?? token;
  });
}

function indexOverpassElements(
  elements: readonly unknown[],
): ReadonlyMap<string, readonly OverpassAddressPoint[]> {
  const pointsByHouseNumber = new Map<string, OverpassAddressPoint[]>();
  for (const element of elements) {
    for (const point of parseOverpassElement(element)) {
      const points = pointsByHouseNumber.get(point.houseNumber) ?? [];
      points.push(point);
      pointsByHouseNumber.set(point.houseNumber, points);
    }
  }
  return pointsByHouseNumber;
}

function parcelPointPrecedes(
  candidate: OverpassAddressPoint,
  selected: OverpassAddressPoint,
): boolean {
  if (candidate.kind !== selected.kind) return candidate.kind === "way";
  return candidate.id < selected.id;
}

function normalizedAddressKey(address: string, localitySuffix: string): string {
  return caseFold(queryString(address.trim(), localitySuffix))
    .replace(/\s+/g, " ")
    .trim();
}

function containsLocality(address: string, localitySuffix: string): boolean {
  if (localitySuffix === DEFAULT_LOCALITY_SUFFIX) {
    return new RegExp(String.raw`\b${DEFAULT_LOCALITY_PATTERN}\b`, "i").test(
      address,
    );
  }
  const localityPattern = escapedLocality(localitySuffix);
  return new RegExp(
    String.raw`(?:^|[,\s])${localityPattern}(?:\s+\d{5}(?:-\d{4})?)?\s*$`,
    "i",
  ).test(address);
}

function stripLocalityTail(street: string, localitySuffix: string): string {
  if (localitySuffix === DEFAULT_LOCALITY_SUFFIX) {
    const withoutState = street.replace(
      new RegExp(
        String.raw`\s*,?\s+(?:${DEFAULT_LOCALITY_PATTERN}\s*,?\s*)?mn\s*,?\s*(?:\d{5}(?:-\d{4})?)?\s*$`,
        "i",
      ),
      "",
    );
    return withoutState.replace(
      new RegExp(String.raw`\s*,?\s+${DEFAULT_LOCALITY_PATTERN}\s*$`, "i"),
      "",
    );
  }
  return street.replace(
    new RegExp(
      String.raw`\s*,?\s+${escapedLocality(localitySuffix)}(?:\s*,?\s*\d{5}(?:-\d{4})?)?\s*$`,
      "i",
    ),
    "",
  );
}

function escapedLocality(localitySuffix: string): string {
  return localitySuffix
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join(String.raw`\s+`)
    .replaceAll(",", String.raw`\s*,\s*`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tuplesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? caseFold(value.trim()) : "";
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function objectProperty(value: unknown, property: string): unknown {
  return isObject(value) ? value[property] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function caseFold(value: string): string {
  return value.toLowerCase();
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError(`${name} must not be empty.`);
  return trimmed;
}

function assertBoundingBox(box: BoundingBox): void {
  if (
    !isValidCoordinate({ latitude: box.south, longitude: box.west }) ||
    !isValidCoordinate({ latitude: box.north, longitude: box.east }) ||
    box.north <= box.south ||
    box.east <= box.west
  ) {
    throw new RangeError(
      "boundingBox must contain valid, ordered coordinates.",
    );
  }
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
