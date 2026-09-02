import {
  UnconfiguredAntibotGuard,
  type UnconfiguredAntibotGuardOptions,
} from "@porchfest/antibot";
import {
  ChangeRequestTargetConflictError,
  ParticipantTokenError,
  RepositoryConflictError,
  SeasonActionError,
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  zonedWallClockToUtc,
  type AntibotClientChallenge,
  type AntibotResult,
  type CoreRuntime,
  type ParticipantRecordType,
  type ParticipantRecordView,
} from "@porchfest/core";
import type { Context } from "hono";
import {
  currentParticipant,
  readParticipantToken,
  serializeParticipantCookie,
  type SessionCookieOptions,
} from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import { contentSecurityPolicy } from "../security-headers.js";
import {
  renderParticipantAccessRequiredPage,
  renderRequestLinkPage,
  renderSelfServePage,
} from "../views/self-serve.js";
import {
  allValues,
  escapeHtml,
  firstValue,
  type SignupError,
  type SignupValues,
} from "../views/signup-view.js";
import {
  SELF_SERVE_CHANGE_REQUEST_PATH,
  SELF_SERVE_PATH,
  SELF_SERVE_REQUEST_PATH,
} from "./self-serve-paths.js";
import { CONTACT_EMAIL_PATTERN } from "./signup.js";
import { normalizedHttpUrl, tokenizeLinks } from "./http-links.js";

type SelfServeStatus = 200 | 202 | 400 | 403 | 409 | 422 | 429 | 503;

export interface SelfServeRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
  readonly publicBaseUrl: string;
  readonly resolveSocketPeerAddress: (context: Context) => string | null;
  readonly trustedProxyHops?: number;
  readonly guardOptions?: UnconfiguredAntibotGuardOptions;
  readonly cookie?: SessionCookieOptions;
  readonly dispatchDelivery?: (task: () => Promise<void>) => void;
}

