// R11/R12's organizer-facing outbox.
//
// Every route here is deliberately boring except one: `POST .../send` is the
// only handler in the application that can reach the email adapter, and it can
// only do so with an explicit list of message ids an organizer ticked. Reading,
// generating, editing and exporting a wave never touch the provider, so an
// outbox with no provider configured is fully usable (AE1).

import {
  OutboxConflictError,
  OutboxLifecycleError,
  outboxRecipientRules,
  type CoreRuntime,
  type OutboxMessageView,
  type OutboxRecipientRule,
  type OutboxWave,
  type OutboxWaveKind,
  type Season,
  type SendReport,
} from "@porchfest/core";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  ADMIN_SCRIPT_PATH,
  renderOutboxMessagePage,
  renderOutboxWavePage,
  renderSeasonOutboxPage,
  STANDARD_WAVE_KINDS,
  type OutboxContact,
  type ProviderStatus,
  type SendSummary,
  type WaveSummary,
} from "../views/outbox.js";
import { redirect, unauthorized } from "./admin-http.js";

export const SEASON_OUTBOX_PATH = "/admin/seasons/:id/outbox";
export const OUTBOX_GENERATE_PATH = "/admin/seasons/:id/outbox/generate";
export const OUTBOX_AD_HOC_PATH = "/admin/seasons/:id/outbox/ad-hoc";
export const OUTBOX_WAVE_PATH = "/admin/outbox/waves/:id";
/**
 * One path for the whole selection. Send and both exports post here and branch
 * on `intent`, because a CSRF token is minted per route pattern and one form
 * cannot carry two of them - the old `formmethod="get"` export buttons put the
 * send route's token into the URL (and the query string had a length ceiling).
 * R11 still holds: nothing transmits without the explicit `intent=send`.
 */
export const OUTBOX_SEND_PATH = "/admin/outbox/waves/:id/send";
export const OUTBOX_MESSAGE_PATH = "/admin/outbox/messages/:id";
/**
 * A bare `:id.eml` would swallow `/admin/outbox/messages/7` as well, so the
 * extension is pinned with a pattern instead of left to the router's guess.
 */
export const OUTBOX_MESSAGE_EML_PATH =
  "/admin/outbox/messages/:id{[0-9]+\\.eml}";

const MESSAGE_SEPARATOR = "----- next message -----";

/** Any date works as an mbox `From ` stamp; a fixed one keeps exports stable. */
const MBOX_STAMP = "Thu Jan  1 00:00:00 1970";

const adminScript = readFileSync(
  new URL("../../assets/admin.js", import.meta.url),
  "utf8",
);

interface OutboxRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}

