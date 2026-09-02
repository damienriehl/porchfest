import {
  UnconfiguredAntibotGuard,
  type UnconfiguredAntibotGuardOptions,
} from "@porchfest/antibot";
import {
  isSeasonActionLegal,
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  zonedWallClockToUtc,
  SeasonActionError,
  SeasonLifecycleError,
  type AntibotClientChallenge,
  type AntibotResult,
  type CoreRuntime,
  type HostSignupInput,
  type PerformerSignupInput,
  type Season,
} from "@porchfest/core";
import { readFileSync } from "node:fs";
import type { Context } from "hono";
import type { RouteRegistry } from "../router/registry.js";
import { renderHostForm } from "../views/host-form.js";
import { renderPerformerForm } from "../views/performer-form.js";
import {
  firstValue,
  renderConfirmationPage,
  renderHostPreview,
  renderHostSubmission,
  renderPerformerPreview,
  renderPerformerSubmission,
  renderSignupSeasonPage,
  type SignupError,
  type SignupValues,
} from "../views/signup-view.js";
import { HOST_SIGNUP_PATH, PERFORMER_SIGNUP_PATH } from "./signup-paths.js";
import { normalizedHttpUrl, tokenizeLinks } from "./http-links.js";

export const CONTACT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signupStyles = readFileSync(
  new URL("../../assets/signup.css", import.meta.url),
  "utf8",
);
const signupPreviewScript = readFileSync(
  new URL("../../assets/signup-preview.js", import.meta.url),
  "utf8",
);

export interface SignupRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
  readonly resolveSocketPeerAddress: (context: Context) => string | null;
  readonly trustedProxyHops?: number;
  readonly guardOptions?: UnconfiguredAntibotGuardOptions;
}

type SignupKind = "host" | "performer";
type SignupStatus = 200 | 201 | 400 | 403 | 409 | 415 | 422 | 429 | 503;

/** Longest a participant answer may be, by field. Without a ceiling one 51 KiB
 *  body of "&" persists in full and re-renders as ~256 KiB of "&amp;". */
const MAX_FIELD_LENGTH: Readonly<Record<string, number>> = {
  contact_name: 200,
  contact_email: 320,
  contact_phone: 60,
  venue_title: 200,
  venue_address: 300,
  space_description: 4000,
  requested_act_names: 2000,
  genre_preferences: 2000,
  notes: 4000,
  act_name: 200,
  genres: 300,
  description: 4000,
  links: 2000,
  house_preference: 2000,
  shared_member_note: 2000,
  performer_notes: 4000,
  duration_minutes: 10,
  season_id: 20,
  antibot_token: 4096,
};
const DEFAULT_MAX_FIELD_LENGTH = 300;

/** A performer plays one festival day. Twelve windows is generous; without a cap
 *  a sub-64 KiB body can echo ~869 KiB of markup or insert ~880 rows. */
const MAX_AVAILABILITY_PAIRS = 12;

/** A field the participant may only send once. Repeats are a refusal, never a
 *  silent first-wins: `has_power=yes&has_power=maybe` must not persist "yes". */
const SINGLE_VALUE_FIELDS = [
  "season_id",
  "contact_name",
  "contact_email",
  "contact_phone",
  "venue_title",
  "venue_address",
  "space_description",
  "has_power",
  "rain_backup",
  "requested_act_names",
  "genre_preferences",
  "notes",
  "act_name",
  "genres",
  "description",
  "links",
  "duration_minutes",
  "requires_amplification",
  "house_preference",
  "shared_member_note",
  "can_lend_gear",
  "performer_notes",
  "antibot_token",
  "website",
  "_csrf",
] as const;

