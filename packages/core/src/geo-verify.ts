import type {
  BoundingBox,
  CoordinatePrecision,
  Coordinates,
  LocateCandidate,
} from "./ports/geo.js";

/** The precision classes a published coordinate may carry. */
export type AcceptedCoordinatePrecision = Exclude<
  CoordinatePrecision,
  "street"
>;

/** Where a stored coordinate came from. An organizer's correction outranks a
 *  geocoder's guess in the core persistence layer. */
export type CoordinateSource = "geocoded" | "organizer-verified";

/** A geocoder result offered to the gate, before anything is stored. */
export type GeocodeCandidate = LocateCandidate;

/** A point an organizer placed or corrected by hand. */
export interface OrganizerCoordinate extends Coordinates {
  /** What the organizer's correction can be traced back to, kept as
   *  provenance — an admin edit or import identifier, not a provider row. */
  readonly ref: string;
}

/**
 * A coordinate that cleared the gate, flat so a persistence layer can store it
 * as one row without reshaping it (KTD11 / R29). `precision` is null for an
 * organizer-placed point, which has no geocoder precision class.
 */
export interface VerifiedCoordinate extends Coordinates {
  readonly source: CoordinateSource;
  readonly ref: string;
  readonly precision: AcceptedCoordinatePrecision | null;
  /** Metres between this point and its cross-check reference, or null when no
   *  reference was supplied. Carried, not thresholded: the organizer judges. */
  readonly crossCheckDistanceMeters: number | null;
}

export type CoordinateGateRejectionCode =
  | "invalid-coordinate"
  | "missing-ref"
  | "interpolated"
  | "imprecise"
  | "out-of-bounds"
  | "cross-check-missing";

export interface CoordinateRejection {
  readonly code: CoordinateGateRejectionCode;
  readonly reason: string;
}

/**
 * The gate's answer. A rejection names every gate that failed, because the
 * precision, interpolation, and bounding-box checks are independent: a caller
 * must be able to tell "outside the neighborhood" from "too imprecise" from
 * "interpolated" rather than seeing only whichever ran first. `code` and
 * `reason` mirror `failures[0]` for callers that only want the headline.
 */
export type CoordinateVerdict =
  | { readonly status: "accepted"; readonly coordinate: VerifiedCoordinate }
  | {
      readonly status: "rejected";
      readonly code: CoordinateGateRejectionCode;
      readonly reason: string;
      readonly failures: readonly CoordinateRejection[];
    };

export interface CoordinateVerificationOptions {
  readonly boundingBox: BoundingBox;
  /**
   * An independently sourced point for the same address. Required for a
   * house-level fallback, which is only trustworthy because something
   * corroborates it; optional for a parcel-level address point.
   */
  readonly crossCheck?: Coordinates | null;
}

/** IUGG mean Earth radius. Good to well under a metre at neighborhood scale. */
export const EARTH_RADIUS_METERS = 6_371_008.8;

const OUT_OF_BOUNDS_REASON =
  "The point falls outside the configured neighborhood bounding box.";

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

export function isValidCoordinate(value: Coordinates): boolean {
  return (
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.latitude) <= MAX_LATITUDE &&
    Math.abs(value.longitude) <= MAX_LONGITUDE
  );
}

/** Edge-inclusive: a point sitting exactly on a boundary is inside it. */
export function boundingBoxContains(
  box: BoundingBox,
  coordinate: Coordinates,
): boolean {
  assertBoundingBox(box);

  return (
    coordinate.latitude >= box.south &&
    coordinate.latitude <= box.north &&
    coordinate.longitude >= box.west &&
    coordinate.longitude <= box.east
  );
}

/**
 * Great-circle distance in metres. The half-angle form keeps its accuracy for
 * the very short distances a cross-check measures, and the sine of the half
 * delta makes an antimeridian crossing a short hop rather than a lap.
 */
export function haversineDistanceMeters(
  from: Coordinates,
  to: Coordinates,
): number {
  assertCoordinate(from, "from");
  assertCoordinate(to, "to");

  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const deltaLatitude = toLatitude - fromLatitude;
  const deltaLongitude = toRadians(to.longitude - from.longitude);

  const chord =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(deltaLongitude / 2) ** 2;

  // Clamped because rounding can push the chord a hair past 1 for antipodes,
  // where Math.asin would return NaN.
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(chord)));
}

/**
 * Decide whether a geocoder result is trustworthy enough to publish.
 *
 * Throws only for a misconfigured bounding box, which is a deployment fault
 * rather than a bad candidate. Every candidate fault is a rejection the caller
 * can report to an organizer.
 */