export function registerOutboxRoutes(options: OutboxRouteOptions): void {
  // A static file with no season data in it, served exactly like the signup
  // stylesheet. The `/admin` prefix names where it is used, not a trust tier.
  options.routes.register({
    method: "GET",
    path: ADMIN_SCRIPT_PATH,
    tier: "public",
    handler: () =>
      new Response(adminScript, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/javascript; charset=UTF-8",
        },
      }),
  });

  options.routes.register({
    method: "GET",
    path: SEASON_OUTBOX_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return options.routes.organizerGetRefusal(context);
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("season");
      return seasonPage(options, organizer.id, season, 200);
    },
  });

  options.routes.register({
    method: "POST",
    path: OUTBOX_GENERATE_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("season");
      const fields = await readFields(context);
      const kind = standardKind(first(fields, "kind"));
      if (!kind) {
        return seasonPage(
          options,
          organizer.id,
          season,
          400,
          `Unknown wave kind "${first(fields, "kind")}".`,
        );
      }
      const rule = recipientRule(first(fields, "recipient_rule"));
      let generated;
      try {
        generated = options.core.outbox.generateWave({
          seasonId: season.id,
          kind,
          ...(rule === null ? {} : { recipientRule: rule }),
        });
      } catch (error) {
        const refusal = mutationRefusal(error);
        if (refusal)
          return seasonPage(
            options,
            organizer.id,
            season,
            refusal.status,
            refusal.message,
          );
        throw error;
      }
      return redirect(
        `/admin/outbox/waves/${generated.wave.id}?generated=${generated.messages.length}`,
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: OUTBOX_AD_HOC_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const season = findSeason(options.core, context.req.param("id"));
      if (!season) return notFound("season");
      const fields = await readFields(context);
      const label = first(fields, "label").trim();
      const subject = first(fields, "subject").trim();
      const text = first(fields, "text");
      const contactIds = (fields.contact ?? [])
        .map((value) => positiveId(value))
        .filter((value): value is number => value !== null);
      const values = { label, subject, text };

      const missing: string[] = [];
      if (label.length === 0) missing.push("a wave name");
      if (subject.length === 0) missing.push("a subject");
      if (text.trim().length === 0) missing.push("a message");
      if (contactIds.length === 0) missing.push("at least one recipient");
      if (missing.length > 0) {
        return seasonPage(
          options,
          organizer.id,
          season,
          400,
          `An ad-hoc wave needs ${missing.join(", ")}.`,
          values,
          contactIds,
        );
      }

      let created;
      try {
        created = options.core.outbox.createAdHocWave({
          seasonId: season.id,
          label,
          subject,
          text,
          recipientContactIds: contactIds,
        });
      } catch (error) {
        const refusal = mutationRefusal(error);
        if (refusal)
          return seasonPage(
            options,
            organizer.id,
            season,
            refusal.status,
            refusal.message,
            values,
            contactIds,
          );
        throw error;
      }
      return redirect(
        `/admin/outbox/waves/${created.wave.id}?generated=${created.messages.length}`,
      );
    },
  });

  options.routes.register({
    method: "GET",
    path: OUTBOX_WAVE_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context))
        return options.routes.organizerGetRefusal(context);
      const found = findWave(options.core, context.req.param("id"));
      if (!found) return notFound("outbox wave");
      const generated = messageCount(context.req.query("generated"));
      const summary = sendSummaryFromQuery(context);
      return wavePage(options, found.season, found.wave, 200, undefined, {
        ...(generated === null ? {} : { generatedCount: generated }),
        ...(summary === null ? {} : { sendSummary: summary }),
      });
    },
  });

  options.routes.register({
    method: "POST",
    path: OUTBOX_SEND_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      if (!currentOrganizer(options.core, context)) return unauthorized();
      const found = findWave(options.core, context.req.param("id"));
      if (!found) return notFound("outbox wave");
      const fields = await readFields(context);
      const format = exportFormat(first(fields, "intent"));
      const selection = selectedMessages(fields);
      if (selection.messageIds.length === 0) {
        return wavePage(
          options,
          found.season,
          found.wave,
          400,
          format === null
            ? "Select at least one message before sending."
            : "Select at least one message before exporting.",
          {
            errorHeading:
              format === null ? "Nothing was sent" : "Nothing was exported",
          },
        );
      }

      if (format !== null) {
        let exported;
        try {
          exported = options.core.outbox.exportSelection({
            waveId: found.wave.id,
            messageIds: selection.messageIds,
          });
        } catch (error) {
          const refusal = mutationRefusal(error);
          if (refusal)
            return wavePage(
              options,
              found.season,
              found.wave,
              refusal.status,
              refusal.message,
              { errorHeading: "Nothing was exported" },
            );
          throw error;
        }
        return exportResponse(found.wave.id, format, exported);
      }

      let report;
      try {
        report = await options.core.outbox.sendSelection({
          waveId: found.wave.id,
          messageIds: selection.messageIds,
          expectedVersions: selection.expectedVersions,
        });
      } catch (error) {
        const refusal = mutationRefusal(error);
        if (refusal)
          return wavePage(
            options,
            found.season,
            found.wave,
            refusal.status,
            refusal.message,
            {
              errorHeading: "This send did not finish",
              errorNote:
                "Some messages may already have gone out. Reload this wave and read each recipient's state before trying again.",
            },
          );
        throw error;
      }
      // 303 rather than a rendered 200: reloading a rendered send result
      // re-posts the identical body, and a partially sent wave would accept it
      // and transmit again with nobody pressing send (R11).
      return redirect(
        `/admin/outbox/waves/${found.wave.id}?${sendSummaryQuery(report)}`,
      );
    },
  });

  options.routes.register({
    method: "GET",
    path: OUTBOX_MESSAGE_EML_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context))
        return options.routes.organizerGetRefusal(context);
      const messageId = positiveId(
        (context.req.param("id") ?? "").replace(/\.eml$/, ""),
      );
      const message = findMessage(options.core, messageId);
      if (!message) return notFound("outbox message");
      let exported;
      try {
        exported = options.core.outbox.exportSelection({
          waveId: message.waveId,
          messageIds: [message.id],
        });
      } catch (error) {
        if (error instanceof OutboxLifecycleError)
          return exportRefusal(error.message);
        throw error;
      }
      return new Response(exported[0]?.eml ?? "", {
        status: 200,
        headers: {
          ...adminHeaders({ "content-type": "message/rfc822" }),
          "content-disposition": `attachment; filename="outbox-message-${message.id}.eml"`,
        },
      });
    },
  });

  options.routes.register({
    method: "GET",
    path: OUTBOX_MESSAGE_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context))
        return options.routes.organizerGetRefusal(context);
      const message = findMessage(
        options.core,
        positiveId(context.req.param("id") ?? ""),
      );
      if (!message) return notFound("outbox message");
      return messagePage(
        options,
        message,
        200,
        undefined,
        undefined,
        context.req.query("saved") === "1",
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: OUTBOX_MESSAGE_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      if (!currentOrganizer(options.core, context)) return unauthorized();
      const message = findMessage(
        options.core,
        positiveId(context.req.param("id") ?? ""),
      );
      if (!message) return notFound("outbox message");
      const fields = await readFields(context);
      const version = versionOf(first(fields, "version"));
      const subject = first(fields, "subject").trim();
      const text = first(fields, "text");
      const values = { subject, text };
      if (version === null) {
        return messagePage(
          options,
          message,
          400,
          "A valid message version is required.",
          values,
        );
      }
      if (subject.length === 0 || text.trim().length === 0) {
        return messagePage(
          options,
          message,
          400,
          "A message needs both a subject and a body.",
          values,
        );
      }

      try {
        options.core.outbox.editMessage(message.id, version, {
          subject,
          text,
        });
      } catch (error) {
        const refusal = mutationRefusal(error);
        if (refusal) {
          const current = findMessage(options.core, message.id);
          return messagePage(
            options,
            current ?? message,
            refusal.status,
            refusal.message,
            values,
          );
        }
        throw error;
      }
      return redirect(`/admin/outbox/messages/${message.id}?saved=1`);
    },
  });
}