export function registerSignupRoutes(options: SignupRouteOptions): void {
  const unconfiguredGuard = new UnconfiguredAntibotGuard({
    ...options.guardOptions,
    trustedProxyHops: options.trustedProxyHops,
  });
  const challenge = options.core.ports.antibot.clientChallenge;

  options.routes.register({
    method: "GET",
    path: "/signup/assets/signup.css",
    tier: "public",
    handler: () =>
      new Response(signupStyles, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/css; charset=UTF-8",
        },
      }),
  });
  options.routes.register({
    method: "GET",
    path: "/signup/assets/signup-preview.js",
    tier: "public",
    handler: () =>
      new Response(signupPreviewScript, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/javascript; charset=UTF-8",
        },
      }),
  });

  for (const kind of ["host", "performer"] as const) {
    const path = kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;

    options.routes.register({
      method: "GET",
      path,
      tier: "public",
      handler: (context: Context) => {
        const requested = context.req.query("season");
        if (requested === undefined) {
          return absentSeasonResponse(options, challenge, kind);
        }
        const resolved = resolveSeason(options, requested);
        if (!resolved.ok) {
          return seasonPageResponse(
            options,
            kind,
            [resolved.error],
            resolved.status,
          );
        }
        return formResponse(
          options,
          challenge,
          kind,
          { season_id: [requested] },
          [],
          200,
          resolved.season,
        );
      },
    });

    options.routes.register({
      method: "POST",
      path,
      tier: "public",
      handler: async (context: Context) => {
        const read = await readSignupValues(context);
        if (!read.ok) {
          return formResponse(
            options,
            challenge,
            kind,
            read.values,
            [read.error],
            read.status,
            null,
          );
        }
        const values = read.values;

        // 1. Volume first, and for EVERY submission. An external provider caps
        //    token reuse, not request rate, so gating this behind the
        //    unconfigured branch would leave a configured deployment uncapped.
        const capped = applyRateLimit(options, unconfiguredGuard, context);
        if (capped) {
          return formResponse(
            options,
            challenge,
            kind,
            values,
            [capped.error],
            capped.status,
            null,
          );
        }

        const resolved = resolveSeason(
          options,
          firstValue(values, "season_id"),
        );
        if (!resolved.ok) {
          return formResponse(
            options,
            challenge,
            kind,
            values,
            [resolved.error],
            resolved.status,
            null,
          );
        }
        const season = resolved.season;

        // 2. Validate before the challenge is spent. A single-use token claimed
        //    ahead of validation turns "fix the field and resubmit" into a
        //    deterministic replay refusal, which is the opposite of the promise
        //    that a rejected form keeps every answer and can be retried.
        const validation =
          kind === "host"
            ? validateHost(values, season)
            : validatePerformer(values, season);
        if (!validation.ok) {
          return formResponse(
            options,
            challenge,
            kind,
            values,
            validation.errors,
            422,
            season,
          );
        }

        const antibot = await checkAntibot(
          options,
          unconfiguredGuard,
          context,
          values,
        );
        if (!antibot.passed) {
          // The token this page carried is spent, whatever the outcome. Re-render
          // without it so the widget mints a fresh one instead of replaying.
          const retryValues = withoutChallengeToken(values);
          return formResponse(
            options,
            challenge,
            kind,
            retryValues,
            [antibot.error],
            antibot.status,
            season,
          );
        }

        let recordId: number;
        try {
          if (validation.kind === "host") {
            const signup = options.core.seasons.createHostSignup(
              validation.input,
            );
            recordId = signup.venue.id;
          } else {
            const signup = options.core.seasons.createPerformerSignup(
              validation.input,
            );
            recordId = signup.act.id;
          }
        } catch (error) {
          return persistenceRefusal(
            options,
            challenge,
            kind,
            values,
            season,
            error,
          );
        }

        return htmlResponse(
          renderConfirmationPage({
            title:
              kind === "host"
                ? "Your porch signup is in."
                : "Your performer signup is in.",
            kind,
            seasonId: season.id,
            recordId,
            publicSiteUrl: season.publicSiteUrl,
            emailConfigured: options.core.ports.email.configured,
            preview:
              kind === "host"
                ? renderHostPreview(values)
                : renderPerformerPreview(values),
            submission:
              kind === "host"
                ? renderHostSubmission(values)
                : renderPerformerSubmission(values, season.timezone),
          }),
          201,
          challenge,
        );
      },
    });
  }
}

function absentSeasonResponse(
  options: SignupRouteOptions,
  challenge: AntibotClientChallenge | null,
  kind: SignupKind,
): Response {
  const openSeasons = options.core.setup
    .listSeasons()
    .filter((season) => isSeasonActionLegal(season.state, "signup"));
  if (openSeasons.length === 1) {
    const season = openSeasons[0];
    if (season) {
      return formResponse(
        options,
        challenge,
        kind,
        { season_id: [String(season.id)] },
        [],
        200,
        season,
      );
    }
  }

  // A missing or ambiguous season has no safe submission target. Stop before
  // rendering participant fields so the page never invites answers it cannot save.
  return seasonPageResponse(options, kind, [], 200, openSeasons);
}

