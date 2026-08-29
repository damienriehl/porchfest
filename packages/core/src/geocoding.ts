import { and, eq, sql } from "drizzle-orm";
import {
  haversineDistanceMeters,
  isValidCoordinate,
  verifyGeocodedCoordinate,
  verifyOrganizerCoordinate,
} from "./geo-verify.js";
import type { Coordinates, GeoPort, LocateOutcome } from "./ports/geo.js";
import {
  seasons,
  venueCoordinates,
  venues,
  type CoordinateRejectionCode,
  type VenueCoordinate,
} from "./storage/schema.js";
import {
  type CoreDatabase,
  type CoreExecutor,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

/**
 * Goal-1's independent parcel/house check treats a divergence above 30 metres
 * as suspicious. The pure gate carries the distance; core owns this publishing
 * policy because it decides whether a stored point is map-ready.
 */
export const MAX_PARCEL_CROSS_CHECK_DISTANCE_M = 30;

export type GeocodingActor = number | null;

export interface GeocodingPorts {
  readonly geo: GeoPort;
}

export type GeocodingRepositoryOptions = RepositoryOptions;

export type GeocodeVenueResult =
  | {
      readonly kind: "stored" | "cached" | "preserved";
      readonly coordinate: VenueCoordinate;
      readonly reason: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface VenueCoordinateReview {
  readonly venueId: number;
  readonly title: string;
  readonly address: string | null;
  readonly coordinate: VenueCoordinate;
}

export class GeocodingLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("GeocodingLifecycleError", message);
  }
}

export class GeocodingConflictError extends RepositoryConflictError<"venue"> {
  constructor(venueId: number, fields: readonly string[]) {
    super("GeocodingConflictError", "venue", venueId, fields);
  }
}

interface VenueSeasonContext {
  readonly venueId: number;
  readonly venueVersion: number;
  readonly title: string;
  readonly address: string | null;
  readonly seasonId: number;
  readonly seasonName: string;
  readonly localityName: string | null;
  readonly boundsNorth: number | null;
  readonly boundsSouth: number | null;
  readonly boundsEast: number | null;
  readonly boundsWest: number | null;
}

