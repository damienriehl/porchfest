import {
  UnconfiguredAntibotGuard,
  resolveClientIp,
  type UnconfiguredAntibotGuardOptions,
} from "@porchfest/antibot";
import {
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  SeasonActionError,
  SeasonLifecycleError,
  type AntibotResult,
  type CoreRuntime,
  type HostSignupInput,
  type PerformerSignupInput,
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
  renderPerformerPreview,
  type SignupError,
  type SignupValues,
} from "../views/signup-view.js";
import { HOST_SIGNUP_PATH, PERFORMER_SIGNUP_PATH } from "./signup-paths.js";

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
type SignupStatus = 200 | 201 | 400 | 403 | 409 | 422 | 429 | 503;

export function registerSignupRoutes(options: SignupRouteOptions): void {
  const unconfiguredGuard = new UnconfiguredAntibotGuard({
    ...options.guardOptions,
    trustedProxyHops: options.trustedProxyHops,
  });

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
  options.routes.register({
    method: "GET",
    path: HOST_SIGNUP_PATH,
    tier: "public",
    handler: (context: Context) => {
      const seasonId = context.req.query("season") ?? "";
      const errors = validSeasonId(seasonId)
        ? []
        : [seasonError("Choose an open Porchfest season before signing up.")];
      return htmlResponse(
        renderHostForm({
          seasonId,
          csrfToken: options.csrfTokenFor(HOST_SIGNUP_PATH),
          challengeConfigured: options.core.ports.antibot.configured,
          errors,
        }),
        errors.length === 0 ? 200 : 400,
      );
    },
  });
  options.routes.register({
    method: "POST",
    path: HOST_SIGNUP_PATH,
    tier: "public",
    handler: async (context: Context) => {
      const values = await readSignupValues(context);
      const antibot = await checkAntibot(
        options,
        unconfiguredGuard,
        context,
        values,
      );
      if (!antibot.passed) {
        return hostFormResponse(
          options,
          values,
          [antibot.error],
          antibot.status,
        );
      }
      const validation = validateHost(values);
      if (!validation.ok) {
        return hostFormResponse(options, values, validation.errors, 422);
      }

      try {
        options.core.seasons.createHostSignup(validation.input);
      } catch (error) {
        return persistenceRefusal(options, "host", values, error);
      }
      return htmlResponse(
        renderConfirmationPage({
          title: "Your porch signup is in.",
          kind: "host",
          emailConfigured: options.core.ports.email.configured,
          preview: renderHostPreview(values),
        }),
        201,
      );
    },
  });
  options.routes.register({
    method: "GET",
    path: PERFORMER_SIGNUP_PATH,
    tier: "public",
    handler: (context: Context) => {
      const seasonId = context.req.query("season") ?? "";
      const errors = validSeasonId(seasonId)
        ? []
        : [seasonError("Choose an open Porchfest season before signing up.")];
      return htmlResponse(
        renderPerformerForm({
          seasonId,
          csrfToken: options.csrfTokenFor(PERFORMER_SIGNUP_PATH),
          challengeConfigured: options.core.ports.antibot.configured,
          errors,
        }),
        errors.length === 0 ? 200 : 400,
      );
    },
  });
  options.routes.register({
    method: "POST",
    path: PERFORMER_SIGNUP_PATH,
    tier: "public",
    handler: async (context: Context) => {
      const values = await readSignupValues(context);
      const antibot = await checkAntibot(
        options,
        unconfiguredGuard,
        context,
        values,
      );
      if (!antibot.passed) {
        return performerFormResponse(
          options,
          values,
          [antibot.error],
          antibot.status,
        );
      }
      const validation = validatePerformer(values);
      if (!validation.ok) {
        return performerFormResponse(options, values, validation.errors, 422);
      }

      try {
        options.core.seasons.createPerformerSignup(validation.input);
      } catch (error) {
        return persistenceRefusal(options, "performer", values, error);
      }
      return htmlResponse(
        renderConfirmationPage({
          title: "Your performer signup is in.",
          kind: "performer",
          emailConfigured: options.core.ports.email.configured,
          preview: renderPerformerPreview(values),
        }),
        201,
      );
    },
  });
}

async function readSignupValues(context: Context): Promise<SignupValues> {
  const form = await context.req.formData();
  const values: Record<string, string[]> = {};
  for (const [name, value] of form) {
    if (typeof value !== "string") continue;
    (values[name] ??= []).push(value);
  }
  return values;
}

function validateHost(
  values: SignupValues,
):
  | { readonly ok: true; readonly input: HostSignupInput }
  | { readonly ok: false; readonly errors: readonly SignupError[] } {
  const errors: SignupError[] = [];
  const seasonId = parseSeasonId(values, errors);
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
    input: {
      seasonId,
      contact,
      venue: {
        title,
        address,
        spaceDescription,
        hasPower,
        rainBackup,
        notes: optional(values, "notes"),
      },
      gear,
      drinks,
      amenities,
    },
  };
}