function seasonPageResponse(
  options: SignupRouteOptions,
  kind: SignupKind,
  errors: readonly SignupError[],
  status: SignupStatus,
  knownOpenSeasons?: readonly Season[],
): Response {
  const openSeasons =
    knownOpenSeasons ??
    options.core.setup
      .listSeasons()
      .filter((season) => isSeasonActionLegal(season.state, "signup"));
  return htmlResponse(
    renderSignupSeasonPage({ kind, seasons: openSeasons, errors }),
    status,
    null,
  );
}

// ---------------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------------

type ReadResult =
  | { readonly ok: true; readonly values: SignupValues }
  | {
      readonly ok: false;
      readonly values: SignupValues;
      readonly error: SignupError;
      readonly status: SignupStatus;
    };

async function readSignupValues(context: Context): Promise<ReadResult> {
  const mediaType = (context.req.header("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  // The central registry also admits JSON, because organizer routes will want
  // it. These two are form-only: accepting JSON here means formData() throws
  // and the participant gets a 500 instead of an answer.
  if (
    mediaType !== "application/x-www-form-urlencoded" &&
    mediaType !== "multipart/form-data"
  ) {
    return {
      ok: false,
      values: {},
      status: 415,
      error: {
        field: "signup-form",
        label: "Submission",
        message: "Send this form as a normal form submission.",
      },
    };
  }

  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return {
      ok: false,
      values: {},
      status: 400,
      error: {
        field: "signup-form",
        label: "Submission",
        message: "That submission could not be read. Please try again.",
      },
    };
  }

  // Null-prototype: on a plain object `values["__proto__"]` resolves to
  // Object.prototype, `??=` declines to assign, and `.push` throws a public 500.
  const values: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [name, value] of form) {
    if (typeof value !== "string") {
      // A file part where text belongs used to be dropped silently, so the
      // signup could succeed with the field simply missing.
      return {
        ok: false,
        values,
        status: 422,
        error: {
          field: name,
          label: "Submission",
          message: "That field must be text, not a file.",
        },
      };
    }
    (values[name] ??= []).push(value);
  }

  for (const field of SINGLE_VALUE_FIELDS) {
    if ((values[field]?.length ?? 0) > 1) {
      return {
        ok: false,
        values: without(values, field),
        status: 422,
        error: {
          field,
          label: "Submission",
          message: "That answer arrived more than once. Send it only once.",
        },
      };
    }
  }

  for (const [field, submitted] of Object.entries(values)) {
    const limit = MAX_FIELD_LENGTH[field] ?? DEFAULT_MAX_FIELD_LENGTH;
    if (submitted.some((entry) => entry.length > limit)) {
      return {
        ok: false,
        // The over-limit value is deliberately not echoed back into the page.
        values: without(values, field),
        status: 422,
        error: {
          field,
          label: "Submission",
          message: `Shorten this answer to ${limit} characters or fewer.`,
        },
      };
    }
  }

  const pairs = Math.max(
    values.availability_start?.length ?? 0,
    values.availability_end?.length ?? 0,
  );
  if (pairs > MAX_AVAILABILITY_PAIRS) {
    return {
      ok: false,
      values: without(
        without(values, "availability_start"),
        "availability_end",
      ),
      status: 422,
      error: {
        field: "availability_start",
        label: "Available time windows",
        message: `Send at most ${MAX_AVAILABILITY_PAIRS} availability windows.`,
      },
    };
  }

  return { ok: true, values };
}

function without(values: SignupValues, field: string): SignupValues {
  const copy: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const [name, entry] of Object.entries(values)) {
    if (name !== field) copy[name] = entry;
  }
  return copy;
}

function withoutChallengeToken(values: SignupValues): SignupValues {
  return without(values, "antibot_token");
}

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

type SeasonResolution =
  | { readonly ok: true; readonly season: Season }
  | {
      readonly ok: false;
      readonly error: SignupError;
      readonly status: SignupStatus;
    };

