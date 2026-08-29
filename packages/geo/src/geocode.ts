import type {
  BoundingBox,
  Coordinates,
  GeocodeRequest,
  GeoPort,
  LocateOutcome,
  LocateRequest,
} from "@porchfest/core";
import { assertBoundingBox, boundingBoxContains } from "./verify.js";

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
export const DEFAULT_LOCALITY_SUFFIX = "Saint Paul, MN";
export const DEFAULT_OPENSTREETMAP_USER_AGENT =
  "porchfest-openstreetmap-geocoder/0.1 (self-hosted neighborhood event mapping)";
export const DEFAULT_OVERPASS_TIMEOUT_MS = 180_000;
export const DEFAULT_NOMINATIM_TIMEOUT_MS = 10_000;
export const NOMINATIM_INTERVAL_MS = 1_000;

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
const STREET_SUFFIX_ALIASES: Readonly<Record<string, string>> = {
  ave: "avenue",
  av: "avenue",
  st: "street",
  pl: "place",
  blvd: "boulevard",
  dr: "drive",
  ct: "court",
  rd: "road",
  ln: "lane",
  pkwy: "parkway",
};
const DIRECTION_ALIASES: Readonly<Record<string, string>> = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
};

export type GeocodeOutcome = LocateOutcome;

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
  /** Legacy fallback only; core supplies season bounds to every locate call. */
  readonly boundingBox?: BoundingBox;
  /** Locality appended to address queries that do not already end with it. */
  readonly localitySuffix?: string;
  /**
   * Nominatim requires an identifying User-Agent. Deployments should replace
   * the descriptive software default with their own application/contact value.
   */
  readonly userAgent?: string;
  /** Comma-separated Nominatim countrycodes filter. Defaults to `"us"`. */
  readonly countryCodes?: string;
  readonly overpassTimeoutMs?: number;
  readonly nominatimTimeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** Persistence seam for the later database-backed cache migration. */
  readonly cache?: GeocodeCache;
}

interface OverpassPoint {
  readonly houseNumber: string;
  readonly street: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly kind: "node" | "way";
  readonly id: number;
}

type ProviderResult<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "unavailable"; readonly reason: string };