function validatePerformer(
  values: SignupValues,
):
  | { readonly ok: true; readonly input: PerformerSignupInput }
  | { readonly ok: false; readonly errors: readonly SignupError[] } {
  const errors: SignupError[] = [];
  const seasonId = parseSeasonId(values, errors);
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
  const availabilities = parseAvailabilities(values, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      seasonId,
      contact,
      act: {
        name,
        durationMinutes,
        requiresAmplification,
        genre,
        description,
        links,
        housePreference: optional(values, "house_preference"),
        canLendGear,
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
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({
      field: "contact_email",
      label: "Email",
      message: "Enter an email address in the form name@example.com.",
    });
  }
  return { name, email, phone: optional(values, "contact_phone") };
}

function parseSeasonId(values: SignupValues, errors: SignupError[]): number {
  const raw = firstValue(values, "season_id");
  if (!validSeasonId(raw)) {
    errors.push(
      seasonError("Choose an open Porchfest season before signing up."),
    );
    return 0;
  }
  return Number(raw);
}

function validSeasonId(raw: string): boolean {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0;
}

function seasonError(message: string): SignupError {
  return { field: "signup-form", label: "Porchfest season", message };
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
  const value = Number(firstValue(values, "duration_minutes"));
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
  const candidates = links.split(/\s+/).filter(Boolean);
  const invalid = candidates.some((candidate) => {
    try {
      const protocol = new URL(candidate).protocol;
      return protocol !== "http:" && protocol !== "https:";
    } catch {
      return true;
    }
  });
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
  errors: SignupError[],
): PerformerSignupInput["availabilities"] {
  const starts = values.availability_start ?? [];
  const ends = values.availability_end ?? [];
  const windows: { startsAt: Date; endsAt: Date }[] = [];
  const count = Math.max(starts.length, ends.length);
  for (let index = 0; index < count; index += 1) {
    const startValue = starts[index]?.trim() ?? "";
    const endValue = ends[index]?.trim() ?? "";
    if (!startValue && !endValue) continue;
    const startsAt = parseLocalDateTime(startValue);
    const endsAt = parseLocalDateTime(endValue);
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      errors.push({
        field: "availability_start",
        label: "Available time windows",
        message: "Give each availability window a start and a later end time.",
      });
      return [];
    }
    windows.push({ startsAt, endsAt });
  }
  if (windows.length === 0) {
    errors.push({
      field: "availability_start",
      label: "Available time windows",
      message: "Add at least one time window when your whole act can perform.",
    });
  }
  return windows;
}

function parseLocalDateTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00.000Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

async function checkAntibot(
  options: SignupRouteOptions,
  unconfiguredGuard: UnconfiguredAntibotGuard,
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
  const socketPeerAddress = options.resolveSocketPeerAddress(context);
  const forwardedFor = context.req.header("x-forwarded-for");
  const ipAddress = resolveClientIp({
    socketPeerAddress,
    forwardedFor,
    trustedProxyHops: options.trustedProxyHops,
  });
  let result: AntibotResult;
  try {
    result = await options.core.ports.antibot.verify({
      token: optional(values, "antibot_token"),
      ipAddress,
    });
  } catch {
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

  switch (result.status) {
    case "passed":
      return { passed: true };
    case "not-configured": {
      const fallback = unconfiguredGuard.check({
        socketPeerAddress,
        forwardedFor,
        honeypot: firstValue(values, "website"),
      });
      if (fallback.status === "passed") return { passed: true };
      return {
        passed: false,
        status: fallback.code === "rate-limited" ? 429 : 400,
        error: {
          field: "signup-form",
          label: "Verification",
          message:
            fallback.code === "rate-limited"
              ? "Too many signup attempts arrived from this address. Wait a minute, then try again."
              : "Verification could not accept this signup. Clear the website field and try again.",
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
          message: "Complete verification again before sending this signup.",
        },
      };
    case "unavailable":
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
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown anti-bot result: ${String(value)}`);
}

function persistenceRefusal(
  options: SignupRouteOptions,
  kind: SignupKind,
  values: SignupValues,
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
  const status: SignupStatus = lifecycle ? 409 : 503;
  return kind === "host"
    ? hostFormResponse(options, values, [formError], status)
    : performerFormResponse(options, values, [formError], status);
}

function hostFormResponse(
  options: SignupRouteOptions,
  values: SignupValues,
  errors: readonly SignupError[],
  status: SignupStatus,
): Response {
  return htmlResponse(
    renderHostForm({
      seasonId: firstValue(values, "season_id"),
      csrfToken: options.csrfTokenFor(HOST_SIGNUP_PATH),
      values,
      errors,
      challengeConfigured: options.core.ports.antibot.configured,
    }),
    status,
  );
}

function performerFormResponse(
  options: SignupRouteOptions,
  values: SignupValues,
  errors: readonly SignupError[],
  status: SignupStatus,
): Response {
  return htmlResponse(
    renderPerformerForm({
      seasonId: firstValue(values, "season_id"),
      csrfToken: options.csrfTokenFor(PERFORMER_SIGNUP_PATH),
      values,
      errors,
      challengeConfigured: options.core.ports.antibot.configured,
    }),
    status,
  );
}

function htmlResponse(html: string, status: SignupStatus): Response {
  return new Response(html, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "content-type": "text/html; charset=UTF-8",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
