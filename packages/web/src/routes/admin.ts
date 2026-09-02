// U5 PR 1: the way in. Sign in with a bootstrap or invite link, sign out, and one
// authenticated landing page that proves the trust tier is real. The queue,
// record editor and lifecycle actions arrive in later PRs on this foundation.

import {
  AccessError,
  isSeasonActionLegal,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  SeasonSetupError,
  type Season,
  type CoreRuntime,
} from "@porchfest/core";
import type { Context } from "hono";
import {
  adminHeaders,
  currentOrganizer,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  type SessionCookieOptions,
} from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  findSeason,
  notFound,
  positiveInteger,
  redirect,
} from "./admin-http.js";
import { seasonSignupUrls } from "./signup-paths.js";
import { formatZonedDateInput } from "../timezone.js";
import { renderQueuePage } from "../views/admin-records.js";
import {
  renderAdminShell,
  renderFirstRunConflictPage,
  renderSeasonsPage,
  renderSetupPage,
  renderSignInPage,
  type SetupConflictDetail,
  type SetupFieldError,
} from "../views/admin-shell.js";

export const ADMIN_PATH = "/admin";
export const ADMIN_SIGN_IN_PATH = "/admin/sign-in";
export const ADMIN_SIGN_OUT_PATH = "/admin/sign-out";
export const ADMIN_SETUP_PATH = "/admin/setup";
const ADMIN_SEASONS_PATH = "/admin/seasons";
const ADMIN_NEW_SEASON_PATH = "/admin/seasons/new";
const ADMIN_EDIT_SEASON_PATH = "/admin/seasons/:id/edit";

export interface AdminRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
  readonly publicBaseUrl: string | null;
  readonly resolveSocketPeerAddress: (context: Context) => string | null;
  readonly cookie?: SessionCookieOptions;
}