type NominatimResult =
  | {
      readonly kind: "located";
      readonly point: Coordinates;
      readonly ref: string;
    }
  | { readonly kind: "not-found"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

interface LocateAttempt {
  readonly outcome: GeocodeOutcome;
  readonly cacheable: boolean;
}

interface LocalityGrammar {
  readonly suffix: string;
  readonly tail: RegExp;
}

type FetchJsonResult =
  | { readonly kind: "success"; readonly body: unknown }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "malformed-json" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unreachable" };

/** Append the deployment locality unless the address already names it. */
export function queryString(
  address: string,
  localitySuffix = DEFAULT_LOCALITY_SUFFIX,
): string {
  return queryStringWithGrammar(address, localityGrammar(localitySuffix));
}

/** Extract the first house number and the submitted street that follows it. */
export function parseAddress(
  address: string,
  localitySuffix = DEFAULT_LOCALITY_SUFFIX,
): ParsedAddress {
  return parseAddressWithGrammar(address, localityGrammar(localitySuffix));
}

function parseAddressWithGrammar(
  address: string,
  grammar: LocalityGrammar,
): ParsedAddress {
  const houseMatch = /^\s*(\d+(?:-[A-Za-z]|[A-Za-z]|\s+\d+\/\d+)?)\b/.exec(
    address,
  );
  if (houseMatch === null) {
    throw new AddressParseError(
      "house-number-missing",
      "OpenStreetMap could not parse a house number at the start of the address.",
    );
  }

  const houseNumber = caseFold(houseMatch[1] ?? "");
  let street = address.slice(houseMatch.index + houseMatch[0].length).trim();
  street = stripLocalityTail(street, grammar).replace(/^[ ,.]+|[ ,.]+$/g, "");
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
  return streetTokenSequencesMatch(
    normalizedStreetTokens(submitted),
    normalizedStreetTokens(osmStreet),
  );
}

function streetTokenSequencesMatch(
  submittedTokens: readonly string[],
  osmTokens: readonly string[],
): boolean {
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
  readonly #defaultBoundingBox: BoundingBox | null;
  readonly #defaultLocalitySuffix: string;
  readonly #userAgent: string;
  readonly #countryCodes: string;
  readonly #overpassTimeoutMs: number;
  readonly #nominatimTimeoutMs: number;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #cache: GeocodeCache;
  readonly #inFlight = new Map<string, Promise<GeocodeOutcome>>();
  readonly #overpassPoints = new Map<
    string,
    Promise<ProviderResult<ReadonlyMap<string, readonly OverpassPoint[]>>>
  >();
  #lastNominatimRequestAt: number | null = null;
  #nominatimQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenStreetMapGeoAdapterOptions) {
    if (options.boundingBox !== undefined) {
      assertBoundingBox(options.boundingBox);
    }
    this.#defaultBoundingBox =
      options.boundingBox === undefined ? null : { ...options.boundingBox };
    this.#defaultLocalitySuffix =
      options.localitySuffix ?? DEFAULT_LOCALITY_SUFFIX;
    this.#userAgent = requireNonEmpty(
      options.userAgent ?? DEFAULT_OPENSTREETMAP_USER_AGENT,
      "userAgent",
    );
    this.#countryCodes = requireNonEmpty(
      options.countryCodes ?? "us",
      "countryCodes",
    );
    this.#overpassTimeoutMs = positiveTimeout(
      options.overpassTimeoutMs ?? DEFAULT_OVERPASS_TIMEOUT_MS,
      "overpassTimeoutMs",
    );
    this.#nominatimTimeoutMs = positiveTimeout(
      options.nominatimTimeoutMs ?? DEFAULT_NOMINATIM_TIMEOUT_MS,
      "nominatimTimeoutMs",
    );
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

  async locate(request: LocateRequest): Promise<GeocodeOutcome> {
    const boundingBox = request.boundingBox ?? this.#defaultBoundingBox;
    if (boundingBox === null) {
      return {
        kind: "unavailable",
        reason: "No season bounding box was supplied for geocoding.",
      };
    }
    assertBoundingBox(boundingBox);
    const grammar = localityGrammar(
      request.localityName ?? this.#defaultLocalitySuffix,
    );
    const { key, query } = normalizedAddressKey(
      request.address,
      grammar,
      cacheNamespace(boundingBox, this.#countryCodes),
    );
    const active = this.#inFlight.get(key);
    if (active !== undefined) return active;

    const operation = this.#locateWithCache(
      key,
      request.address,
      query,
      grammar,
      boundingBox,
    );
    this.#inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #locateWithCache(
    key: string,
    address: string,
    query: string,
    grammar: LocalityGrammar,
    boundingBox: BoundingBox,
  ): Promise<GeocodeOutcome> {
    try {
      const cached = await this.#cache.get(key);
      if (cached !== undefined && cached.kind !== "unavailable") return cached;
    } catch {
      // A persistent cache is an optimization, not a provider dependency.
    }

    const attempt = await this.#locateUncached(
      address,
      query,
      grammar,
      boundingBox,
    );
    const { outcome } = attempt;
    if (!attempt.cacheable) return outcome;
    try {
      await this.#cache.set(key, outcome);
    } catch {
      // The located/refused/not-found provider outcome remains authoritative.
    }
    return outcome;
  }

  async #locateUncached(
    address: string,
    submittedQuery: string,
    grammar: LocalityGrammar,
    boundingBox: BoundingBox,
  ): Promise<LocateAttempt> {
    let parsed: ParsedAddress;
    try {
      parsed = parseAddressWithGrammar(address, grammar);
    } catch (error) {
      if (error instanceof AddressParseError) {
        return cacheableAttempt({ kind: "refused", reason: error.message });
      }
      throw error;
    }

    const submittedStreetTokens = normalizedStreetTokens(parsed.street);
    const [overpass, nominatim] = await Promise.all([
      this.#loadOverpassPoints(boundingBox),
      this.#lookupNominatim(submittedQuery, boundingBox),
    ]);
    const parcel =
      overpass.kind === "available"
        ? selectParcelPoint(parsed, submittedStreetTokens, overpass.value)
        : null;
    if (nominatim.kind === "unavailable") {
      if (parcel !== null) return cacheableAttempt(locatedParcel(parcel, null));
      return uncacheableAttempt(
        overpass.kind === "unavailable"
          ? {
              kind: "unavailable",
              reason: `${overpass.reason} ${nominatim.reason}`,
            }
          : nominatim,
      );
    }

    const nominatimResult = selectNominatimResult(
      nominatim.value,
      parsed,
      submittedStreetTokens,
      boundingBox,
      parcel === null ? undefined : overpassReference(parcel),
    );

    if (parcel !== null) {
      return cacheableAttempt(
        locatedParcel(
          parcel,
          nominatimResult.kind === "located" ? nominatimResult.point : null,
        ),
      );
    }
    if (nominatimResult.kind === "located") {
      const outcome: GeocodeOutcome = {
        kind: "located",
        candidate: {
          ...nominatimResult.point,
          precision: "house",
          interpolated: false,
          ref: nominatimResult.ref,
        },
        crossCheck: null,
        reason:
          overpass.kind === "unavailable"
            ? `Located a house-level result, but Overpass was unavailable: ${overpass.reason}`
            : "Located a house-level address result.",
      };
      return overpass.kind === "unavailable"
        ? uncacheableAttempt(outcome)
        : cacheableAttempt(outcome);
    }
    if (overpass.kind === "unavailable") {
      return uncacheableAttempt({
        kind: "unavailable",
        reason: `Overpass was unavailable: ${overpass.reason} ${nominatimResult.reason}`,
      });
    }
    return cacheableAttempt(nominatimResult);
  }

  #loadOverpassPoints(
    boundingBox: BoundingBox,
  ): Promise<ProviderResult<ReadonlyMap<string, readonly OverpassPoint[]>>> {
    const key = boundingBoxNamespace(boundingBox);
    const current = this.#overpassPoints.get(key);
    if (current !== undefined) return current;
    const operation = this.#fetchOverpassPoints(boundingBox);
    this.#overpassPoints.set(key, operation);
    void operation.then(
      (result) => {
        if (result.kind === "unavailable") {
          if (this.#overpassPoints.get(key) === operation) {
            this.#overpassPoints.delete(key);
          }
        }
      },
      () => {
        if (this.#overpassPoints.get(key) === operation) {
          this.#overpassPoints.delete(key);
        }
      },
    );
    return operation;
  }

  async #fetchOverpassPoints(
    boundingBox: BoundingBox,
  ): Promise<ProviderResult<ReadonlyMap<string, readonly OverpassPoint[]>>> {
    const form = new URLSearchParams({
      data: overpassQuery(boundingBox),
    });
    const request = await fetchJsonWithTimeout(
      this.#fetcher,
      OVERPASS_URL,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.#userAgent,
        },
        body: form,
      },
      this.#overpassTimeoutMs,
    );
    if (request.kind === "timeout") {
      return { kind: "unavailable", reason: "Overpass timed out." };
    }
    if (request.kind === "unreachable") {
      return { kind: "unavailable", reason: "Overpass could not be reached." };
    }
    if (request.kind === "http-error") {
      return {
        kind: "unavailable",
        reason: `Overpass returned ${request.status}.`,
      };
    }
    if (request.kind === "malformed-json") {
      return {
        kind: "unavailable",
        reason: "Overpass returned malformed JSON.",
      };
    }
    const elements = objectProperty(request.body, "elements");
    if (!Array.isArray(elements)) {
      return {
        kind: "unavailable",
        reason: "Overpass returned a malformed body.",
      };
    }
    return { kind: "available", value: indexOverpassElements(elements) };
  }

  #lookupNominatim(
    query: string,
    boundingBox: BoundingBox,
  ): Promise<ProviderResult<readonly unknown[]>> {
    const operation = this.#nominatimQueue.then(() =>
      this.#fetchNominatim(query, boundingBox),
    );
    this.#nominatimQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #fetchNominatim(
    query: string,
    boundingBox: BoundingBox,
  ): Promise<ProviderResult<readonly unknown[]>> {
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
      countrycodes: this.#countryCodes,
      viewbox: `${boundingBox.west},${boundingBox.south},${boundingBox.east},${boundingBox.north}`,
      bounded: "1",
      q: query,
    }).toString();
    const request = await fetchJsonWithTimeout(
      this.#fetcher,
      url,
      {
        headers: { "user-agent": this.#userAgent },
      },
      this.#nominatimTimeoutMs,
    );
    if (request.kind === "timeout") {
      return { kind: "unavailable", reason: "Nominatim timed out." };
    }
    if (request.kind === "unreachable") {
      return {
        kind: "unavailable",
        reason: "Nominatim could not be reached.",
      };
    }
    if (request.kind === "http-error") {
      return {
        kind: "unavailable",
        reason: `Nominatim returned ${request.status}.`,
      };
    }
    if (request.kind === "malformed-json") {
      return {
        kind: "unavailable",
        reason: "Nominatim returned malformed JSON.",
      };
    }
    if (!Array.isArray(request.body)) {
      return {
        kind: "unavailable",
        reason: "Nominatim returned a malformed body.",
      };
    }
    return { kind: "available", value: request.body };
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

function parseOverpassElement(element: unknown): OverpassPoint | null {
  if (!isObject(element)) return null;
  const type = element.type;
  const id = element.id;
  if (
    (type !== "node" && type !== "way") ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id)
  ) {
    return null;
  }
  if (!isObject(element.tags)) return null;
  if ("addr:interpolation" in element.tags) return null;
  const houseNumber = element.tags["addr:housenumber"];
  const street = element.tags["addr:street"] ?? element.tags["addr:place"];
  if (typeof houseNumber !== "string" || typeof street !== "string") {
    return null;
  }

  const source = type === "node" ? element : element.center;
  if (!isObject(source)) return null;
  const latitude = finiteNumber(source.lat);
  const longitude = finiteNumber(source.lon);
  if (latitude === null || longitude === null) return null;

  return {
    houseNumber: caseFold(houseNumber.trim()),
    street,
    latitude,
    longitude,
    kind: type,
    id,
  };
}