// --- page builders --------------------------------------------------------

function providerStatus(core: CoreRuntime): ProviderStatus {
  return {
    configured: core.ports.email.configured,
    name: core.ports.email.name,
  };
}

function seasonPage(
  options: OutboxRouteOptions,
  organizerId: number,
  season: Season,
  status: number,
  error?: string,
  values?: Readonly<Record<string, string>>,
  selectedContactIds?: readonly number[],
): Response {
  const contacts: OutboxContact[] = [];
  for (const item of options.core.queue.listForOrganizer(
    season.id,
    organizerId,
  )) {
    if (item.recordType === "contact") contacts.push(item.record);
  }
  contacts.sort((left, right) => left.name.localeCompare(right.name));

  const waves: WaveSummary[] = options.core.outbox
    .listWaves(season.id)
    .map((wave) => summarize(options.core, wave));

  return new Response(
    renderSeasonOutboxPage({
      season,
      provider: providerStatus(options.core),
      waves,
      contacts,
      csrf: {
        generate: options.csrfTokenFor(OUTBOX_GENERATE_PATH),
        adHoc: options.csrfTokenFor(OUTBOX_AD_HOC_PATH),
      },
      ...(error === undefined ? {} : { error }),
      ...(values === undefined ? {} : { values }),
      ...(selectedContactIds === undefined ? {} : { selectedContactIds }),
    }),
    { status, headers: adminHeaders() },
  );
}