function resolveSeason(
  options: SignupRouteOptions,
  raw: string,
): SeasonResolution {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return {
      ok: false,
      status: 400,
      error: seasonError("Choose an open Porchfest season before signing up."),
    };
  }

  let season: Season;
  try {
    season = options.core.seasons.getSeason(id);
  } catch {
    return {
      ok: false,
      status: 400,
      error: seasonError("That Porchfest season could not be found."),
    };
  }

  // Checked here so a closed season never renders a long, hopeful form. The
  // authoritative race-safe check still runs inside the creation transaction.
  if (!isSeasonActionLegal(season.state, "signup")) {
    return {
      ok: false,
      status: 409,
      error: seasonError("Signups are not open for that Porchfest season."),
    };
  }

  return { ok: true, season };
}

function seasonError(message: string): SignupError {
  return { field: "signup-form", label: "Porchfest season", message };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type HostValidation =
  | {
      readonly ok: true;
      readonly kind: "host";
      readonly input: HostSignupInput;
    }
  | { readonly ok: false; readonly errors: readonly SignupError[] };
type PerformerValidation =
  | {
      readonly ok: true;
      readonly kind: "performer";
      readonly input: PerformerSignupInput;
    }
  | { readonly ok: false; readonly errors: readonly SignupError[] };

function validateHost(values: SignupValues, season: Season): HostValidation {
  const errors: SignupError[] = [];
  const contact = validateContact(values, errors);
  const title = required(
    values,
    "venue_title",
    "Porch name",
    "Add a public name for your porch.",
    errors,
  );
  const address = required(
    values,
    "venue_address",
    "Street address",
    "Add a street address so performers can find your porch.",
    errors,
  );
  const spaceDescription = required(
    values,
    "space_description",
    "Performance space",
    "Describe where performers and neighbors will gather.",
    errors,
  );
  const hasPower = requiredBoolean(
    values,
    "has_power",
    "Electrical power",
    errors,
  );
  const rainBackup = requiredBoolean(
    values,
    "rain_backup",
    "Rain backup",
    errors,
  );
  const gear = enumSet(values, "gear", "Gear", venueGearValues, errors);
  const drinks = enumSet(values, "drinks", "Drinks", venueDrinkValues, errors);
  const amenities = enumSet(
    values,
    "amenities",
    "Amenities",
    venueAmenityValues,
    errors,
  );
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    kind: "host",
    input: {
      seasonId: season.id,
      contact,
      venue: {
        title,
        address,
        spaceDescription,
        hasPower,
        rainBackup,
        notes: optional(values, "notes"),
        requestedActNames: optional(values, "requested_act_names"),
        genrePreferences: optional(values, "genre_preferences"),
      },
      gear,
      drinks,
      amenities,
    },
  };
}

function validatePerformer(
  values: SignupValues,
  season: Season,
): PerformerValidation {
  const errors: SignupError[] = [];
  const contact = validateContact(values, errors);
  const name = required(
    values,
    "act_name",
    "Act name",
    "Add the name neighbors will see for your act.",
    errors,
  );
  const genre = required(
    values,
    "genres",
    "Genres",
    "Add at least one genre so hosts know what you play.",
    errors,
  );
  const description = required(
    values,
    "description",
    "Act description",
    "Describe your act for hosts and the public map.",
    errors,
  );
  const links = firstValue(values, "links").trim();
  validateLinks(links, errors);
  const durationMinutes = parseDuration(values, errors);
  const requiresAmplification = requiredBoolean(
    values,
    "requires_amplification",
    "Amplification",
    errors,
  );
  const canLendGear = requiredBoolean(
    values,
    "can_lend_gear",
    "Lend gear",
    errors,
  );
  const availabilities = parseAvailabilities(values, season, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    kind: "performer",
    input: {
      seasonId: season.id,
      contact,
      act: {
        name,
        durationMinutes,
        requiresAmplification,
        genre,
        description,
        links,
        housePreference: optional(values, "house_preference"),
        sharedMemberNote: optional(values, "shared_member_note"),
        canLendGear,
        notes: optional(values, "performer_notes"),
      },
      availabilities,
    },
  };
}

function validateContact(values: SignupValues, errors: SignupError[]) {
  const name = required(
    values,
    "contact_name",
    "Your name",
    "Add the name organizers should use when they contact you.",
    errors,
  );
  const email = required(
    values,
    "contact_email",
    "Email",
    "Add an email address so the organizers can reach you.",
    errors,
  );
  if (email && !CONTACT_EMAIL_PATTERN.test(email)) {
    errors.push({
      field: "contact_email",
      label: "Email",
      message: "Enter an email address in the form name@example.com.",
    });
  }
  return { name, email, phone: optional(values, "contact_phone") };
}

