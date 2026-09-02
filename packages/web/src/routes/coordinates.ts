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
// Leave headroom below common request-proxy limits. If one provider call runs
// longer, its work keeps the season guard until it settles, but the organizer
// still receives a continuation response within this request budget.
const GEOCODE_SEASON_REQUEST_BUDGET_MS = 45_000;
const GEOCODE_REQUEST_BUDGET_EXCEEDED = Symbol(
  "geocode-request-budget-exceeded",
);
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
        nextAfterVenueId: null,
      };
      geocodingSeasonsInProgress.add(season.id);
      let releaseSeasonGuard = true;
      try {
        const fields = await readFields(context);
        const afterVenueId = positiveInteger(fields.after);
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
        const nextIndex =
          afterVenueId === null
            ? 0
            : eligible.findIndex((venue) => venue.id > afterVenueId);
        // A completed pass restarts from the beginning so transient failures
        // remain retryable without starving venues later in id order.
        const startIndex = nextIndex < 0 ? 0 : nextIndex;
        const batch = eligible.slice(
          startIndex,
          startIndex + GEOCODE_SEASON_BATCH_SIZE,
        );
        const requestDeadline = Date.now() + GEOCODE_SEASON_REQUEST_BUDGET_MS;
        // Deliberately sequential. Nominatim permits one request per second per
        // IP, and the shared adapter enforces that delay between these awaits.
        for (const [index, venue] of batch.entries()) {
          let result: GeocodeVenueResult;
          try {
            const operation = options.core.geocoding.geocodeVenue(
              venue.id,
              organizer.id,
            );
            const budgeted = await withinGeocodeRequestBudget(
              operation,
              requestDeadline - Date.now(),
            );
            if (budgeted === GEOCODE_REQUEST_BUDGET_EXCEEDED) {
              counts.remaining = eligible.length - (startIndex + index);
              counts.nextAfterVenueId =
                index === 0 ? afterVenueId : batch[index - 1]!.id;
              releaseSeasonGuard = false;
              void operation.then(
                () => releaseGeocodingSeason(season.id),
                (error: unknown) => {
                  console.error(
                    `season ${season.id} geocoding failed after its request budget: ${errorMessage(error)}`,
                  );
                  releaseGeocodingSeason(season.id);
                },
              );
              return coordinatePage(options, season, 409, {
                error:
                  "The geocoding provider is still finishing the current venue. Wait for it to finish, then run again to continue.",
                counts,
              });
            }
            result = budgeted;
          } catch (error) {
            if (error instanceof TypeError || error instanceof RangeError) {
              const reason = error.message.trim() || error.name;
              counts.remaining = eligible.length - (startIndex + index);
              counts.nextAfterVenueId =
                index === 0 ? afterVenueId : batch[index - 1]!.id;
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
        counts.remaining = Math.max(
          0,
          eligible.length - (startIndex + batch.length),
        );
        counts.nextAfterVenueId =
          counts.remaining > 0 ? (batch.at(-1)?.id ?? null) : null;
        return coordinatePage(
          options,
          options.core.seasons.getSeason(season.id),
          200,
          { counts },
        );
      } finally {
        if (releaseSeasonGuard) {
          releaseGeocodingSeason(season.id);
        }
      }
    },
  });

  registerPublicationAction(options, PUBLISH_MAP_PATH, "publish");
  registerPublicationAction(options, UNPUBLISH_MAP_PATH, "unpublish");
}

async function withinGeocodeRequestBudget<T>(
  operation: Promise<T>,
  remainingMs: number,
): Promise<T | typeof GEOCODE_REQUEST_BUDGET_EXCEEDED> {
  if (remainingMs <= 0) return GEOCODE_REQUEST_BUDGET_EXCEEDED;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof GEOCODE_REQUEST_BUDGET_EXCEEDED>((resolve) => {
        timeout = setTimeout(
          () => resolve(GEOCODE_REQUEST_BUDGET_EXCEEDED),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Route-boundary checks reserve method-shaped HTTP verbs for registration.
// This helper releases ordinary Set state without mimicking that API.
function releaseGeocodingSeason(seasonId: number): void {
  Reflect.apply(Set.prototype.delete, geocodingSeasonsInProgress, [seasonId]);
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
  const venues = options.core.seasons
    .listSeasonVenues(season.id)
    .filter(
      (venue) =>
        venue.status !== "withdrawn" && venue.canonicalVenueId === null,
    );
  return new Response(
    renderCoordinatesPage({
      season,
      rows,
      venues,
      verifiedCoordinates:
        options.core.geocoding.publishableCoordinatesForSeason(season.id),
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