function summarize(core: CoreRuntime, wave: OutboxWave): WaveSummary {
  const counts = {
    generated: 0,
    edited: 0,
    sent: 0,
    generated_stale: 0,
    edited_stale: 0,
  };
  const messages = core.outbox.listMessages(wave.id);
  for (const message of messages) counts[message.state] += 1;
  return { wave, counts, total: messages.length };
}

function wavePage(
  options: OutboxRouteOptions,
  season: Season,
  wave: OutboxWave,
  status: number,
  error?: string,
  extra: {
    readonly generatedCount?: number;
    readonly sendSummary?: SendSummary;
    readonly errorHeading?: string;
    readonly errorNote?: string;
  } = {},
): Response {
  return new Response(
    renderOutboxWavePage({
      season,
      wave,
      messages: options.core.outbox.listMessages(wave.id),
      provider: providerStatus(options.core),
      csrf: {
        send: options.csrfTokenFor(OUTBOX_SEND_PATH),
        generate: options.csrfTokenFor(OUTBOX_GENERATE_PATH),
      },
      ...(error === undefined ? {} : { error }),
      ...extra,
    }),
    { status, headers: adminHeaders() },
  );
}

function messagePage(
  options: OutboxRouteOptions,
  message: OutboxMessageView,
  status: number,
  error?: string,
  values?: { readonly subject: string; readonly text: string },
  saved = false,
): Response {
  const found = findWave(options.core, String(message.waveId));
  if (!found) return notFound("outbox wave");
  return new Response(
    renderOutboxMessagePage({
      season: found.season,
      wave: found.wave,
      message,
      csrf: options.csrfTokenFor(OUTBOX_MESSAGE_PATH),
      saved,
      ...(error === undefined ? {} : { error }),
      ...(values === undefined ? {} : { values }),
    }),
    { status, headers: adminHeaders() },
  );
}

// --- plumbing -------------------------------------------------------------

/**
 * Every value of every field, not just the first. The selection form submits
 * `message` once per ticked checkbox, so a first-value-wins reader would send
 * exactly one message and silently drop the rest.
 *
 * Written as an iteration for the same reason as `readFields` in
 * `admin-http.ts`: the obvious FormData accessors read as route registrations
 * to `scripts/check-core-boundary.mjs`.
 */
async function readFields(
  context: Context,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const form = await context.req.formData();
  const fields: Record<string, string[]> = Object.create(null) as Record<
    string,
    string[]
  >;
  for (const [name, value] of form) {
    if (typeof value !== "string") continue;
    const existing = fields[name];
    if (existing) existing.push(value);
    else fields[name] = [value];
  }
  return fields;
}

function first(
  fields: Readonly<Record<string, readonly string[]>>,
  name: string,
): string {
  return fields[name]?.[0] ?? "";
}

function selectedMessages(
  fields: Readonly<Record<string, readonly string[]>>,
): {
  readonly messageIds: readonly number[];
  readonly expectedVersions: Readonly<Record<number, number>>;
} {
  const messageIds: number[] = [];
  const expectedVersions: Record<number, number> = {};
  for (const raw of fields.message ?? []) {
    const id = positiveId(raw);
    if (id === null || messageIds.includes(id)) continue;
    messageIds.push(id);
    const version = versionOf(first(fields, `version_${id}`));
    if (version !== null) expectedVersions[id] = version;
  }
  return { messageIds, expectedVersions };
}

function standardKind(value: string): OutboxWaveKind | null {
  return STANDARD_WAVE_KINDS.find((kind) => kind === value) ?? null;
}

/** A wave may override its kind's default audience; anything else is ignored. */
function recipientRule(value: string): OutboxRecipientRule | null {
  return outboxRecipientRules.find((rule) => rule === value) ?? null;
}

/** A generation can legitimately produce zero messages, so zero is a real count. */
function messageCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 1 ? id : null;
}

function versionOf(value: string): number | null {
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 1 ? version : null;
}

/** Only these two intents export; everything else is a send (R11). */
function exportFormat(intent: string): "text" | "eml" | null {
  if (intent === "export-text") return "text";
  if (intent === "export-eml") return "eml";
  return null;
}

/**
 * A text export is a readable bundle; an .eml export is an mbox, which mail
 * clients import directly. Both are attachments - the browser painted raw MIME
 * into the window when the .eml bundle was served inline as text/plain.
 */