export function createGeocodingRepository(
  db: CoreDatabase,
  ports: GeocodingPorts,
  options: GeocodingRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  async function geocodeVenue(
    venueId: number,
    actor: GeocodingActor,
  ): Promise<GeocodeVenueResult> {
    const context = venueContext(db, venueId);
    const address = context.address?.trim() ?? "";
    if (address.length === 0) {
      return {
        kind: "unavailable",
        reason: "The venue has no address to geocode.",
      };
    }
    const boundingBox = boundsFor(context);
    if (boundingBox === null) {
      return {
        kind: "unavailable",
        reason: `${context.seasonName} has no complete geocoding bounding box.`,
      };
    }

    const existing = coordinateForVenue(db, venueId);
    // AE10 applies even after an address edit flags the hand-placed pin: a
    // provider must never silently replace an organizer's work. The organizer
    // resolves that review explicitly through verifyVenueCoordinate.
    if (existing?.source === "organizer-verified") {
      return {
        kind: "preserved",
        coordinate: existing,
        reason:
          "An organizer-verified coordinate is never overwritten by geocoding.",
      };
    }
    if (
      existing?.source === "geocoded" &&
      existing.status === "verified" &&
      existing.addressAtGeocode === address
    ) {
      return {
        kind: "cached",
        coordinate: existing,
        reason: "The verified coordinate is already cached for this address.",
      };
    }

    let outcome: LocateOutcome;
    try {
      outcome = await ports.geo.locate({
        address,
        boundingBox,
        localityName: context.localityName ?? undefined,
      });
    } catch {
      return {
        kind: "unavailable",
        reason: `${ports.geo.name} failed before returning a geocoding outcome.`,
      };
    }
    if (outcome.kind === "unavailable") {
      return { kind: "unavailable", reason: outcome.reason };
    }

    return db.transaction(
      (tx) => {
        const current = venueContext(tx, venueId);
        if (
          current.venueVersion !== context.venueVersion ||
          current.address?.trim() !== address
        ) {
          return {
            kind: "unavailable" as const,
            reason:
              "The venue changed while geocoding; retry with the current address.",
          };
        }
        const coordinateNow = coordinateForVenue(tx, venueId);
        if (coordinateNow?.source === "organizer-verified") {
          return {
            kind: "preserved" as const,
            coordinate: coordinateNow,
            reason:
              "An organizer verified the coordinate while geocoding was in progress.",
          };
        }

        const stored = storeOutcome(tx, {
          venueId,
          address,
          provider: ports.geo.name,
          actor,
          outcome,
          boundingBox,
          updatedAt: now(),
        });
        return {
          kind: "stored" as const,
          coordinate: stored,
          reason: outcome.reason,
        };
      },
      { behavior: "immediate" },
    );
  }

  function verifyVenueCoordinate(
    venueId: number,
    coordinate: Coordinates,
    actor: GeocodingActor,
    version: number,
  ): VenueCoordinate {
    return db.transaction(
      (tx) => {
        const context = venueContext(tx, venueId);
        const boundingBox = boundsFor(context);
        if (boundingBox === null) {
          throw new GeocodingLifecycleError(
            `${context.seasonName} has no complete geocoding bounding box.`,
          );
        }
        const boxName = context.localityName ?? context.seasonName;
        const verdict = verifyOrganizerCoordinate(
          {
            ...coordinate,
            ref: actor === null ? "organizer/manual" : `organizer/${actor}`,
          },
          { boundingBox },
        );
        if (verdict.status === "rejected") {
          throw new GeocodingLifecycleError(
            verdict.code === "out-of-bounds"
              ? `The organizer pin is outside the ${boxName} bounding box.`
              : verdict.reason,
          );
        }

        const stamp = now();
        const claimed = tx
          .update(venues)
          .set({
            version: sql`${venues.version} + 1`,
            updatedAt: stamp,
          })
          .where(and(eq(venues.id, venueId), eq(venues.version, version)))
          .run();
        if (claimed.changes !== 1) {
          throw new GeocodingConflictError(venueId, ["version"]);
        }

        return upsertCoordinate(tx, {
          venueId,
          latitude: verdict.coordinate.latitude,
          longitude: verdict.coordinate.longitude,
          source: "organizer-verified",
          precision: null,
          provider: "organizer",
          ref: verdict.coordinate.ref,
          crossCheckDistanceM: null,
          status: "verified",
          rejectionCode: null,
          addressAtGeocode: context.address?.trim() ?? "",
          updatedAt: stamp,
          updatedBy: actor,
        });
      },
      { behavior: "immediate" },
    );
  }

  function listVenuesNeedingCoordinateReview(
    seasonId: number,
  ): VenueCoordinateReview[] {
    return db
      .select({ venue: venues, coordinate: venueCoordinates })
      .from(venueCoordinates)
      .innerJoin(venues, eq(venues.id, venueCoordinates.venueId))
      .where(
        and(
          eq(venues.seasonId, seasonId),
          eq(venueCoordinates.status, "needs-review"),
        ),
      )
      .orderBy(venues.id)
      .all()
      .map(({ venue, coordinate }) => ({
        venueId: venue.id,
        title: venue.title,
        address: venue.address,
        coordinate,
      }));
  }

  function publishableCoordinate(venueId: number): Coordinates | null {
    const coordinate = db
      .select({
        latitude: venueCoordinates.latitude,
        longitude: venueCoordinates.longitude,
      })
      .from(venueCoordinates)
      .where(
        and(
          eq(venueCoordinates.venueId, venueId),
          eq(venueCoordinates.status, "verified"),
        ),
      )
      .get();
    const latitude = coordinate?.latitude;
    const longitude = coordinate?.longitude;
    if (latitude == null || longitude == null) return null;
    return { latitude, longitude };
  }

  return Object.freeze({
    geocodeVenue,
    verifyVenueCoordinate,
    listVenuesNeedingCoordinateReview,
    publishableCoordinate,
  });
}

export type GeocodingRepository = ReturnType<typeof createGeocodingRepository>;

function venueContext(db: CoreExecutor, venueId: number): VenueSeasonContext {
  const context = db
    .select({
      venueId: venues.id,
      venueVersion: venues.version,
      title: venues.title,
      address: venues.address,
      seasonId: seasons.id,
      seasonName: seasons.displayName,
      localityName: seasons.localityName,
      boundsNorth: seasons.boundsNorth,
      boundsSouth: seasons.boundsSouth,
      boundsEast: seasons.boundsEast,
      boundsWest: seasons.boundsWest,
    })
    .from(venues)
    .innerJoin(seasons, eq(seasons.id, venues.seasonId))
    .where(eq(venues.id, venueId))
    .get();
  if (context === undefined) {
    throw new GeocodingLifecycleError(`Venue ${venueId} does not exist.`);
  }
  return context;
}