function required(
  values: SignupValues,
  field: string,
  label: string,
  message: string,
  errors: SignupError[],
): string {
  const value = firstValue(values, field).trim();
  if (!value) errors.push({ field, label, message });
  return value;
}

function optional(values: SignupValues, field: string): string | null {
  const value = firstValue(values, field).trim();
  return value || null;
}

function requiredBoolean(
  values: SignupValues,
  field: string,
  label: string,
  errors: SignupError[],
): boolean {
  const value = firstValue(values, field);
  if (value !== "yes" && value !== "no") {
    errors.push({
      field,
      label,
      message: `Choose yes or no for ${label.toLowerCase()}.`,
    });
  }
  return value === "yes";
}

function enumSet<const Values extends readonly string[]>(
  values: SignupValues,
  field: string,
  label: string,
  allowed: Values,
  errors: SignupError[],
): Values[number][] {
  const submitted = [...new Set(values[field] ?? [])];
  if (submitted.some((value) => !allowed.includes(value))) {
    errors.push({
      field,
      label,
      message: `Choose only the listed ${label.toLowerCase()} options.`,
    });
    return [];
  }
  return submitted as Values[number][];
}

function parseDuration(values: SignupValues, errors: SignupError[]): number {
  const raw = firstValue(values, "duration_minutes").trim();
  const value = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 5 || value > 240) {
    errors.push({
      field: "duration_minutes",
      label: "Set duration",
      message: "Enter a set duration from 5 to 240 minutes.",
    });
    return 0;
  }
  return value;
}

function validateLinks(links: string, errors: SignupError[]): void {
  if (!links) return;
  // Unlike map serialization, a public signup rejects the whole field when
  // any token is invalid so the participant can correct it immediately.
  const invalid = tokenizeLinks(links).some(
    (candidate) => normalizedHttpUrl(candidate) === null,
  );
  if (invalid) {
    errors.push({
      field: "links",
      label: "Music and website links",
      message: "Use only links that begin with http:// or https://.",
    });
  }
}

