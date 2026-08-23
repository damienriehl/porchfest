// R5, R6, R15 and R32 at the HTTP layer: the queue an organizer works, and the
// editor that saves a correction without letting two organizers overwrite each
// other silently.

import {
  RepositoryConflictError,
  type CoreRuntime,
  type QueueRecordType,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import {
  RECORD_FIELDS,
  recordTitle,
  renderQueuePage,
  renderRecordPage,
  type ConflictDetail,
} from "../views/admin-records.js";

const RECORD_TYPES: readonly QueueRecordType[] = ["act", "venue", "contact"];

export interface AdminRecordRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}

export function registerAdminRecordRoutes(
  options: AdminRecordRouteOptions,
): void {
  options.routes.register({
    method: "POST",
    path: "/admin/queue/dismiss",
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const fields = await readFields(context);
      const recordType = asRecordType(fields.record_type);
      const recordId = Number(fields.record_id ?? "");
      const version = Number(fields.version ?? "");
      const seasonId = Number(fields.season ?? "");
      if (
        !recordType ||
        !Number.isSafeInteger(recordId) ||
        !Number.isSafeInteger(version) ||
        !Number.isSafeInteger(seasonId)
      ) {
        return redirect(`/admin?season=${seasonId || ""}`);
      }

      // The version the organizer was looking at, not the current one: an edit
      // that landed while they read must stay unreviewed.
      options.core.queue.dismiss({
        organizerId: organizer.id,
        seasonId,
        recordType,
        recordId,
        version,
      });
      return redirect(`/admin?season=${seasonId}`);
    },
  });

  for (const recordType of RECORD_TYPES) {
    options.routes.register({
      method: "GET",
      path: `/admin/records/${recordType}/:id`,
      tier: "organizer",
      handler: (context: Context) => {
        const organizer = currentOrganizer(options.core, context);
        if (!organizer) return unauthorized();
        const recordId = Number(context.req.param("id"));
        const seasonId = Number(context.req.query("season") ?? "");
        const item = findItem(
          options.core,
          seasonId,
          organizer.id,
          recordType,
          recordId,
        );
        if (!item) return notFound();

        return html(
          renderRecordPage({
            recordType,
            recordId,
            seasonId,
            title: recordTitle(item),
            version: item.version,
            values: valuesOf(recordType, item.record),
            csrfToken: options.csrfTokenFor(`/admin/records/${recordType}/:id`),
            saved: context.req.query("saved") === "1",
          }),
        );
      },
    });

    options.routes.register({
      method: "POST",
      path: `/admin/records/${recordType}/:id`,
      tier: "organizer",
      handler: async (context: Context) => {
        const organizer = currentOrganizer(options.core, context);
        if (!organizer) return unauthorized();
        const recordId = Number(context.req.param("id"));
        const fields = await readFields(context);
        const seasonId = Number(fields.season ?? "");
        const expectedVersion = Number(fields.version ?? "");
        const changes = changesFrom(recordType, fields);

        try {
          applyChanges(
            options.core,
            recordType,
            recordId,
            expectedVersion,
            changes,
          );
          return redirect(
            `/admin/records/${recordType}/${recordId}?season=${seasonId}&saved=1`,
          );
        } catch (error) {
          if (!(error instanceof RepositoryConflictError)) throw error;
          // R32: name the conflict rather than overwriting, and keep what the
          // organizer typed so a re-save is one click rather than a retype.
          const current = findItem(
            options.core,
            seasonId,
            organizer.id,
            recordType,
            recordId,
          );
          if (!current) return notFound();
          const stored = valuesOf(recordType, current.record);
          const conflicts: ConflictDetail[] = RECORD_FIELDS[recordType]
            .filter(
              (spec) => (fields[spec.name] ?? "") !== (stored[spec.name] ?? ""),
            )
            .map((spec) => ({
              field: spec.name,
              label: spec.label,
              attempted: fields[spec.name] ?? "",
              stored: stored[spec.name] ?? "",
            }));

          return html(
            renderRecordPage({
              recordType,
              recordId,
              seasonId,
              title: recordTitle(current),
              // Re-armed against the refreshed version, so the organizer's next
              // save is a deliberate overwrite rather than another refusal.
              version: current.version,
              values: pick(RECORD_FIELDS[recordType], fields),
              csrfToken: options.csrfTokenFor(
                `/admin/records/${recordType}/:id`,
              ),
              conflicts,
            }),
            409,
          );
        }
      },
    });
  }
}

function findItem(
  core: CoreRuntime,
  seasonId: number,
  organizerId: number,
  recordType: QueueRecordType,
  recordId: number,
) {
  if (!Number.isSafeInteger(seasonId) || !Number.isSafeInteger(recordId)) {
    return undefined;
  }
  return core.queue
    .listForOrganizer(seasonId, organizerId)
    .find(
      (item) => item.recordType === recordType && item.record.id === recordId,
    );
}

function applyChanges(
  core: CoreRuntime,
  recordType: QueueRecordType,
  recordId: number,
  expectedVersion: number,
  changes: Record<string, unknown>,
): void {
  if (recordType === "act") {
    core.seasons.updateAct(recordId, expectedVersion, changes);
    return;
  }
  if (recordType === "venue") {
    core.seasons.updateVenue(recordId, expectedVersion, changes);
    return;
  }
  core.seasons.updateContact(recordId, expectedVersion, changes);
}

function valuesOf(
  recordType: QueueRecordType,
  record: Record<string, unknown>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const spec of RECORD_FIELDS[recordType]) {
    const raw = record[spec.name];
    if (spec.kind === "boolean") values[spec.name] = raw ? "yes" : "no";
    else if (raw === null || raw === undefined) values[spec.name] = "";
    else values[spec.name] = String(raw);
  }
  return values;
}

function changesFrom(
  recordType: QueueRecordType,
  fields: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const spec of RECORD_FIELDS[recordType]) {
    const raw = fields[spec.name];
    if (raw === undefined) continue;
    if (spec.kind === "boolean") changes[spec.name] = raw === "yes";
    else if (spec.kind === "number")
      changes[spec.name] = raw ? Number(raw) : null;
    else changes[spec.name] = raw.trim() === "" ? null : raw;
  }
  return changes;
}

function pick(
  specs: readonly { name: string }[],
  fields: Readonly<Record<string, string>>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const spec of specs) values[spec.name] = fields[spec.name] ?? "";
  return values;
}

function asRecordType(value: string | undefined): QueueRecordType | null {
  return RECORD_TYPES.find((type) => type === value) ?? null;
}

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
      fields[name] = value;
    }
  }
  return fields;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: adminHeaders() });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...adminHeaders(),
      "content-type": "text/plain; charset=UTF-8",
      location,
    },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...adminHeaders(), "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response("No such record in this season.", {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