function boundsFor(context: VenueSeasonContext) {
  const { boundsNorth, boundsSouth, boundsEast, boundsWest } = context;
  if (
    boundsNorth === null ||
    boundsSouth === null ||
    boundsEast === null ||
    boundsWest === null
  ) {
    return null;
  }
  return {
    north: boundsNorth,
    south: boundsSouth,
    east: boundsEast,
    west: boundsWest,
  };
}

function coordinateForVenue(
  db: CoreExecutor,
  venueId: number,
): VenueCoordinate | undefined {
  return db
    .select()
    .from(venueCoordinates)
    .where(eq(venueCoordinates.venueId, venueId))
    .get();
}

interface StoreOutcomeInput {
  readonly venueId: number;
  readonly address: string;
  readonly provider: string;
  readonly actor: GeocodingActor;
  readonly outcome: Exclude<LocateOutcome, { kind: "unavailable" }>;
  readonly boundingBox: NonNullable<ReturnType<typeof boundsFor>>;
  readonly updatedAt: Date;
}

function storeOutcome(
  db: CoreExecutor,
  input: StoreOutcomeInput,
): VenueCoordinate {
  const { venueId, address, provider, actor, outcome, boundingBox, updatedAt } =
    input;
  if (outcome.kind === "not-found" || outcome.kind === "refused") {
    return upsertCoordinate(db, {
      venueId,
      latitude: null,
      longitude: null,
      source: "geocoded",
      precision: null,
      provider,
      ref: null,
      crossCheckDistanceM: null,
      status: outcome.kind === "not-found" ? "pending" : "rejected",
      rejectionCode: outcome.kind,
      addressAtGeocode: address,
      updatedAt,
      updatedBy: actor,
    });
  }

  const verdict = verifyGeocodedCoordinate(outcome.candidate, {
    boundingBox,
    crossCheck: outcome.crossCheck,
  });
  const distance = crossCheckDistance(outcome);
  const validCandidate = isValidCoordinate(outcome.candidate);
  let rejectionCode: CoordinateRejectionCode | null =
    verdict.status === "rejected" ? verdict.code : null;
  if (
    rejectionCode === null &&
    outcome.candidate.precision === "parcel" &&
    distance !== null &&
    distance > MAX_PARCEL_CROSS_CHECK_DISTANCE_M
  ) {
    rejectionCode = "cross-check-distance";
  }

  return upsertCoordinate(db, {
    venueId,
    latitude: validCandidate ? outcome.candidate.latitude : null,
    longitude: validCandidate ? outcome.candidate.longitude : null,
    source: "geocoded",
    precision: outcome.candidate.precision,
    provider,
    ref: outcome.candidate.ref,
    crossCheckDistanceM: distance,
    status: rejectionCode === null ? "verified" : "needs-review",
    rejectionCode,
    addressAtGeocode: address,
    updatedAt,
    updatedBy: actor,
  });
}

function crossCheckDistance(
  outcome: Extract<LocateOutcome, { kind: "located" }>,
): number | null {
  if (
    outcome.crossCheck === null ||
    !isValidCoordinate(outcome.candidate) ||
    !isValidCoordinate(outcome.crossCheck)
  ) {
    return null;
  }
  return haversineDistanceMeters(outcome.candidate, outcome.crossCheck);
}

type CoordinateWrite = Omit<VenueCoordinate, "id" | "version">;

function upsertCoordinate(
  db: CoreExecutor,
  values: CoordinateWrite,
): VenueCoordinate {
  return db
    .insert(venueCoordinates)
    .values(values)
    .onConflictDoUpdate({
      target: venueCoordinates.venueId,
      set: {
        latitude: values.latitude,
        longitude: values.longitude,
        source: values.source,
        precision: values.precision,
        provider: values.provider,
        ref: values.ref,
        crossCheckDistanceM: values.crossCheckDistanceM,
        status: values.status,
        rejectionCode: values.rejectionCode,
        addressAtGeocode: values.addressAtGeocode,
        updatedAt: values.updatedAt,
        updatedBy: values.updatedBy,
        version: sql`${venueCoordinates.version} + 1`,
      },
    })
    .returning()
    .get();
}
