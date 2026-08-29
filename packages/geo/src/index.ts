export type { Coordinates, GeocodeRequest, GeoPort } from "@porchfest/core";
export {
  AddressParseError,
  DEFAULT_NOMINATIM_TIMEOUT_MS,
  DEFAULT_OVERPASS_TIMEOUT_MS,
  DEFAULT_LOCALITY_SUFFIX,
  DEFAULT_OPENSTREETMAP_USER_AGENT,
  InMemoryGeocodeCache,
  MAX_OVERPASS_SNAPSHOTS,
  NOMINATIM_INTERVAL_MS,
  NOMINATIM_URL,
  OpenStreetMapGeoAdapter,
  OVERPASS_SNAPSHOT_TTL_MS,
  OVERPASS_URL,
  parseAddress,
  queryString,
  streetsMatch,
  type AddressParseFailureCode,
  type GeocodeCache,
  type GeocodeOutcome,
  type OpenStreetMapGeoAdapterOptions,
  type ParsedAddress,
} from "./geocode.js";
export * from "./verify.js";

import type {
  GeocodeRequest,
  GeoPort,
  LocateOutcome,
  LocateRequest,
} from "@porchfest/core";

export class NullGeoAdapter implements GeoPort {
  readonly name = "none";
  readonly configured = false;

  async locate(_request: LocateRequest): Promise<LocateOutcome> {
    return {
      kind: "unavailable" as const,
      reason: "no geocoding provider configured",
    };
  }

  async geocode(request: GeocodeRequest) {
    const outcome = await this.locate(request);
    return outcome.kind === "located" ? outcome.candidate : null;
  }
}