export function verifyGeocodedCoordinate(
  candidate: GeocodeCandidate,
  options: CoordinateVerificationOptions,
): CoordinateVerdict {
  assertBoundingBox(options.boundingBox);

  const structural = structuralFailures(candidate, options.crossCheck);
  if (structural.length > 0) return rejected(structural);

  const failures: CoordinateRejection[] = [];

  if (candidate.interpolated) {
    failures.push({
      code: "interpolated",
      reason:
        "The geocoder interpolated this point along a street segment instead of locating the address.",
    });
  }

  const acceptedPrecision = isAcceptedPrecision(candidate.precision)
    ? candidate.precision
    : null;
  if (acceptedPrecision === null) {
    failures.push({
      code: "imprecise",
      reason:
        "A street-level result is not precise enough to publish on the map.",
    });
  }

  if (!boundingBoxContains(options.boundingBox, candidate)) {
    failures.push({
      code: "out-of-bounds",
      reason: OUT_OF_BOUNDS_REASON,
    });
  }

  const crossCheck = options.crossCheck ?? null;
  if (candidate.precision === "house" && crossCheck === null) {
    failures.push({
      code: "cross-check-missing",
      reason:
        "A house-level fallback needs a cross-check reference point before it can be trusted.",
    });
  }

  if (acceptedPrecision === null) {
    return rejected(failures);
  }
  if (failures.length > 0) {
    return rejected(failures);
  }

  return {
    status: "accepted",
    coordinate: {
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      source: "geocoded",
      ref: candidate.ref.trim(),
      precision: acceptedPrecision,
      crossCheckDistanceMeters: crossCheckDistance(candidate, crossCheck),
    },
  };
}

/**
 * Accept a point an organizer placed by hand. The precision and interpolation
 * gates do not apply — an organizer dropping a pin on a porch has no geocoder
 * precision class — but the neighborhood box still runs, because a typo that
 * lands in another county is exactly what R17 exists to catch.
 */
export function verifyOrganizerCoordinate(
  coordinate: OrganizerCoordinate,
  options: CoordinateVerificationOptions,
): CoordinateVerdict {
  assertBoundingBox(options.boundingBox);

  const structural = structuralFailures(coordinate, options.crossCheck);
  if (structural.length > 0) return rejected(structural);

  if (!boundingBoxContains(options.boundingBox, coordinate)) {
    return rejected([
      {
        code: "out-of-bounds",
        reason: OUT_OF_BOUNDS_REASON,
      },
    ]);
  }

  const crossCheck = options.crossCheck ?? null;
  return {
    status: "accepted",
    coordinate: {
      latitude: coordinate.latitude,
      longitude: coordinate.longitude,
      source: "organizer-verified",
      ref: coordinate.ref.trim(),
      precision: null,
      crossCheckDistanceMeters: crossCheckDistance(coordinate, crossCheck),
    },
  };
}

function structuralFailures(
  candidate: Coordinates & { readonly ref: string },
  crossCheck: Coordinates | null | undefined,
): CoordinateRejection[] {
  const failures: CoordinateRejection[] = [];

  if (!isValidCoordinate(candidate)) {
    failures.push({
      code: "invalid-coordinate",
      reason: "The coordinate is not a finite point on Earth.",
    });
  }
  if (crossCheck != null && !isValidCoordinate(crossCheck)) {
    failures.push({
      code: "invalid-coordinate",
      reason: "The cross-check reference is not a finite point on Earth.",
    });
  }
  if (candidate.ref.trim().length === 0) {
    failures.push({
      code: "missing-ref",
      reason:
        "A coordinate must carry the reference it came from to be publishable.",
    });
  }

  return failures;
}

function crossCheckDistance(
  point: Coordinates,
  crossCheck: Coordinates | null,
): number | null {
  return crossCheck === null
    ? null
    : haversineDistanceMeters(point, crossCheck);
}

function isAcceptedPrecision(
  precision: CoordinatePrecision,
): precision is AcceptedCoordinatePrecision {
  return precision === "parcel" || precision === "house";
}

function rejected(failures: readonly CoordinateRejection[]): CoordinateVerdict {
  const headline = failures[0];
  if (headline === undefined) {
    throw new TypeError("A rejection must name at least one failed gate.");
  }

  return {
    status: "rejected",
    code: headline.code,
    reason: headline.reason,
    failures,
  };
}

export function assertBoundingBox(box: BoundingBox): void {
  if (
    !isValidCoordinate({ latitude: box.south, longitude: box.west }) ||
    !isValidCoordinate({ latitude: box.north, longitude: box.east })
  ) {
    throw new RangeError("A bounding box corner is not a point on Earth.");
  }
  // Strict, matching createSeasonSetup: a zero-area box would admit only points
  // on a single line, so it is always a misconfiguration rather than a filter.
  if (box.north <= box.south || box.east <= box.west) {
    throw new RangeError(
      "A bounding box needs north above south and east above west; it may not wrap the antimeridian.",
    );
  }
}

function assertCoordinate(value: Coordinates, label: string): void {
  if (!isValidCoordinate(value)) {
    throw new RangeError(`The ${label} coordinate is not a point on Earth.`);
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