export function registerAdminRoutes(options: AdminRouteOptions): void {
  options.routes.register({
    method: "GET",
    path: ADMIN_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      // The registry already refused an unauthenticated caller; resolving again
      // is how the page knows whose name to show.
      const organizer = currentOrganizer(options.core, context);
      // R34: an install that works and then strands the organizer with nowhere to
      // open a season is a failed install. Send them straight there.
      if (options.core.setup.needsFirstRun()) {
        return new Response(null, {
          status: 303,
          headers: {
            ...adminHeaders(),
            "content-type": "text/plain; charset=UTF-8",
            location: ADMIN_SETUP_PATH,
          },
        });
      }
      if (!organizer) {
        return options.routes.organizerGetRefusal(context);
      }

      // Which season the organizer is working. With one season the choice is
      // obvious; the query parameter is what makes a second season navigable.
      const requested = Number(context.req.query("season") ?? "");
      const seasonId =
        Number.isSafeInteger(requested) && requested > 0
          ? requested
          : mostRecentSeasonId(options.core);
      if (seasonId === null) {
        return new Response(
          renderAdminShell({
            organizer,
            csrfToken: options.csrfTokenFor(ADMIN_SIGN_OUT_PATH),
          }),
          { status: 200, headers: adminHeaders() },
        );
      }

      let season;
      try {
        season = options.core.seasons.getSeason(seasonId);
      } catch {
        return new Response("No such season.", {
          status: 404,
          headers: {
            ...adminHeaders(),
            "content-type": "text/plain; charset=UTF-8",
          },
        });
      }

      return new Response(
        renderQueuePage({
          organizerName: organizer.displayName,
          seasonName: season.displayName,
          seasonId: season.id,
          seasonState: season.state,
          signupUrls: seasonSignupUrls(options.publicBaseUrl, season.id),
          publicMapUrl: season.publicMapUrl,
          correctionsClosed: !isSeasonActionLegal(season.state, "correction"),
          items: options.core.queue.listForOrganizer(season.id, organizer.id),
          changeRequests: options.core.changeRequests.listPendingForSeason(
            season.id,
          ),
          csrfToken: options.csrfTokenFor("/admin/queue/dismiss"),
          applyChangeCsrfToken: options.csrfTokenFor(
            "/admin/change-requests/:id/apply",
          ),
          rejectChangeCsrfToken: options.csrfTokenFor(
            "/admin/change-requests/:id/reject",
          ),
          signOutCsrf: options.csrfTokenFor(ADMIN_SIGN_OUT_PATH),
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_SIGN_IN_PATH,
    tier: "public",
    handler: (context: Context) => {
      const token = context.req.query("token") ?? "";
      const invited = options.core.access.hasAnyOrganizer();
      return new Response(
        renderSignInPage({
          token,
          csrfToken: options.csrfTokenFor(ADMIN_SIGN_IN_PATH),
          // Before the first organizer exists the person holding the link has to
          // name themselves; an invite already knows the address.
          needsEmail: !invited,
          errors: [],
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_SIGN_IN_PATH,
    tier: "public",
    handler: async (context: Context) => {
      let fields: Readonly<Record<string, string>>;
      try {
        fields = await readFields(context);
      } catch {
        return signInRefusal(options, "", "That form could not be read.");
      }
      const token = fields.token ?? "";
      const displayName = fields.display_name ?? "";
      const email = fields.email ?? "";

      if (!token) {
        return signInRefusal(options, "", "That sign-in link is incomplete.");
      }

      try {
        const session = options.core.access.redeemLink({
          token,
          displayName,
          email: email || undefined,
          fromIp: options.resolveSocketPeerAddress(context),
        });
        return new Response(null, {
          status: 303,
          headers: {
            ...adminHeaders(),
            "content-type": "text/plain; charset=UTF-8",
            location: ADMIN_PATH,
            "set-cookie": serializeSessionCookie(
              session.token,
              session.expiresAt,
              options.cookie,
            ),
          },
        });
      } catch (error) {
        return signInRefusal(options, token, describe(error));
      }
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_SETUP_PATH,
    tier: "organizer",
    handler: () => {
      if (!options.core.setup.needsFirstRun()) {
        return redirect(ADMIN_SEASONS_PATH);
      }
      return new Response(
        renderSetupPage({
          csrfToken: options.csrfTokenFor(ADMIN_SETUP_PATH),
          values: { open_signups: "yes" },
          errors: [],
          mode: "first",
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_SETUP_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      let fields: Readonly<Record<string, string>>;
      try {
        fields = await readFields(context);
      } catch {
        return setupRefusal(options, {}, [
          { field: "display_name", message: "That form could not be read." },
        ]);
      }

      try {
        const { season } = options.core.setup.createFirstSeason(
          setupInputFrom(fields),
        );
        return redirect(`${ADMIN_PATH}?season=${season.id}`);
      } catch (error) {
        if (error instanceof SeasonSetupError && error.field === "firstRun") {
          return new Response(renderFirstRunConflictPage(), {
            status: 409,
            headers: adminHeaders(),
          });
        }
        if (error instanceof SeasonSetupError) {
          return setupRefusal(options, fields, [
            { field: formFieldFor(error.field), message: error.message },
          ]);
        }
        return seasonCreationUnavailable(options, fields, "first");
      }
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_SEASONS_PATH,
    tier: "organizer",
    handler: () => {
      const seasons = options.core.setup.listSeasons();
      if (seasons.length === 0) return redirect(ADMIN_SETUP_PATH);
      return new Response(renderSeasonsPage({ seasons }), {
        status: 200,
        headers: adminHeaders(),
      });
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_NEW_SEASON_PATH,
    tier: "organizer",
    handler: () => {
      if (options.core.setup.needsFirstRun()) return redirect(ADMIN_SETUP_PATH);
      return new Response(
        renderSetupPage({
          csrfToken: options.csrfTokenFor(ADMIN_NEW_SEASON_PATH),
          values: { open_signups: "yes" },
          errors: [],
          mode: "additional",
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_NEW_SEASON_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      let fields: Readonly<Record<string, string>>;
      try {
        fields = await readFields(context);
      } catch {
        return additionalSeasonRefusal(options, {}, [
          { field: "display_name", message: "That form could not be read." },
        ]);
      }

      try {
        const { season } = options.core.setup.createAdditionalSeason(
          setupInputFrom(fields),
          fields.confirm_duplicate_year === "yes",
        );
        return redirect(`${ADMIN_PATH}?season=${season.id}`);
      } catch (error) {
        if (error instanceof SeasonSetupError) {
          if (error.field === "additionalSeason") {
            return redirect(ADMIN_SETUP_PATH);
          }
          return additionalSeasonRefusal(options, fields, [
            { field: formFieldFor(error.field), message: error.message },
          ]);
        }
        return seasonCreationUnavailable(options, fields, "additional");
      }
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_EDIT_SEASON_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound();
      if (!isSeasonActionLegal(season.state, "correction")) {
        return eventDetailsPage(options, season, {
          status: 409,
          formError: `A season in state ${season.state} no longer allows event-detail corrections.`,
        });
      }
      return eventDetailsPage(options, season, {
        status: 200,
        saved: context.req.query("saved") === "1",
      });
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_EDIT_SEASON_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound();
      let fields: Readonly<Record<string, string>>;
      try {
        fields = await readFields(context);
      } catch {
        return eventDetailsPage(options, season, {
          status: 400,
          submitted: {},
          formError:
            "That form could not be read. Review the refreshed values before trying again.",
        });
      }
      if (!isSeasonActionLegal(season.state, "correction")) {
        return eventDetailsPage(options, season, {
          status: 409,
          submitted: fields,
          formError: `A season in state ${season.state} no longer allows event-detail corrections.`,
        });
      }
      const version = positiveInteger(fields.version);
      if (version === null) {
        return eventDetailsPage(options, season, {
          status: 400,
          submitted: fields,
          formError:
            "A valid season version is required. Reload the editor before trying again.",
        });
      }

      try {
        options.core.setup.updateSeasonDetails(
          season.id,
          version,
          setupInputFrom(fields),
          fields.confirm_duplicate_year === "yes",
        );
      } catch (error) {
        if (error instanceof SeasonSetupError) {
          return eventDetailsPage(options, season, {
            status: 422,
            submitted: fields,
            errors: [
              { field: formFieldFor(error.field), message: error.message },
            ],
          });
        }
        if (error instanceof SeasonConflictError) {
          const current = options.core.seasons.getSeason(season.id);
          const stored = seasonValues(options.core, current);
          return eventDetailsPage(options, current, {
            status: 409,
            submitted: fields,
            conflicts: setupConflicts(fields, stored),
            formError: `Someone else changed these event details. Compare your submitted values with stored version ${current.version} before trying again. Nothing from the stale form was saved.`,
          });
        }
        if (
          error instanceof SeasonLifecycleError ||
          error instanceof SeasonActionError
        ) {
          const current = options.core.seasons.getSeason(season.id);
          return eventDetailsPage(options, current, {
            status: 409,
            submitted: fields,
            formError: error.message,
          });
        }
        throw error;
      }
      return redirect(`/admin/seasons/${season.id}/edit?saved=1`);
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_SIGN_OUT_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      options.core.access.endSession(readSessionCookie(context));
      return new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders(),
          "content-type": "text/plain; charset=UTF-8",
          location: ADMIN_SIGN_IN_PATH,
          "set-cookie": serializeExpiredSessionCookie(options.cookie),
        },
      });
    },
  });
}

/**
 * Parse the form once into plain string fields, mirroring how the signup routes
 * read a body. Iterating rather than reaching for FormData's accessor also keeps
 * the route-boundary scanner happy: it flags that accessor's name anywhere in
 * `web` because it cannot tell a form read from a route registration.
 *
 * This copy stays separate from `./admin-http.js` on purpose: it TRIMS, because the
 * setup and sign-in forms it parses treat a stray space in an event name or an email
 * as a typo. The record and retention forms deliberately do not trim, because a
 * record's stored text belongs to the organizer. Folding this into the shared helper
 * would silently change what those forms store.
 */
async function readFields(
  context: Context,
): Promise<Readonly<Record<string, string>>> {
  const form = await context.req.formData();
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of form) {
    if (typeof value === "string" && fields[name] === undefined) {
      fields[name] = value.trim();
    }
  }
  return fields;
}

/** The season an organizer lands on when they did not name one. */
function mostRecentSeasonId(core: AdminRouteOptions["core"]): number | null {
  return core.setup.listSeasons()[0]?.id ?? null;
}

/** Only a complete box is a box; a partly-filled one is a validation error rather
 *  than three-quarters of a sanity check. */
function boundsFrom(fields: Readonly<Record<string, string>>) {
  const parts = ["bounds_north", "bounds_south", "bounds_east", "bounds_west"];
  if (parts.every((name) => !(fields[name] ?? "").trim())) return null;
  // A blank edge must reach validation as NaN, not as Number("") === 0. A zero
  // edge is a real coordinate, so the partly-filled box would sail through and
  // R17 would then sanity-check pins against a box spanning half the planet.
  const edge = (name: string): number => {
    const raw = (fields[name] ?? "").trim();
    return raw === "" ? Number.NaN : Number(raw);
  };
  return {
    north: edge("bounds_north"),
    south: edge("bounds_south"),
    east: edge("bounds_east"),
    west: edge("bounds_west"),
  };
}

function setupInputFrom(fields: Readonly<Record<string, string>>) {
  return {
    year: Number(fields.year ?? ""),
    displayName: fields.display_name ?? "",
    timezone: fields.timezone ?? "",
    eventDate: fields.event_date ?? "",
    eventCity: fields.event_city ?? "",
    eventState: fields.event_state ?? "",
    signupOpensOn: fields.signup_opens_on ?? null,
    signupClosesOn: fields.signup_closes_on ?? null,
    timeSlots: [1, 2, 3, 4, 5, 6].map((index) => ({
      startsAt: fields[`slot_start_${index}`] ?? "",
      endsAt: fields[`slot_end_${index}`] ?? "",
    })),
    localityName: fields.locality_name ?? null,
    bounds: boundsFrom(fields),
    publicSiteUrl: fields.public_site_url ?? null,
    publicMapUrl: fields.public_map_url ?? null,
    senderName: fields.sender_name ?? null,
    senderEmail: fields.sender_email ?? null,
    openSignups: fields.open_signups === "yes",
  };
}

interface EventDetailsPageState {
  readonly status: number;
  readonly submitted?: Readonly<Record<string, string>>;
  readonly conflicts?: readonly SetupConflictDetail[];
  readonly formError?: string;
  readonly saved?: boolean;
  readonly errors?: readonly SetupFieldError[];
}

function eventDetailsPage(
  options: AdminRouteOptions,
  season: Season,
  state: EventDetailsPageState,
): Response {
  return new Response(
    renderSetupPage({
      csrfToken: options.csrfTokenFor(ADMIN_EDIT_SEASON_PATH),
      values: state.submitted ?? seasonValues(options.core, season),
      errors: state.errors ?? [],
      mode: "edit",
      seasonId: season.id,
      version: season.version,
      formError: state.formError,
      saved: state.saved,
      conflicts: state.conflicts,
    }),
    { status: state.status, headers: adminHeaders() },
  );
}

const SETUP_CONFLICT_FIELDS: readonly {
  readonly name: string;
  readonly label: string;
}[] = [
  { name: "display_name", label: "Season name" },
  { name: "year", label: "Year" },
  { name: "event_date", label: "Event date" },
  { name: "event_city", label: "Event city" },
  { name: "event_state", label: "Event state or region" },
  { name: "timezone", label: "Timezone" },
  { name: "signup_opens_on", label: "Signups open" },
  { name: "signup_closes_on", label: "Signups close" },
  ...[1, 2, 3, 4, 5, 6].flatMap((index) => [
    { name: `slot_start_${index}`, label: `Slot ${index} starts` },
    { name: `slot_end_${index}`, label: `Slot ${index} ends` },
  ]),
  { name: "locality_name", label: "Locality" },
  { name: "bounds_north", label: "North edge" },
  { name: "bounds_south", label: "South edge" },
  { name: "bounds_west", label: "West edge" },
  { name: "bounds_east", label: "East edge" },
  { name: "public_site_url", label: "Public site" },
  { name: "public_map_url", label: "Public map" },
  { name: "sender_name", label: "Sender name" },
  { name: "sender_email", label: "Sender address" },
];

function setupConflicts(
  submitted: Readonly<Record<string, string>>,
  stored: Readonly<Record<string, string>>,
): SetupConflictDetail[] {
  return SETUP_CONFLICT_FIELDS.filter(
    (field) => (submitted[field.name] ?? "") !== (stored[field.name] ?? ""),
  ).map((field) => ({
    label: field.label,
    attempted: submitted[field.name] ?? "",
    stored: stored[field.name] ?? "",
  }));
}

function seasonValues(core: CoreRuntime, season: Season) {
  const values: Record<string, string> = {
    display_name: season.displayName,
    year: String(season.year),
    event_date: season.eventDate ?? "",
    event_city: season.eventCity,
    event_state: season.eventState,
    timezone: season.timezone,
    signup_opens_on: season.signupOpensAt
      ? formatZonedDateInput(season.signupOpensAt, season.timezone)
      : "",
    signup_closes_on: season.signupClosesAt
      ? formatZonedDateInput(season.signupClosesAt, season.timezone)
      : "",
    locality_name: season.localityName ?? "",
    bounds_north: decimal(season.boundsNorth),
    bounds_south: decimal(season.boundsSouth),
    bounds_east: decimal(season.boundsEast),
    bounds_west: decimal(season.boundsWest),
    public_site_url: season.publicSiteUrl ?? "",
    public_map_url: season.publicMapUrl ?? "",
    sender_name: season.senderName ?? "",
    sender_email: season.senderEmail ?? "",
  };
  core.setup.listTimeSlots(season.id).forEach((slot, index) => {
    values[`slot_start_${index + 1}`] = zonedTime(
      slot.startsAt,
      season.timezone,
    );
    values[`slot_end_${index + 1}`] = zonedTime(slot.endsAt, season.timezone);
  });
  return values;
}

function zonedTime(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")}`;
}

function decimal(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Map a domain field name onto the form control that carries it, so the error
 *  summary's anchor lands on something that exists. */
function formFieldFor(field: string): string {
  const slot = /^timeSlots\.(\d+)$/.exec(field);
  if (slot) return `slot_start_${Number(slot[1]) + 1}`;
  const map: Readonly<Record<string, string>> = {
    displayName: "display_name",
    eventDate: "event_date",
    eventCity: "event_city",
    eventState: "event_state",
    signupOpensOn: "signup_opens_on",
    signupClosesOn: "signup_closes_on",
    localityName: "locality_name",
    publicSiteUrl: "public_site_url",
    publicMapUrl: "public_map_url",
    senderName: "sender_name",
    senderEmail: "sender_email",
    confirmDuplicateYear: "confirm_duplicate_year",
    "bounds.north": "bounds_north",
    "bounds.south": "bounds_south",
    "bounds.east": "bounds_east",
    "bounds.west": "bounds_west",
  };
  return map[field] ?? field;
}

function setupRefusal(
  options: AdminRouteOptions,
  values: Readonly<Record<string, string>>,
  errors: readonly SetupFieldError[],
): Response {
  return new Response(
    renderSetupPage({
      csrfToken: options.csrfTokenFor(ADMIN_SETUP_PATH),
      values,
      errors,
      mode: "first",
    }),
    { status: 422, headers: adminHeaders() },
  );
}

function additionalSeasonRefusal(
  options: AdminRouteOptions,
  values: Readonly<Record<string, string>>,
  errors: readonly SetupFieldError[],
): Response {
  return new Response(
    renderSetupPage({
      csrfToken: options.csrfTokenFor(ADMIN_NEW_SEASON_PATH),
      values,
      errors,
      mode: "additional",
    }),
    { status: 422, headers: adminHeaders() },
  );
}

function seasonCreationUnavailable(
  options: AdminRouteOptions,
  values: Readonly<Record<string, string>>,
  mode: "first" | "additional",
): Response {
  const path = mode === "first" ? ADMIN_SETUP_PATH : ADMIN_NEW_SEASON_PATH;
  return new Response(
    renderSetupPage({
      csrfToken: options.csrfTokenFor(path),
      values,
      errors: [
        {
          field: "display_name",
          message:
            "The season service is unavailable right now. Your answers are still here; try again.",
        },
      ],
      mode,
    }),
    { status: 503, headers: adminHeaders() },
  );
}

function signInRefusal(
  options: AdminRouteOptions,
  token: string,
  message: string,
): Response {
  return new Response(
    renderSignInPage({
      token,
      csrfToken: options.csrfTokenFor(ADMIN_SIGN_IN_PATH),
      needsEmail: !options.core.access.hasAnyOrganizer(),
      errors: [message],
    }),
    { status: 403, headers: adminHeaders() },
  );
}

/**
 * Say which way the link failed without saying anything a guesser could use.
 * "Already used" and "expired" are both safe: the holder already had the token.
 * An unrecognized token gets the same wording as an expired one on purpose.
 */
function describe(error: unknown): string {
  if (!(error instanceof AccessError)) {
    return "That sign-in link could not be used.";
  }
  switch (error.reason) {
    case "already-redeemed":
      return "That sign-in link has already been used. Ask an organizer for a new one.";
    case "revoked":
      return "That sign-in link was withdrawn. Ask an organizer for a new one.";
    case "deactivated":
      return "That organizer account is deactivated.";
    case "expired":
    case "invalid-token":
      return "That sign-in link is no longer valid. Ask an organizer for a new one.";
    default:
      return "That sign-in link could not be used.";
  }
}

/**
 * Print the first-boot login link. R9 forbids depending on the email adapter, so
 * the container log is the delivery channel: whoever can read the logs is
 * already the operator.
 */
export function announceBootstrapLink(
  core: CoreRuntime,
  publicBaseUrl: string | null,
  log: (message: string) => void = console.log,
): void {
  if (core.access.hasAnyOrganizer()) return;
  const { token } = core.access.issueBootstrapLink();
  const base = publicBaseUrl ?? "";
  log(
    [
      "",
      "  Porchfest has no organizer yet. Open this link to create the first one:",
      `    ${base}${ADMIN_SIGN_IN_PATH}?token=${token}`,
      "  It expires in an hour, works once, and dies as soon as an organizer exists.",
      "",
    ].join("\n"),
  );
}