function parseAvailabilities(
  values: SignupValues,
  season: Season,
  errors: SignupError[],
): PerformerSignupInput["availabilities"] {
  const starts = values.availability_start ?? [];
  const ends = values.availability_end ?? [];
  const windows: { startsAt: Date; endsAt: Date }[] = [];
  const seen = new Set<string>();
  const count = Math.max(starts.length, ends.length);
  const availabilityError = (message: string): void => {
    errors.push({
      field: "availability_start",
      label: "Available time windows",
      message,
    });
  };

  for (let index = 0; index < count; index += 1) {
    const startValue = starts[index]?.trim() ?? "";
    const endValue = ends[index]?.trim() ?? "";
    if (!startValue && !endValue) continue;

    // The browser sends a bare wall clock with no offset. The season's timezone
    // is what turns it into the instant the performer actually meant.
    const startsAt = zonedWallClockToUtc(startValue, season.timezone);
    const endsAt = zonedWallClockToUtc(endValue, season.timezone);
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      availabilityError(
        "Give each availability window a real start and a later end time.",
      );
      return [];
    }

    const key = `${startsAt.valueOf()}-${endsAt.valueOf()}`;
    if (seen.has(key)) {
      // The database refuses duplicates too, but that arrives as a storage
      // failure and tells the participant to retry something that can never work.
      availabilityError(
        "Two availability windows are identical. Remove or change one.",
      );
      return [];
    }
    seen.add(key);
    windows.push({ startsAt, endsAt });
  }

  if (windows.length === 0) {
    availabilityError(
      "Add at least one time window when your whole act can perform.",
    );
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Anti-bot
// ---------------------------------------------------------------------------

function applyRateLimit(
  options: SignupRouteOptions,
  guard: UnconfiguredAntibotGuard,
  context: Context,
): { readonly error: SignupError; readonly status: SignupStatus } | null {
  const { decision } = guard.consumeAttempt({
    socketPeerAddress: options.resolveSocketPeerAddress(context),
    forwardedFor: context.req.header("x-forwarded-for"),
  });
  if (decision.allowed) return null;
  return {
    status: 429,
    error: {
      field: "signup-form",
      label: "Verification",
      message:
        "Too many signup attempts arrived from this address. Wait a minute, then try again.",
    },
  };
}

async function checkAntibot(
  options: SignupRouteOptions,
  guard: UnconfiguredAntibotGuard,
  context: Context,
  values: SignupValues,
): Promise<
  | { readonly passed: true }
  | {
      readonly passed: false;
      readonly error: SignupError;
      readonly status: SignupStatus;
    }
> {
  const ipAddress = guard.resolveAddress({
    socketPeerAddress: options.resolveSocketPeerAddress(context),
    forwardedFor: context.req.header("x-forwarded-for"),
  });

  let result: AntibotResult;
  try {
    result = await options.core.ports.antibot.verify({
      token: optional(values, "antibot_token"),
      ipAddress,
    });
  } catch {
    return unavailable();
  }

  switch (result.status) {
    case "passed":
      return { passed: true };
    case "not-configured": {
      // The per-IP cap already ran for every submission; only the honeypot is
      // left, and consuming a second attempt here would halve the real limit.
      if (guard.checkHoneypot(firstValue(values, "website"))) {
        return { passed: true };
      }
      return {
        passed: false,
        status: 400,
        error: {
          field: "signup-form",
          label: "Verification",
          message:
            "Verification could not accept this signup. Clear the website field and try again.",
        },
      };
    }
    case "failed":
      return {
        passed: false,
        status: 403,
        error: {
          field: "antibot_token",
          label: "Verification",
          message:
            "That verification could not be accepted. Complete the check again — your answers are still here.",
        },
      };
    case "unavailable":
      return unavailable();
    default:
      return assertNever(result);
  }
}

function unavailable(): {
  readonly passed: false;
  readonly error: SignupError;
  readonly status: SignupStatus;
} {
  return {
    passed: false,
    status: 503,
    error: {
      field: "antibot_token",
      label: "Verification",
      message:
        "Verification is unavailable right now. Your answers are still here; try again in a moment.",
    },
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown anti-bot result: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function persistenceRefusal(
  options: SignupRouteOptions,
  challenge: AntibotClientChallenge | null,
  kind: SignupKind,
  values: SignupValues,
  season: Season | null,
  error: unknown,
): Response {
  const lifecycle =
    error instanceof SeasonActionError || error instanceof SeasonLifecycleError;
  const formError: SignupError = {
    field: "signup-form",
    label: "Porchfest season",
    message: lifecycle
      ? "Signups are not open for that Porchfest season. Your answers are still here."
      : "The signup could not be saved. Your answers are still here; try again.",
  };
  return formResponse(
    options,
    challenge,
    kind,
    values,
    [formError],
    lifecycle ? 409 : 503,
    season,
  );
}

function formResponse(
  options: SignupRouteOptions,
  challenge: AntibotClientChallenge | null,
  kind: SignupKind,
  values: SignupValues,
  errors: readonly SignupError[],
  status: SignupStatus,
  season: Season | null,
): Response {
  const path = kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;
  const shared = {
    seasonId: firstValue(values, "season_id"),
    csrfToken: options.csrfTokenFor(path),
    values,
    errors,
    challenge,
    timezone: season?.timezone ?? null,
    season,
  };
  const rendered =
    kind === "host"
      ? renderHostForm(shared)
      : renderPerformerForm({
          ...shared,
          timeSlots:
            season === null ? [] : options.core.setup.listTimeSlots(season.id),
        });
  return htmlResponse(rendered, status, challenge);
}

function htmlResponse(
  html: string,
  status: SignupStatus,
  challenge: AntibotClientChallenge | null,
): Response {
  return new Response(html, {
    status,
    headers: {
      // KTD8: participant responses echo back what the participant typed.
      "cache-control": "no-store, private",
      "content-security-policy": contentSecurityPolicy(challenge),
      "content-type": "text/html; charset=UTF-8",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Self-only, widened by exactly what the configured challenge asks for and
 * nothing else. An unconfigured deployment keeps the strict policy; the adapter
 * names its own origins, so `web` never has to know a provider's domain.
 */
function contentSecurityPolicy(
  challenge: AntibotClientChallenge | null,
): string {
  const join = (extra: readonly string[]): string =>
    ["'self'", ...extra].join(" ");
  const csp = challenge?.contentSecurityPolicy;
  return [
    `default-src 'self'`,
    `script-src ${join(csp?.scriptSrc ?? [])}`,
    `frame-src ${join(csp?.frameSrc ?? [])}`,
    `connect-src ${join(csp?.connectSrc ?? [])}`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join("; ");
}
