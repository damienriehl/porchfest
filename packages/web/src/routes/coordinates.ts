import {
  GeocodingConflictError,
  GeocodingLifecycleError,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  type CoreRuntime,
  type GeocodeVenueResult,
  type Season,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  renderCoordinatesPage,
  type GeocodeSeasonCounts,
} from "../views/coordinates.js";
import {
  findSeason,
  notFound,
  positiveInteger,
  readFields,
  redirect,
  unauthorized,
} from "./admin-http.js";
import { preflightMapPublication } from "./map.js";

export const COORDINATES_PATH = "/seasons/:id/coordinates";
export const VERIFY_COORDINATE_PATH =
  "/seasons/:id/coordinates/:venueId/verify";
export const GEOCODE_SEASON_PATH = "/seasons/:id/coordinates/geocode";
export const PUBLISH_MAP_PATH = "/seasons/:id/map/publish";
export const UNPUBLISH_MAP_PATH = "/seasons/:id/map/unpublish";

// 20 × (the 1 s Nominatim interval + provider latency) stays comfortably
// below common proxy timeouts while keeping organizer retries manageable.
const GEOCODE_SEASON_BATCH_SIZE = 20;
const geocodingSeasonsInProgress = new Set<number>();

interface CoordinateRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}

export function registerCoordinateRoutes(
  options: CoordinateRouteOptions,
): void {
  options.routes.register({
    method: "GET",
    path: COORDINATES_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context)) {
        return options.routes.organizerGetRefusal(context);
      }
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("No such season or venue.");
      return coordinatePage(options, season, 200, {
        notice: publicationNotice(context.req.query("map")),
      });
    },
  });

  options.routes.register({
    method: "POST",
    path: VERIFY_COORDINATE_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("No such season or venue.");
      const venueId = positiveInteger(context.req.param("venueId"));
      if (venueId === null) return notFound("No such season or venue.");
      let venue;
      try {
        venue = options.core.seasons.getVenue(venueId);
      } catch (error) {
        if (error instanceof SeasonLifecycleError)
          return notFound("No such season or venue.");
        throw error;
      }
      if (venue.seasonId !== season.id)
        return notFound("No such season or venue.");
      const fields = await readFields(context);
      const latitude = finiteNumber(fields.latitude);
      const longitude = finiteNumber(fields.longitude);
      const version = positiveInteger(fields.version);
      if (latitude === null || longitude === null || version === null) {
        return coordinatePage(options, season, 400, {
          error: "Latitude, longitude, and a valid venue version are required.",
        });
      }
      try {
        options.core.geocoding.verifyVenueCoordinate(
          venueId,
          { latitude, longitude },
          organizer.id,
          version,
        );
      } catch (error) {
        if (error instanceof GeocodingLifecycleError) {
          return coordinatePage(options, season, 409, { error: error.message });
        }
        if (error instanceof GeocodingConflictError) {
          return coordinatePage(options, season, 409, {
            error:
              "Someone else changed this venue. Review its current version before trying again.",
          });
        }
        throw error;
      }
      return redirect(`/seasons/${season.id}/coordinates`);
    },
  });

  options.routes.register({
    method: "POST",
    path: GEOCODE_SEASON_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("No such season or venue.");
      if (!options.core.ports.geo.configured) {
        return coordinatePage(options, season, 409, {
          error:
            "Geocoding is not configured. Set GEO_PROVIDER before running season geocoding.",
        });
      }
      if (geocodingSeasonsInProgress.has(season.id)) {
        return coordinatePage(options, season, 409, {
          error:
            "Geocoding is already running for this season. Wait for it to finish before trying again.",
        });
      }

      const counts: GeocodeSeasonCounts = {
        stored: 0,
        cached: 0,
        preserved: 0,
        needsReview: 0,
        unavailable: 0,
        remaining: 0,
      };
      geocodingSeasonsInProgress.add(season.id);
      try {
        const verified = options.core.geocoding.publishableCoordinatesForSeason(
          season.id,
        );
        const eligible = options.core.seasons
          .listSeasonVenues(season.id)
          .filter(
            (venue) =>
              venue.status !== "withdrawn" &&
              venue.canonicalVenueId === null &&
              !verified.has(venue.id),
          );
        const batch = eligible.slice(0, GEOCODE_SEASON_BATCH_SIZE);
        // Deliberately sequential. Nominatim permits one request per second per
        // IP, and the shared adapter enforces that delay between these awaits.
        for (const [index, venue] of batch.entries()) {
          let result: GeocodeVenueResult;
          try {
            result = await options.core.geocoding.geocodeVenue(
              venue.id,
              organizer.id,
            );
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
              const reason = error.message.trim() || error.name;
              counts.remaining = eligible.length - index;
              console.error(
                `season ${season.id} geocoding configuration fault: ${reason}`,
              );
              return coordinatePage(options, season, 409, {
                error: `Season geocoding stopped because its configuration is invalid: ${reason} Fix the season locality and bounding-box fields in Season settings & state, then run again.`,
                counts,
              });
            }
            throw error;
          }
          if (result.kind === "unavailable") {
            counts.unavailable += 1;
          } else if (result.kind === "preserved") {
            counts.preserved += 1;
          } else if (result.kind === "cached") {
            counts.cached += 1;
          } else if (result.coordinate.status === "verified") {
            counts.stored += 1;
          } else {
            counts.needsReview += 1;
          }
        }
        counts.remaining = eligible.length - batch.length;
        return coordinatePage(
          options,
          options.core.seasons.getSeason(season.id),
          200,
          { counts },
        );
      } finally {
        geocodingSeasonsInProgress.delete(season.id);
      }
    },
  });

  registerPublicationAction(options, PUBLISH_MAP_PATH, "publish");
  registerPublicationAction(options, UNPUBLISH_MAP_PATH, "unpublish");
}

