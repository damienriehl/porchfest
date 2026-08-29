import {
  GeocodingConflictError,
  GeocodingLifecycleError,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  type CoreRuntime,
  type Season,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  renderCoordinatesPage,
  type GeocodeSeasonCounts,
} from "../views/coordinates.js";
import { readFields, redirect, unauthorized } from "./admin-http.js";

export const COORDINATES_PATH = "/seasons/:id/coordinates";
export const VERIFY_COORDINATE_PATH =
  "/seasons/:id/coordinates/:venueId/verify";
export const GEOCODE_SEASON_PATH = "/seasons/:id/coordinates/geocode";
export const PUBLISH_MAP_PATH = "/seasons/:id/map/publish";
export const UNPUBLISH_MAP_PATH = "/seasons/:id/map/unpublish";

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
      if (!season) return notFound();
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
      if (!season) return notFound();
      const venueId = positiveInteger(context.req.param("venueId"));
      if (venueId === null) return notFound();
      let venue;
      try {
        venue = options.core.seasons.getVenue(venueId);
      } catch (error) {
        if (error instanceof SeasonLifecycleError) return notFound();
        throw error;
      }
      if (venue.seasonId !== season.id) return notFound();
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
      if (!season) return notFound();
      if (!options.core.ports.geo.configured) {
        return coordinatePage(options, season, 409, {
          error:
            "Geocoding is not configured. Set GEO_PROVIDER before running season geocoding.",
        });
      }

      const counts: GeocodeSeasonCounts = {
        stored: 0,
        cached: 0,
        preserved: 0,
        needsReview: 0,
        unavailable: 0,
      };
      // Deliberately sequential. Nominatim permits one request per second per
      // IP, and the shared adapter enforces that delay between these awaits.
      for (const venue of options.core.seasons.listSeasonVenues(season.id)) {
        if (options.core.geocoding.publishableCoordinate(venue.id) !== null) {
          continue;
        }
        const result = await options.core.geocoding.geocodeVenue(
          venue.id,
          organizer.id,
        );
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
      return coordinatePage(
        options,
        options.core.seasons.getSeason(season.id),
        200,
        { counts },
      );
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
      if (!season) return notFound();
      const fields = await readFields(context);
      const version = positiveInteger(fields.version);
      if (version === null) {
        return coordinatePage(options, season, 400, {
          error: "A valid season version is required.",
        });
      }
      try {
        if (action === "publish") {
          options.core.seasons.publishSeasonMap(
            season.id,
            organizer.id,
            version,
          );
        } else {
          options.core.seasons.unpublishSeasonMap(
            season.id,
            organizer.id,
            version,
          );
        }
      } catch (error) {
        if (error instanceof SeasonActionError) {
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
  const rows = options.core.geocoding
    .listVenuesNeedingCoordinateReview(season.id)
    .map((row) => ({
      ...row,
      venueVersion: options.core.seasons.getVenue(row.venueId).version,
    }));
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

function findSeason(
  core: CoreRuntime,
  rawId: string | undefined,
): Season | null {
  const id = positiveInteger(rawId);
  if (id === null) return null;
  try {
    return core.seasons.getSeason(id);
  } catch (error) {
    if (error instanceof SeasonLifecycleError) return null;
    throw error;
  }
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function notFound(): Response {
  return new Response("No such season or venue.", {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