function exportResponse(
  waveId: number,
  format: "text" | "eml",
  exported: readonly {
    readonly subject: string;
    readonly text: string;
    readonly eml: string;
  }[],
): Response {
  const body =
    format === "eml"
      ? exported.map((message) => mboxEntry(message.eml)).join("")
      : exported
          .map((message) => `Subject: ${message.subject}\n\n${message.text}\n`)
          .join(`\n${MESSAGE_SEPARATOR}\n`);
  const contentType =
    format === "eml" ? "application/mbox" : "text/plain; charset=UTF-8";
  const filename =
    format === "eml"
      ? `outbox-wave-${waveId}.mbox`
      : `outbox-wave-${waveId}.txt`;
  return new Response(body, {
    status: 200,
    headers: {
      ...adminHeaders({ "content-type": contentType }),
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** mboxo: a `From ` separator, and any body line that looks like one is quoted. */
function mboxEntry(eml: string): string {
  const quoted = eml
    .split("\n")
    .map((line) => (line.startsWith("From ") ? `>${line}` : line))
    .join("\n");
  return `From porchfest@localhost ${MBOX_STAMP}\n${quoted}\n\n`;
}

/**
 * `recorded: false` means the outcome happened but nothing wrote it down, so it
 * is counted on its own rather than folded into sent/failed/skipped - the wave
 * page will show that recipient as "not sent yet" and the two must agree.
 */
function sendSummaryQuery(report: SendReport): string {
  const counts = { sent: 0, failed: 0, skipped: 0, unrecorded: 0 };
  for (const outcome of report.recipients) {
    if (!outcome.recorded) counts.unrecorded += 1;
    else counts[outcome.status] += 1;
  }
  return new URLSearchParams({
    sent: String(counts.sent),
    failed: String(counts.failed),
    skipped: String(counts.skipped),
    unrecorded: String(counts.unrecorded),
    attempted: String(report.attempted),
  }).toString();
}

function sendSummaryFromQuery(context: Context): SendSummary | null {
  const sent = messageCount(context.req.query("sent"));
  if (sent === null) return null;
  return {
    sent,
    failed: messageCount(context.req.query("failed")) ?? 0,
    skipped: messageCount(context.req.query("skipped")) ?? 0,
    unrecorded: messageCount(context.req.query("unrecorded")) ?? 0,
    attempted: messageCount(context.req.query("attempted")) ?? 0,
  };
}

function findSeason(
  core: CoreRuntime,
  rawId: string | undefined,
): Season | null {
  const id = positiveId(rawId ?? "");
  if (id === null) return null;
  return core.setup.listSeasons().find((season) => season.id === id) ?? null;
}

function findWave(
  core: CoreRuntime,
  rawId: string | undefined,
): { readonly wave: OutboxWave; readonly season: Season } | null {
  const id = positiveId(rawId ?? "");
  if (id === null) return null;
  for (const season of core.setup.listSeasons()) {
    const wave = core.outbox
      .listWaves(season.id)
      .find((candidate) => candidate.id === id);
    if (wave) return { wave, season };
  }
  return null;
}

function findMessage(
  core: CoreRuntime,
  messageId: number | null,
): OutboxMessageView | null {
  if (messageId === null) return null;
  try {
    return core.outbox.getMessage(messageId);
  } catch (error) {
    // The only lifecycle refusal `getMessage` raises is "does not exist".
    if (error instanceof OutboxLifecycleError) return null;
    throw error;
  }
}

function mutationRefusal(
  error: unknown,
): { readonly message: string; readonly status: number } | null {
  if (error instanceof OutboxConflictError) {
    return {
      message:
        "Someone else changed this outbox while you were looking at it. Reload and check what changed before trying again.",
      status: 409,
    };
  }
  if (error instanceof OutboxLifecycleError) {
    return { message: error.message, status: 409 };
  }
  return null;
}

function exportRefusal(message: string): Response {
  return new Response(message, {
    status: 409,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}

function notFound(kind: string): Response {
  return new Response(`No such ${kind}.`, {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