function registerPublicationAction(
  options: CoordinateRouteOptions,
  path: string,
  action: "publish" | "unpublish",
): void {
  options.routes.register({
    method: "POST",
    path,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("No such season or venue.");
      const fields = await readFields(context);
      const version = positiveInteger(fields.version);
      if (version === null) {
        return coordinatePage(options, season, 400, {
          error: "A valid season version is required.",
        });
      }
      try {
        if (action === "publish") {
          const eventCity = fields.event_city?.trim() ?? "";
          const eventState = fields.event_state?.trim() ?? "";
          const preflight = preflightMapPublication(options.core, {
            ...season,
            eventCity,
            eventState,
          });
          if (!preflight.ok) {
            return coordinatePage(options, season, 409, {
              error: preflight.error,
            });
          }
          options.core.seasons.publishSeasonMap(season.id, version, {
            eventCity,
            eventState,
          });
        } else {
          options.core.seasons.unpublishSeasonMap(season.id, version);
        }
      } catch (error) {
        if (
          error instanceof SeasonActionError ||
          error instanceof SeasonLifecycleError
        ) {
          return coordinatePage(
            options,
            options.core.seasons.getSeason(season.id),
            409,
            { error: error.message },
          );
        }
        if (error instanceof SeasonConflictError) {
          return coordinatePage(
            options,
            options.core.seasons.getSeason(season.id),
            409,
            {
              error:
                "Someone else changed the season. Review the current publication state before trying again.",
            },
          );
        }
        throw error;
      }
      return redirect(`/seasons/${season.id}/coordinates?map=${action}ed`);
    },
  });
}

function coordinatePage(
  options: CoordinateRouteOptions,
  season: Season,
  status: number,
  message: {
    readonly error?: string;
    readonly notice?: string;
    readonly counts?: GeocodeSeasonCounts;
  } = {},
): Response {
  const rows = options.core.geocoding.listVenuesNeedingCoordinateReview(
    season.id,
  );
  return new Response(
    renderCoordinatesPage({
      season,
      rows,
      geoConfigured: options.core.ports.geo.configured,
      csrf: {
        verify: options.csrfTokenFor(VERIFY_COORDINATE_PATH),
        geocode: options.csrfTokenFor(GEOCODE_SEASON_PATH),
        publish: options.csrfTokenFor(PUBLISH_MAP_PATH),
        unpublish: options.csrfTokenFor(UNPUBLISH_MAP_PATH),
      },
      ...message,
    }),
    { status, headers: adminHeaders() },
  );
}

function finiteNumber(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicationNotice(value: string | undefined): string | undefined {
  if (value === "published") return "The public map is published.";
  if (value === "unpublished") return "The public map is unpublished.";
  return undefined;
}
