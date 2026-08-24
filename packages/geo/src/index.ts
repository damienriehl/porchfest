export type { Coordinates, GeocodeRequest, GeoPort } from "@porchfest/core";
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
