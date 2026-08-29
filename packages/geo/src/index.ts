export type { Coordinates, GeocodeRequest, GeoPort } from "@porchfest/core";
export {
  AddressParseError,
  DEFAULT_GEOCODE_TIMEOUT_MS,
  DEFAULT_LOCALITY_SUFFIX,
  DEFAULT_OPENSTREETMAP_USER_AGENT,
  InMemoryGeocodeCache,
  NOMINATIM_INTERVAL_MS,
  NOMINATIM_URL,
  OpenStreetMapGeoAdapter,
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
export {
  EARTH_RADIUS_METERS,
  boundingBoxContains,
  haversineDistanceMeters,
  isValidCoordinate,
  resolveCoordinatePrecedence,
  verifyGeocodedCoordinate,
  verifyOrganizerCoordinate,
  type AcceptedCoordinatePrecision,
  type BoundingBox,
  type CoordinatePrecedenceDecision,
  type CoordinatePrecision,
  type CoordinateRejection,
  type CoordinateRejectionCode,
  type CoordinateSource,
  type CoordinateVerdict,
  type CoordinateVerificationOptions,
  type GeocodeCandidate,
  type OrganizerCoordinate,
  type VerifiedCoordinate,
} from "./verify.js";

import type { GeocodeRequest, GeoPort } from "@porchfest/core";

export class NullGeoAdapter implements GeoPort {
  readonly name = "none";
  readonly configured = false;

  async geocode(_request: GeocodeRequest) {
    return null;
  }
}