export function registerSelfServeRoutes(options: SelfServeRouteOptions): void {
  const guard = new UnconfiguredAntibotGuard({
    ...options.guardOptions,
    trustedProxyHops: options.trustedProxyHops,
  });
  const challenge = options.core.ports.antibot.clientChallenge;

  options.routes.register({
    method: "GET",
    path: SELF_SERVE_REQUEST_PATH,
    tier: "public",
    handler: () => requestPage(options, challenge, 200),
  });

  options.routes.register({
    method: "POST",
    path: SELF_SERVE_REQUEST_PATH,
    tier: "public",
    handler: async (context: Context) => {
      const fields = await readFields(context);
      const { decision, ipAddress } = guard.consumeAttempt({
        socketPeerAddress: options.resolveSocketPeerAddress(context),
        forwardedFor: context.req.header("x-forwarded-for"),
      });
      if (!decision.allowed) {
        return requestPage(
          options,
          challenge,
          429,
          "Too many link requests arrived from this address. Wait a minute and try again.",
        );
      }

      const verification = await verifyRequest(
        options,
        guard,
        fields,
        ipAddress,
      );
      if (!verification.ok) {
        return requestPage(
          options,
          challenge,
          verification.status,
          verification.message,
        );
      }

      const issued = options.core.participantTokens.reissueForEmail(
        firstValue(fields, "email"),
      );
      (options.dispatchDelivery ?? dispatchLater)(() =>
        deliverReissues(options, issued),
      );

      // R31: roster existence, target throttling, and provider outcomes are all
      // intentionally absent from this response.
      return requestPage(options, challenge, 202, undefined, true);
    },
  });

  options.routes.register({
    method: "GET",
    path: SELF_SERVE_PATH,
    tier: "participant",
    handler: (context: Context) => {
      const token = readParticipantToken(context);
      const participant = currentParticipant(options.core, context);
      if (!token || !participant) return participantRefusal();
      if (context.req.query("token")) {
        return new Response(null, {
          status: 303,
          headers: participantHeaders(challenge, {
            location: SELF_SERVE_PATH,
            "set-cookie": serializeParticipantCookie(
              token,
              participant.expiresAt,
              options.cookie,
            ),
          }),
        });
      }
      return participantPage(options, token, context, 200);
    },
  });

  options.routes.register({
    method: "POST",
    path: SELF_SERVE_PATH,
    tier: "participant",
    handler: async (context: Context) => {
      const token = readParticipantToken(context);
      if (!token) return participantRefusal();
      const fields = await readFields(context);
      let view: ParticipantRecordView;
      try {
        view = options.core.participantTokens.read(token);
      } catch (error) {
        if (error instanceof ParticipantTokenError) return participantRefusal();
        throw error;
      }
      const unknown = unknownEditFields(fields, view.recordType);
      if (unknown.length > 0) {
        return participantPage(options, token, context, 422, [
          {
            field: "edit-form",
            label: "Submission",
            message: `This form cannot change ${unknown.join(", ")}.`,
          },
        ]);
      }
      const errors = validateEdit(fields, view.recordType);
      if (errors.length > 0) {
        return participantPage(options, token, context, 422, errors);
      }

      try {
        if (view.recordType === "venue") {
          options.core.participantTokens.update(token, {
            recordType: "venue",
            recordId: view.record.id,
            recordVersion: integer(fields, "record_version"),
            contactVersion: integer(fields, "contact_version"),
            contact: contactChanges(fields),
            record: {
              title: firstValue(fields, "venue_title").trim(),
              spaceDescription: optional(fields, "space_description"),
              hasPower: boolean(fields, "has_power"),
              rainBackup: boolean(fields, "rain_backup"),
              requestedActNames: optional(fields, "requested_act_names"),
              genrePreferences: optional(fields, "genre_preferences"),
              notes: optional(fields, "participant_notes"),
            },
            gear: allValues(fields, "gear"),
            drinks: allValues(fields, "drinks"),
            amenities: allValues(fields, "amenities"),
          });
        } else {
          options.core.participantTokens.update(token, {
            recordType: "act",
            recordId: view.record.id,
            recordVersion: integer(fields, "record_version"),
            contactVersion: integer(fields, "contact_version"),
            contact: contactChanges(fields),
            record: {
              name: firstValue(fields, "act_name").trim(),
              genre: firstValue(fields, "genres").trim(),
              description: firstValue(fields, "description").trim(),
              links: optional(fields, "links"),
              durationMinutes: integer(fields, "duration_minutes"),
              requiresAmplification: boolean(fields, "requires_amplification"),
              housePreference: optional(fields, "house_preference"),
              sharedMemberNote: optional(fields, "shared_member_note"),
              canLendGear: boolean(fields, "can_lend_gear"),
              notes: optional(fields, "participant_notes"),
            },
          });
        }
      } catch (error) {
        if (
          error instanceof RepositoryConflictError ||
          error instanceof SeasonActionError
        ) {
          return participantPage(options, token, context, 409, [
            {
              field: "edit-form",
              label: "Conflict",
              message:
                "Someone else changed this record after you opened it. Nothing was saved; review the current details and try again.",
            },
          ]);
        }
        if (error instanceof ParticipantTokenError) return participantRefusal();
        throw error;
      }
      return redirectParticipant("saved=1", challenge);
    },
  });

  options.routes.register({
    method: "POST",
    path: SELF_SERVE_CHANGE_REQUEST_PATH,
    tier: "participant",
    handler: async (context: Context) => {
      const token = readParticipantToken(context);
      const grant = currentParticipant(options.core, context);
      if (!token || !grant) return participantRefusal();
      const fields = await readFields(context);
      const kind = firstValue(fields, "kind");
      const recordVersion = integer(fields, "record_version");
      try {
        if (kind === "withdrawal") {
          options.core.changeRequests.record({
            seasonId: grant.seasonId,
            recordType: grant.recordType,
            recordId: grant.recordId,
            recordVersion,
            kind,
          });
        } else if (kind === "address" && grant.recordType === "venue") {
          const proposedAddress = firstValue(fields, "proposed_address").trim();
          if (!proposedAddress) {
            return participantPage(options, token, context, 422, [
              {
                field: "proposed_address",
                label: "Corrected venue address",
                message: "Enter the corrected venue address.",
              },
            ]);
          }
          options.core.changeRequests.record({
            seasonId: grant.seasonId,
            recordType: "venue",
            recordId: grant.recordId,
            recordVersion,
            kind,
            proposedAddress,
          });
        } else if (kind === "availability" && grant.recordType === "act") {
          const season = options.core.seasons.getSeason(grant.seasonId);
          const parsed = parseProposedAvailability(fields, season.timezone);
          if (!parsed.ok) {
            return participantPage(options, token, context, 422, [
              parsed.error,
            ]);
          }
          options.core.changeRequests.record({
            seasonId: grant.seasonId,
            recordType: "act",
            recordId: grant.recordId,
            recordVersion,
            kind,
            proposedAvailability: parsed.windows,
          });
        } else {
          return participantPage(options, token, context, 422, [
            {
              field: "request-change-heading",
              label: "Change request",
              message: "Choose a change this record can request.",
            },
          ]);
        }
      } catch (error) {
        if (error instanceof ChangeRequestTargetConflictError) {
          return participantPage(options, token, context, 409, [
            {
              field: "request-change-heading",
              label: "Change request",
              message:
                "This record changed before the request arrived. Nothing changed; review it and try again.",
            },
          ]);
        }
        if (error instanceof ParticipantTokenError) return participantRefusal();
        throw error;
      }
      return redirectParticipant("requested=1", challenge);
    },
  });
}

