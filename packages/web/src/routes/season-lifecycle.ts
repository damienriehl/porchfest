import {
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  type CoreRuntime,
  type Season,
  type SeasonState,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  renderSeasonLifecyclePage,
  SEASON_STATES,
} from "../views/season-lifecycle.js";
import { readFields, redirect, unauthorized } from "./admin-http.js";

export const SEASON_LIFECYCLE_PATH = "/admin/seasons/:id";
export const SEASON_TRANSITION_PATH = "/admin/seasons/:id/transition";

export function registerSeasonLifecycleRoutes(options: {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}): void {
  options.routes.register({
    method: "GET",
    path: SEASON_LIFECYCLE_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context))
        return options.routes.organizerGetRefusal(context);
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound();
      return seasonPage(
        options,
        season,
        200,
        undefined,
        context.req.query("transitioned") === "1",
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: SEASON_TRANSITION_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      if (!currentOrganizer(options.core, context)) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound();
      const fields = await readFields(context);
      const target = asSeasonState(fields.target_state);
      if (!target) {
        return seasonPage(
          options,
          season,
          400,
          `Unknown season state "${fields.target_state ?? ""}".`,
        );
      }
      const version = Number(fields.version ?? "");
      if (!Number.isSafeInteger(version) || version < 1) {
        return seasonPage(
          options,
          season,
          400,
          "A valid season version is required.",
        );
      }
      if (
        SEASON_STATES.indexOf(target) <= SEASON_STATES.indexOf(season.state)
      ) {
        return seasonPage(
          options,
          season,
          409,
          `A season in state ${season.state} cannot go back to ${target}.`,
        );
      }
      if (
        (target === "locked" || target === "archived") &&
        fields.confirmation !== "confirmed"
      ) {
        return seasonPage(
          options,
          season,
          400,
          `Confirm the move to ${target} before continuing.`,
        );
      }

      try {
        options.core.seasons.transitionSeason(season.id, version, target);
      } catch (error) {
        if (error instanceof SeasonActionError) {
          const current = options.core.seasons.getSeason(season.id);
          return seasonPage(
            options,
            current,
            409,
            `A season in state ${current.state} cannot go back to ${target}.`,
          );
        }
        if (error instanceof SeasonConflictError) {
          const current = options.core.seasons.getSeason(season.id);
          return seasonPage(
            options,
            current,
            409,
            `Someone else changed the season. Review the refreshed state and version ${current.version} before trying again.`,
          );
        }
        if (error instanceof SeasonLifecycleError) return notFound();
        throw error;
      }
      return redirect(`/admin/seasons/${season.id}?transitioned=1`);
    },
  });
}

function asSeasonState(value: string | undefined): SeasonState | null {
  return SEASON_STATES.find((state) => state === value) ?? null;
}

function findSeason(
  core: CoreRuntime,
  rawId: string | undefined,
): Season | null {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  try {
    return core.seasons.getSeason(id);
  } catch (error) {
    if (error instanceof SeasonLifecycleError) return null;
    throw error;
  }
}

function seasonPage(
  options: { readonly csrfTokenFor: (path: string) => string },
  season: Season,
  status: number,
  error?: string,
  transitioned = false,
): Response {
  return new Response(
    renderSeasonLifecyclePage({
      season,
      csrfToken: options.csrfTokenFor(SEASON_TRANSITION_PATH),
      error,
      transitioned,
    }),
    { status, headers: adminHeaders() },
  );
}

function notFound(): Response {
  return new Response("No such season.", {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
