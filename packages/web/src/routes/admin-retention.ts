// R35's organizer half carries KTD7's version into core and leaves the off-host
// backup half visibly pending until an operator completes the documented cycle.
import {
  RetentionConflictError,
  RetentionLifecycleError,
  type CoreRuntime,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import { readFields, redirect, unauthorized } from "./admin-http.js";
import {
  renderRetentionPage,
  type RetentionNotice,
} from "../views/admin-retention.js";

export const ADMIN_RETENTION_PATH = "/admin/retention";
export const ADMIN_RETENTION_ACTION_PATH = "/admin/retention/:id/anonymize";

export interface AdminRetentionRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}

export function registerAdminRetentionRoutes(
  options: AdminRetentionRouteOptions,
): void {
  options.routes.register({
    method: "GET",
    path: ADMIN_RETENTION_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      if (!currentOrganizer(options.core, context))
        return options.routes.organizerGetRefusal(context);
      return retentionPage(
        options,
        200,
        undefined,
        context.req.query("anonymized") === "1",
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_RETENTION_ACTION_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      if (!currentOrganizer(options.core, context)) return unauthorized();
      const contactId = Number(context.req.param("id"));
      const fields = await readFields(context);
      const expectedVersion = Number(fields.version ?? "");
      if (
        !Number.isSafeInteger(contactId) ||
        contactId < 1 ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      ) {
        return notFound();
      }

      const participantName = participantNameFor(options.core, contactId);
      if (fields.confirmation !== "anonymize") {
        return retentionPage(options, 400, {
          kind: "confirmation",
          participantName,
        });
      }

      try {
        // KTD7: core's mutation owns the guard. This route only carries the
        // version rendered in the organizer's form and names any refusal.
        options.core.retention.anonymizeParticipant({
          contactId,
          expectedVersion,
        });
      } catch (error) {
        if (error instanceof RetentionConflictError) {
          return retentionPage(options, 409, {
            kind: "conflict",
            participantName: participantNameFor(options.core, contactId),
          });
        }
        if (error instanceof RetentionLifecycleError) return notFound();
        throw error;
      }

      return redirect(`${ADMIN_RETENTION_PATH}?anonymized=1`);
    },
  });
}

function retentionPage(
  options: AdminRetentionRouteOptions,
  status: number,
  notice?: RetentionNotice,
  anonymized = false,
): Response {
  return new Response(
    renderRetentionPage({
      retentionMonths: options.core.retention.retentionMonths,
      eligible: options.core.retention.listEligible(),
      receipts: options.core.retention.listReceipts(),
      csrfToken: options.csrfTokenFor(ADMIN_RETENTION_ACTION_PATH),
      notice,
      anonymized,
    }),
    { status, headers: adminHeaders() },
  );
}

function participantNameFor(core: CoreRuntime, contactId: number): string {
  return (
    core.retention.findParticipant(contactId)?.name ??
    `Participant ${contactId}`
  );
}

function notFound(): Response {
  return new Response("No such participant.", {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