function dispatchLater(task: () => Promise<void>): void {
  setTimeout(() => {
    void task().catch(() => undefined);
  }, 0);
}

async function deliverReissues(
  options: SelfServeRouteOptions,
  issued: ReturnType<CoreRuntime["participantTokens"]["reissueForEmail"]>,
): Promise<void> {
  for (const link of issued) {
    const url = new URL(SELF_SERVE_PATH, options.publicBaseUrl);
    url.searchParams.set("token", link.token);
    const recordLabel = link.link.recordType === "venue" ? "porch" : "act";
    const text = `Hi ${link.displayName},\n\nUse this private link to view or update your ${recordLabel} signup:\n${url.toString()}\n\nThis link expires in seven days. If you did not request it, you can ignore this email.`;
    try {
      const result = await options.core.ports.email.deliver({
        recipients: [link.email],
        subject: "Your private Porchfest signup link",
        text,
        html: `<p>Hi ${escapeHtml(link.displayName)},</p><p>Use this private link to view or update your ${recordLabel} signup:</p><p><a href="${escapeHtml(url.toString())}">${escapeHtml(url.toString())}</a></p><p>This link expires in seven days. If you did not request it, you can ignore this email.</p>`,
      });
      if (result.status === "sent") {
        options.core.participantTokens.activateReissue(link.token);
      } else {
        options.core.participantTokens.abandonReissue(link.token);
      }
    } catch {
      options.core.participantTokens.abandonReissue(link.token);
    }
  }
}

async function readFields(context: Context): Promise<SignupValues> {
  const form = await context.req.formData();
  const fields: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [name, value] of form) {
    if (typeof value === "string") (fields[name] ??= []).push(value);
  }
  return fields;
}

function optional(fields: SignupValues, name: string): string | null {
  return firstValue(fields, name).trim() || null;
}