function selectParcelPoint(
  address: ParsedAddress,
  submittedStreetTokens: readonly string[],
  pointsByHouseNumber: ReadonlyMap<string, readonly OverpassPoint[]>,
): OverpassPoint | null {
  let selected: OverpassPoint | null = null;
  for (const point of pointsByHouseNumber.get(address.houseNumber) ?? []) {
    if (
      !streetTokenSequencesMatch(
        submittedStreetTokens,
        normalizedStreetTokens(point.street),
      )
    ) {
      continue;
    }
    if (selected === null || parcelPointPrecedes(point, selected)) {
      selected = point;
    }
  }
  return selected;
}

function locatedParcel(
  parcel: OverpassPoint,
  crossCheck: Coordinates | null,
): GeocodeOutcome {
  return {
    kind: "located",
    candidate: {
      latitude: roundCoordinate(parcel.latitude),
      longitude: roundCoordinate(parcel.longitude),
      precision: "parcel",
      interpolated: false,
      ref: overpassReference(parcel),
    },
    crossCheck,
    reason: "Located a parcel-level address point.",
  };
}

function selectNominatimResult(
  body: readonly unknown[],
  submitted: ParsedAddress,
  submittedStreetTokens: readonly string[],
  boundingBox: BoundingBox,
  preferredRef?: string,
): NominatimResult {
  // Nominatim does not expose enough information to distinguish interpolation
  // results. Any such house result remains subject to the independent
  // cross-check gate before publication.
  let selected: {
    readonly rank: number;
    readonly index: number;
    readonly point: Coordinates;
    readonly ref: string;
  } | null = null;
  const results = body.filter((value): value is Record<string, unknown> => {
    if (!isObject(value)) return false;
    const latitude = finiteNumber(value.lat);
    const longitude = finiteNumber(value.lon);
    return (
      latitude !== null &&
      longitude !== null &&
      boundingBoxContains(boundingBox, { latitude, longitude })
    );
  });
  const streetLevelOnly =
    results.length > 0 && results.every(isStreetLevelNominatimResult);

  for (const [index, value] of results.entries()) {
    if (isStreetLevelNominatimResult(value)) continue;

    const latitude = finiteNumber(value.lat);
    const longitude = finiteNumber(value.lon);
    if (latitude === null || longitude === null) continue;
    const type = stringValue(value.type);
    const ref = nominatimReference(value);
    if (ref === null) continue;
    let rank: number | null = null;
    if (preferredRef !== undefined && ref === preferredRef) {
      rank = 0;
    } else if (
      nominatimAddressMatches(value, submitted, submittedStreetTokens)
    ) {
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
    return { kind: "located", point: selected.point, ref: selected.ref };
  }
  if (streetLevelOnly) {
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

function nominatimReference(value: Record<string, unknown>): string | null {
  const osmType = stringValue(value.osm_type);
  const osmId = value.osm_id;
  if (
    (osmType === "node" || osmType === "way" || osmType === "relation") &&
    osmId !== null &&
    osmId !== undefined
  ) {
    return `${osmType}/${String(osmId)}`;
  }
  return null;
}

function nominatimAddressMatches(
  value: Record<string, unknown>,
  submitted: ParsedAddress,
  submittedStreetTokens: readonly string[],
): boolean {
  if (!isObject(value.address)) return false;
  const houseNumber = value.address.house_number;
  const street = value.address.road ?? value.address.street;
  return (
    typeof houseNumber === "string" &&
    caseFold(houseNumber.trim()) === submitted.houseNumber &&
    typeof street === "string" &&
    streetTokenSequencesMatch(
      submittedStreetTokens,
      normalizedStreetTokens(street),
    )
  );
}

function normalizedStreetTokens(street: string): string[] {
  const tokens = [...caseFold(street).matchAll(/[a-z0-9]+/g)].map(
    (match) => match[0],
  );
  if (tokens.length === 0) return tokens;

  const normalized = tokens.map((token, index) => {
    if (index === 0 || index === tokens.length - 1) {
      return DIRECTION_ALIASES[token] ?? token;
    }
    return token;
  });
  const streetNameIndex = DIRECTION_WORDS.has(normalized[0] ?? "") ? 1 : 0;
  const streetNameToken = normalized[streetNameIndex];
  if (
    streetNameIndex < normalized.length - 1 &&
    (streetNameToken === "st" || streetNameToken === "ste")
  ) {
    normalized[streetNameIndex] = "saint";
  }
  const lastIndex = normalized.length - 1;
  const suffixIndex = DIRECTION_WORDS.has(normalized[lastIndex] ?? "")
    ? lastIndex - 1
    : lastIndex;
  if (suffixIndex >= 0) {
    normalized[suffixIndex] =
      STREET_SUFFIX_ALIASES[normalized[suffixIndex] ?? ""] ??
      normalized[suffixIndex] ??
      "";
  }
  return normalized;
}

function indexOverpassElements(
  elements: readonly unknown[],
): ReadonlyMap<string, readonly OverpassPoint[]> {
  const pointsByHouseNumber = new Map<string, OverpassPoint[]>();
  for (const element of elements) {
    const point = parseOverpassElement(element);
    if (point === null) continue;
    const points = pointsByHouseNumber.get(point.houseNumber) ?? [];
    points.push(point);
    pointsByHouseNumber.set(point.houseNumber, points);
  }
  return pointsByHouseNumber;
}

function parcelPointPrecedes(
  candidate: OverpassPoint,
  selected: OverpassPoint,
): boolean {
  if (candidate.kind !== selected.kind) return candidate.kind === "way";
  return candidate.id < selected.id;
}

function overpassReference(point: OverpassPoint): string {
  return `${point.kind}/${point.id}`;
}

function normalizedAddressKey(
  address: string,
  grammar: LocalityGrammar,
  namespace: string,
): { readonly key: string; readonly query: string } {
  const query = queryStringWithGrammar(address.trim(), grammar);
  return {
    query,
    key: `${namespace}|${caseFold(query).replace(/\s+/g, " ").trim()}`,
  };
}

function cacheNamespace(box: BoundingBox, countryCodes: string): string {
  const canonicalCountryCodes = countryCodes
    .split(",")
    .map((code) => caseFold(code.trim()))
    .join(",");
  return `openstreetmap-v1|countrycodes=${canonicalCountryCodes}|bbox=${boundingBoxNamespace(box)}`;
}

function boundingBoxNamespace(box: BoundingBox): string {
  return `${box.west},${box.south},${box.east},${box.north}`;
}

function queryStringWithGrammar(
  address: string,
  grammar: LocalityGrammar,
): string {
  if (containsLocality(address, grammar)) return address;
  return `${address}, ${grammar.suffix}`;
}

function containsLocality(address: string, grammar: LocalityGrammar): boolean {
  return grammar.tail.test(address);
}

function stripLocalityTail(street: string, grammar: LocalityGrammar): string {
  return street.replace(grammar.tail, "");
}

function localityGrammar(localitySuffix: string): LocalityGrammar {
  const suffix = requireNonEmpty(localitySuffix, "localitySuffix");
  const tokenMatches = [...suffix.matchAll(/[A-Za-z0-9]+(?:\.)?/g)];
  if (tokenMatches.length === 0) {
    throw new TypeError("localitySuffix must contain a word or number.");
  }

  let localityPattern = localityTokenPattern(tokenMatches[0]?.[0] ?? "");
  for (let index = 1; index < tokenMatches.length; index += 1) {
    const previous = tokenMatches[index - 1];
    const current = tokenMatches[index];
    if (previous === undefined || current === undefined) continue;
    localityPattern += String.raw`(?:\s*,\s*|\s+)`;
    localityPattern += localityTokenPattern(current[0]);
  }

  return {
    suffix,
    tail: new RegExp(
      String.raw`(?:^|,\s*|\s+)${localityPattern}(?:,?\s*\d{5}(?:-\d{4})?)?\s*$`,
      "i",
    ),
  };
}

function localityTokenPattern(token: string): string {
  return /^(?:saint|st\.?)$/i.test(token)
    ? String.raw`(?:saint|st\.?)`
    : escapeRegExp(token);
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

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

async function fetchJsonWithTimeout(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchJsonResult> {
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const operation: Promise<FetchJsonResult> = (async () => {
    const response = await fetcher(input, {
      ...init,
      signal: abortController.signal,
    });
    if (!response.ok) {
      return { kind: "http-error", status: response.status };
    }
    try {
      return { kind: "success", body: await response.json() };
    } catch {
      return { kind: "malformed-json" };
    }
  })();
  const timeout = new Promise<FetchJsonResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ kind: "timeout" });
      abortController.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return { kind: "unreachable" };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function cacheableAttempt(outcome: GeocodeOutcome): LocateAttempt {
  return { outcome, cacheable: true };
}

function uncacheableAttempt(outcome: GeocodeOutcome): LocateAttempt {
  return { outcome, cacheable: false };
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