function integer(fields: SignupValues, name: string): number {
  const value = Number(firstValue(fields, name));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function boolean(fields: SignupValues, name: string): boolean {
  return firstValue(fields, name) === "yes";
}

function contactChanges(fields: SignupValues) {
  return {
    name: firstValue(fields, "contact_name").trim(),
    email: firstValue(fields, "contact_email").trim().toLowerCase(),
    phone: optional(fields, "contact_phone"),
  };
}

const COMMON_EDIT_FIELDS = [
  "_csrf",
  "record_version",
  "contact_version",
  "contact_name",
  "contact_email",
  "contact_phone",
] as const;
const VENUE_EDIT_FIELDS = [
  "venue_title",
  "space_description",
  "has_power",
  "rain_backup",
  "requested_act_names",
  "genre_preferences",
  "participant_notes",
  "gear",
  "drinks",
  "amenities",
] as const;
const ACT_EDIT_FIELDS = [
  "act_name",
  "genres",
  "description",
  "links",
  "duration_minutes",
  "requires_amplification",
  "house_preference",
  "shared_member_note",
  "can_lend_gear",
  "participant_notes",
] as const;

function unknownEditFields(
  fields: SignupValues,
  recordType: ParticipantRecordType,
): string[] {
  const allowed = new Set<string>([
    ...COMMON_EDIT_FIELDS,
    ...(recordType === "venue" ? VENUE_EDIT_FIELDS : ACT_EDIT_FIELDS),
  ]);
  return Object.keys(fields).filter((name) => !allowed.has(name));
}

function validateEdit(
  fields: SignupValues,
  recordType: ParticipantRecordType,
): SignupError[] {
  const errors: SignupError[] = [];
  required(fields, "contact_name", "Your name", errors);
  const email = required(fields, "contact_email", "Email", errors);
  if (email && !CONTACT_EMAIL_PATTERN.test(email)) {
    errors.push({
      field: "contact_email",
      label: "Email",
      message: "Enter an email address in the form name@example.com.",
    });
  }
  if (integer(fields, "record_version") === 0) {
    errors.push(versionError());
  }
  if (integer(fields, "contact_version") === 0) {
    errors.push(versionError());
  }
  if (recordType === "venue") {
    required(fields, "venue_title", "Porch name", errors);
    requiredChoice(fields, "has_power", "Electrical power", errors);
    requiredChoice(fields, "rain_backup", "Rain backup", errors);
    validateSelection(fields, "gear", "Gear", venueGearValues, errors);
    validateSelection(fields, "drinks", "Drinks", venueDrinkValues, errors);
    validateSelection(
      fields,
      "amenities",
      "Amenities",
      venueAmenityValues,
      errors,
    );
  } else {
    required(fields, "act_name", "Act name", errors);
    required(fields, "genres", "Genres", errors);
    required(fields, "description", "Act description", errors);
    validateLinks(firstValue(fields, "links").trim(), errors);
    requiredChoice(fields, "requires_amplification", "Amplification", errors);
    requiredChoice(fields, "can_lend_gear", "Can lend gear", errors);
    if (integer(fields, "duration_minutes") === 0) {
      errors.push({
        field: "duration_minutes",
        label: "Set length",
        message: "Enter a positive set length.",
      });
    }
  }
  return errors;
}

function validateLinks(links: string, errors: SignupError[]): void {
  if (
    links &&
    tokenizeLinks(links).some(
      (candidate) => normalizedHttpUrl(candidate) === null,
    )
  ) {
    errors.push({
      field: "links",
      label: "Public links",
      message: "Use only links that begin with http:// or https://.",
    });
  }
}

function validateSelection(
  fields: SignupValues,
  name: string,
  label: string,
  allowed: readonly string[],
  errors: SignupError[],
): void {
  const submitted = allValues(fields, name);
  if (
    new Set(submitted).size !== submitted.length ||
    submitted.some((value) => !allowed.includes(value))
  ) {
    errors.push({
      field: name,
      label,
      message: `Choose each listed ${label.toLowerCase()} option at most once.`,
    });
  }
}

function required(
  fields: SignupValues,
  name: string,
  label: string,
  errors: SignupError[],
): string {
  const value = firstValue(fields, name).trim();
  if (!value)
    errors.push({ field: name, label, message: `${label} is required.` });
  return value;
}

function requiredChoice(
  fields: SignupValues,
  name: string,
  label: string,
  errors: SignupError[],
): void {
  if (!new Set(["yes", "no"]).has(firstValue(fields, name))) {
    errors.push({
      field: name,
      label,
      message: `Choose yes or no for ${label}.`,
    });
  }
}

function versionError(): SignupError {
  return {
    field: "edit-form",
    label: "Version",
    message:
      "This page is missing its record version. Reload it and try again.",
  };
}

type ProposedAvailabilityResult =
  | {
      readonly ok: true;
      readonly windows: readonly {
        readonly startsAt: Date;
        readonly endsAt: Date;
      }[];
    }
  | { readonly ok: false; readonly error: SignupError };

function parseProposedAvailability(
  fields: SignupValues,
  timezone: string,
): ProposedAvailabilityResult {
  const starts = allValues(fields, "availability_start");
  const ends = allValues(fields, "availability_end");
  const error = (message: string): ProposedAvailabilityResult => ({
    ok: false,
    error: {
      field: "availability_start",
      label: "Available time windows",
      message,
    },
  });
  if (Math.max(starts.length, ends.length) > 12) {
    return error("Send at most 12 availability windows.");
  }

  const windows: { startsAt: Date; endsAt: Date }[] = [];
  const seen = new Set<string>();
  const count = Math.max(starts.length, ends.length);
  for (let index = 0; index < count; index += 1) {
    const startValue = starts[index]?.trim() ?? "";
    const endValue = ends[index]?.trim() ?? "";
    if (!startValue && !endValue) continue;
    const startsAt = zonedWallClockToUtc(startValue, timezone);
    const endsAt = zonedWallClockToUtc(endValue, timezone);
    if (!startsAt || !endsAt || startsAt >= endsAt) {
      return error(
        "Give each availability window a real start and a later end time.",
      );
    }
    const key = `${startsAt.valueOf()}-${endsAt.valueOf()}`;
    if (seen.has(key)) {
      return error(
        "Two availability windows are identical. Remove or change one.",
      );
    }
    seen.add(key);
    windows.push({ startsAt, endsAt });
  }
  return windows.length > 0
    ? { ok: true, windows }
    : error("Add at least one time window when your whole act can perform.");
}

async function verifyRequest(
  options: SelfServeRouteOptions,
  guard: UnconfiguredAntibotGuard,
  fields: SignupValues,
  ipAddress: string,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 503;
      readonly message: string;
    }
> {
  if (!CONTACT_EMAIL_PATTERN.test(firstValue(fields, "email").trim())) {
    // Use the same generic acceptance response for syntactically plausible
    // unknown addresses; malformed input is a form error, not roster evidence.
    return {
      ok: false,
      status: 400,
      message: "Enter an email address in the form name@example.com.",
    };
  }
  let result: AntibotResult;
  try {
    result = await options.core.ports.antibot.verify({
      token: optional(fields, "antibot_token"),
      ipAddress,
    });
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Verification is unavailable. Try again shortly.",
    };
  }
  if (result.status === "passed") return { ok: true };
  if (result.status === "not-configured") {
    return guard.checkHoneypot(firstValue(fields, "website"))
      ? { ok: true }
      : {
          ok: false,
          status: 400,
          message: "Verification could not accept this request.",
        };
  }
  return {
    ok: false,
    status: result.status === "unavailable" ? 503 : 403,
    message: "Verification could not accept this request. Try again.",
  };
}

function requestPage(
  options: SelfServeRouteOptions,
  challenge: AntibotClientChallenge | null,
  status: SelfServeStatus,
  error?: string,
  accepted = false,
): Response {
  return new Response(
    renderRequestLinkPage({
      csrfToken: options.csrfTokenFor(SELF_SERVE_REQUEST_PATH),
      challenge,
      accepted,
      error,
    }),
    { status, headers: participantHeaders(challenge) },
  );
}

function participantPage(
  options: SelfServeRouteOptions,
  token: string,
  context: Context,
  status: SelfServeStatus,
  errors: readonly SignupError[] = [],
): Response {
  let participant: ParticipantRecordView;
  try {
    participant = options.core.participantTokens.read(token);
  } catch (error) {
    if (error instanceof ParticipantTokenError) return participantRefusal();
    throw error;
  }
  const assignment = assignmentFor(options.core, participant);
  const timezone = options.core.seasons.getSeason(
    participant.record.seasonId,
  ).timezone;
  const coordinate =
    participant.recordType === "venue"
      ? options.core.geocoding.publishableCoordinate(participant.record.id)
      : null;
  const coordinates = coordinate
    ? `${coordinate.latitude}, ${coordinate.longitude}`
    : participant.recordType === "venue"
      ? "Not verified yet"
      : "Managed with the assigned venue";
  const annotations = options.core.annotations
    .listAnnotations(
      participant.record.seasonId,
      participant.recordType,
      participant.record.id,
    )
    .map(({ note }) => note);
  const notice =
    context.req.query("saved") === "1"
      ? "Your details were saved and returned to the organizer’s activity queue."
      : context.req.query("requested") === "1"
        ? "Your change request is waiting for organizer review. Your assignment has not changed."
        : undefined;
  return new Response(
    renderSelfServePage({
      participant,
      editCsrf: options.csrfTokenFor(SELF_SERVE_PATH),
      changeCsrf: options.csrfTokenFor(SELF_SERVE_CHANGE_REQUEST_PATH),
      assignment,
      coordinates,
      annotations,
      timezone,
      notice,
      errors,
    }),
    { status, headers: participantHeaders(null) },
  );
}

function assignmentFor(
  core: CoreRuntime,
  participant: ParticipantRecordView,
): string {
  const assignments = core.seasons.listAssignmentDisplayForRecord(
    participant.recordType,
    participant.record.id,
  );
  const names = assignments.map((assignment) => {
    const counterpart =
      participant.recordType === "venue"
        ? assignment.actName
        : assignment.venueTitle;
    return `${counterpart}, ${slotWindow(assignment)}`;
  });
  return names.join(" · ") || "Not assigned";
}

function slotWindow(slot: { readonly startsAt: Date; readonly endsAt: Date }) {
  return `${slot.startsAt.toISOString()}–${slot.endsAt.toISOString()}`;
}

function redirectParticipant(
  query: string,
  challenge: AntibotClientChallenge | null,
): Response {
  return new Response(null, {
    status: 303,
    headers: participantHeaders(challenge, {
      location: `${SELF_SERVE_PATH}?${query}`,
    }),
  });
}

function participantRefusal(): Response {
  return new Response(renderParticipantAccessRequiredPage(), {
    status: 401,
    headers: participantHeaders(null),
  });
}

export function participantHeaders(
  challenge: AntibotClientChallenge | null,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    "cache-control": "no-store, private",
    "content-security-policy": contentSecurityPolicy(challenge),
    "content-type": "text/html; charset=UTF-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}
