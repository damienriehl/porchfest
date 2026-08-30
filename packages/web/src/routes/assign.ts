import {
  AssignmentConflictError,
  endOfDateInTimeZone,
  isSeasonActionLegal,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  suggestionsForAct,
  type Act,
  type CoreRuntime,
  type QueueItem,
  type Season,
  type Venue,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import { renderAssignActPage } from "../views/assign-act.js";
import { renderAssignVenuePage } from "../views/assign-venue.js";
import { readFields, redirect, unauthorized } from "./admin-http.js";

export const ASSIGN_VENUE_PATH = "/admin/venues/:id/assign";
export const ASSIGN_ACT_PATH = "/admin/acts/:id/assign";
export const ASSIGN_SLOT_PATH = "/admin/slots/:id/assign";
export const UNASSIGN_PATH = "/admin/assignments/:id/unassign";
export const HOLD_SLOT_PATH = "/admin/slots/:id/hold";
export const RELEASE_SLOT_PATH = "/admin/slots/:id/release";
export const LINK_ACT_PATH = "/admin/acts/:id/links";
export const UNLINK_ACT_PATH = "/admin/act-links/:id/unlink";

interface AssignRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
}

type Contact = Extract<QueueItem, { readonly recordType: "contact" }>["record"];

export function registerAssignmentRoutes(options: AssignRouteOptions): void {
  options.routes.register({
    method: "GET",
    path: ASSIGN_VENUE_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return options.routes.organizerGetRefusal(context);
      const venue = findRecord(
        options.core,
        organizer.id,
        "venue",
        positiveId(context.req.param("id")),
      );
      if (!venue) return notFound("venue");
      return venuePage(options, organizer.id, venue.record, {
        assignedActId: positiveId(context.req.query("assigned")),
        releasedTargetVenueId: positiveId(context.req.query("released_to")),
      });
    },
  });

  options.routes.register({
    method: "GET",
    path: ASSIGN_ACT_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return options.routes.organizerGetRefusal(context);
      const act = findRecord(
        options.core,
        organizer.id,
        "act",
        positiveId(context.req.param("id")),
      );
      if (!act) return notFound("act");
      return actPage(options, organizer.id, act.record, {
        assigned: context.req.query("assigned") === String(act.record.id),
      });
    },
  });

  options.routes.register({
    method: "POST",
    path: ASSIGN_SLOT_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const slotId = positiveId(context.req.param("id"));
      const fields = await readFields(context);
      const actId = positiveId(fields.act);
      const version = versionOf(fields.version);
      const location = slotId ? findSlot(options.core, slotId) : null;
      const act = actId
        ? findRecord(options.core, organizer.id, "act", actId)
        : undefined;
      if (
        slotId === null ||
        actId === null ||
        !location ||
        !act ||
        act.record.seasonId !== location.season.id
      )
        return notFound("slot or act");
      if (version === null)
        return originPage(
          options,
          organizer.id,
          fields.return_to,
          location.venue,
          act.record,
          "A valid slot version is required.",
          400,
        );
      try {
        options.core.seasons.assignSlot(slotId, version, actId, {
          sharedMemberOverride: nullableText(fields.override_reason),
        });
      } catch (error) {
        const refusal = mutationRefusal(
          error,
          "The slot changed while you were looking at it. Look again before assigning.",
          404,
        );
        if (refusal) {
          if (refusal.status === 404) return notFound("slot or act");
          return originPage(
            options,
            organizer.id,
            fields.return_to,
            location.venue,
            act.record,
            refusal.message,
            refusal.status,
          );
        }
        throw error;
      }
      return redirect(
        fields.return_to === "act"
          ? `/admin/acts/${actId}/assign?assigned=${actId}`
          : `/admin/venues/${location.venue.id}/assign?assigned=${actId}`,
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: UNASSIGN_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const assignmentId = positiveId(context.req.param("id"));
      const located = assignmentId
        ? findAssignment(options.core, assignmentId)
        : null;
      if (assignmentId === null || !located) return notFound("assignment");
      const act = findRecord(
        options.core,
        organizer.id,
        "act",
        located.assignment.actId,
      );
      if (!act) return notFound("act");
      const fields = await readFields(context);
      const version = versionOf(fields.version);
      if (version === null)
        return originPage(
          options,
          organizer.id,
          fields.return_to,
          located.venue,
          act.record,
          "A valid assignment version is required.",
          400,
        );
      try {
        options.core.seasons.unassignSlot(assignmentId, version);
      } catch (error) {
        const refusal = mutationRefusal(
          error,
          "The assignment changed while you were looking at it. Look again before unassigning.",
          404,
        );
        if (refusal) {
          if (refusal.status === 404) return notFound("assignment");
          return originPage(
            options,
            organizer.id,
            fields.return_to,
            located.venue,
            act.record,
            refusal.message,
            refusal.status,
          );
        }
        throw error;
      }
      return redirect(
        fields.return_to === "act"
          ? `/admin/acts/${act.record.id}/assign`
          : `/admin/venues/${located.venue.id}/assign`,
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: HOLD_SLOT_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const slotId = positiveId(context.req.param("id"));
      const located = slotId ? findSlot(options.core, slotId) : null;
      if (slotId === null || !located) return notFound("slot");
      const fields = await readFields(context);
      const version = versionOf(fields.version);
      const heldForName = fields.held_for?.trim() ?? "";
      const decideBy = endOfDateInTimeZone(
        fields.decide_by,
        located.season.timezone,
      );
      const fallbackVenueId = optionalPositiveId(fields.fallback_venue);
      if (
        version === null ||
        heldForName.length === 0 ||
        decideBy === null ||
        fallbackVenueId === false
      ) {
        return venuePage(options, organizer.id, located.venue, {
          error: "Enter a named act, decide-by date, and valid fallback venue.",
          status: 400,
        });
      }
      if (
        fallbackVenueId !== null &&
        !findRecord(options.core, organizer.id, "venue", fallbackVenueId)
      )
        return notFound("fallback venue");
      try {
        options.core.seasons.holdSlot(slotId, version, {
          heldForName,
          decideBy,
          fallbackVenueId,
        });
      } catch (error) {
        return venueMutationError(options, organizer.id, located.venue, error);
      }
      return redirect(`/admin/venues/${located.venue.id}/assign`);
    },
  });

  options.routes.register({
    method: "POST",
    path: RELEASE_SLOT_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const slotId = positiveId(context.req.param("id"));
      const located = slotId ? findSlot(options.core, slotId) : null;
      if (slotId === null || !located) return notFound("slot");
      const fields = await readFields(context);
      const version = versionOf(fields.version);
      if (version === null)
        return venuePage(options, organizer.id, located.venue, {
          error: "A valid slot version is required.",
          status: 400,
        });
      try {
        const released = options.core.seasons.releaseSlotHold(slotId, version);
        const suffix = released.assignmentTargetVenueId
          ? `?released_to=${released.assignmentTargetVenueId}`
          : "";
        return redirect(`/admin/venues/${located.venue.id}/assign${suffix}`);
      } catch (error) {
        return venueMutationError(options, organizer.id, located.venue, error);
      }
    },
  });

  options.routes.register({
    method: "POST",
    path: LINK_ACT_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const actId = positiveId(context.req.param("id"));
      const act = findRecord(options.core, organizer.id, "act", actId);
      if (actId === null || !act) return notFound("act");
      const fields = await readFields(context);
      const linkedActId = positiveId(fields.linked_act);
      if (!linkedActId) {
        return actPage(options, organizer.id, act.record, {
          error: "Choose an act to link.",
          status: 400,
        });
      }
      const linked = findRecord(options.core, organizer.id, "act", linkedActId);
      if (!linked) return notFound("linked act");
      try {
        options.core.seasons.linkActs({
          seasonId: act.record.seasonId,
          actId,
          linkedActId,
          note: nullableText(fields.note),
        });
      } catch (error) {
        const refusal = mutationRefusal(error, null);
        if (refusal)
          return actPage(options, organizer.id, act.record, {
            error: refusal.message,
            status: refusal.status,
          });
        throw error;
      }
      return redirect(`/admin/acts/${actId}/assign`);
    },
  });

  options.routes.register({
    method: "POST",
    path: UNLINK_ACT_PATH,
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const linkId = positiveId(context.req.param("id"));
      const link = linkId ? findLink(options.core, linkId) : null;
      if (linkId === null || !link) return notFound("act link");
      const fields = await readFields(context);
      const originActId = positiveId(fields.act);
      const act = findRecord(options.core, organizer.id, "act", originActId);
      if (!act || act.record.seasonId !== link.seasonId) return notFound("act");
      const version = versionOf(fields.version);
      if (version === null)
        return actPage(options, organizer.id, act.record, {
          error: "A valid link version is required.",
          status: 400,
        });
      try {
        options.core.seasons.unlinkActs(linkId, version);
      } catch (error) {
        const refusal = mutationRefusal(
          error,
          "The act link changed while you were looking at it. Look again before unlinking.",
          404,
        );
        if (refusal) {
          if (refusal.status === 404) return notFound("act link");
          return actPage(options, organizer.id, act.record, {
            error: refusal.message,
            status: refusal.status,
          });
        }
        throw error;
      }
      return redirect(`/admin/acts/${act.record.id}/assign`);
    },
  });
}

function venuePage(
  options: AssignRouteOptions,
  organizerId: number,
  venue: Venue,
  state: {
    readonly error?: string;
    readonly status?: number;
    readonly assignedActId?: number | null;
    readonly releasedTargetVenueId?: number | null;
  } = {},
): Response {
  const season = options.core.seasons.getSeason(venue.seasonId);
  const slots = isSeasonActionLegal(season.state, "correction")
    ? options.core.seasons.ensureVenueSlots(venue.id)
    : options.core.seasons.listVenueSlots(venue.id);
  const records = options.core.queue.listForOrganizer(season.id, organizerId);
  const acts = recordRows(records, "act").filter(
    (act) => act.status !== "withdrawn",
  );
  const venues = recordRows(records, "venue").filter(
    (item) => item.status !== "withdrawn",
  );
  const contacts = recordRows(records, "contact");
  const hostName =
    venue.hostContactId === null
      ? null
      : (contacts.find((contact) => contact.id === venue.hostContactId)?.name ??
        null);
  const releasedTargetVenue = state.releasedTargetVenueId
    ? (venues.find((item) => item.id === state.releasedTargetVenueId) ?? null)
    : null;
  return html(
    renderAssignVenuePage({
      season,
      venue,
      hostName,
      slots,
      acts,
      venues,
      assignments: options.core.seasons.listAssignments(season.id),
      suggestions: isSeasonActionLegal(season.state, "assignment")
        ? options.core.seasons.suggestForVenue(venue.id)
        : [],
      csrf: {
        assign: options.csrfTokenFor(ASSIGN_SLOT_PATH),
        unassign: options.csrfTokenFor(UNASSIGN_PATH),
        hold: options.csrfTokenFor(HOLD_SLOT_PATH),
        release: options.csrfTokenFor(RELEASE_SLOT_PATH),
      },
      error: state.error,
      assignedActId: state.assignedActId,
      releasedTargetVenue,
    }),
    state.status ?? 200,
  );
}

function actPage(
  options: AssignRouteOptions,
  organizerId: number,
  act: Act,
  state: {
    readonly error?: string;
    readonly status?: number;
    readonly assigned?: boolean;
  } = {},
): Response {
  const season = options.core.seasons.getSeason(act.seasonId);
  const records = options.core.queue.listForOrganizer(season.id, organizerId);
  const acts = recordRows(records, "act").filter(
    (item) => item.status !== "withdrawn",
  );
  const venues = recordRows(records, "venue").filter(
    (venue) => venue.status !== "withdrawn",
  );
  const slots = isSeasonActionLegal(season.state, "correction")
    ? venues.flatMap((venue) => options.core.seasons.ensureVenueSlots(venue.id))
    : options.core.seasons.listSeasonSlots(season.id);
  const input = options.core.seasons.buildMatchingInput(season.id);
  const matchingAct = input.acts.find((item) => item.id === act.id);
  if (!matchingAct && act.status !== "withdrawn") return notFound("act");
  const assignments = options.core.seasons.listAssignments(season.id);
  const actAssignments = assignments.filter((item) => item.actId === act.id);
  const assignment =
    actAssignments.find((item) => item.continuationOfAssignmentId === null) ??
    actAssignments[0];
  const currentAssignment = assignment
    ? (() => {
        const slot = options.core.seasons.getSlot(assignment.slotId);
        return {
          assignment,
          slot,
          venue: options.core.seasons.getVenue(slot.venueId),
          continuations: actAssignments
            .filter((item) => item.continuationOfAssignmentId === assignment.id)
            .map((continuation) => {
              const continuationSlot = options.core.seasons.getSlot(
                continuation.slotId,
              );
              return {
                assignment: continuation,
                slot: continuationSlot,
                venue: options.core.seasons.getVenue(continuationSlot.venueId),
              };
            }),
        };
      })()
    : null;
  const links = options.core.seasons.listActLinksForAct(act.id).map((link) => ({
    ...link,
    actId: resolveCurrentAct(options.core, link.actId).id,
    linkedActId: resolveCurrentAct(options.core, link.linkedActId).id,
  }));
  const linkedActs = links.flatMap((link) => [
    options.core.seasons.getAct(link.actId),
    options.core.seasons.getAct(link.linkedActId),
  ]);
  return html(
    renderAssignActPage({
      season,
      act,
      matchingAct: matchingAct ?? null,
      acts,
      venues,
      slots,
      currentAssignment,
      links,
      linkedActs,
      suggestions:
        matchingAct && isSeasonActionLegal(season.state, "assignment")
          ? suggestionsForAct(input, matchingAct.id)
          : [],
      csrf: {
        assign: options.csrfTokenFor(ASSIGN_SLOT_PATH),
        unassign: options.csrfTokenFor(UNASSIGN_PATH),
        link: options.csrfTokenFor(LINK_ACT_PATH),
        unlink: options.csrfTokenFor(UNLINK_ACT_PATH),
      },
      error: state.error,
      assigned: state.assigned,
    }),
    state.status ?? 200,
  );
}

function resolveCurrentAct(core: CoreRuntime, actId: number): Act {
  let act = core.seasons.getAct(actId);
  const seen = new Set<number>();
  while (act.canonicalActId !== null) {
    if (seen.has(act.id)) {
      throw new SeasonLifecycleError(`act ${actId} has a supersession cycle`);
    }
    seen.add(act.id);
    act = core.seasons.getAct(act.canonicalActId);
  }
  return act;
}

function originPage(
  options: AssignRouteOptions,
  organizerId: number,
  returnTo: string | undefined,
  venue: Venue,
  act: Act,
  error: string,
  status: number,
): Response {
  return returnTo === "act"
    ? actPage(options, organizerId, act, { error, status })
    : venuePage(options, organizerId, venue, { error, status });
}

function venueMutationError(
  options: AssignRouteOptions,
  organizerId: number,
  venue: Venue,
  error: unknown,
): Response {
  const refusal = mutationRefusal(
    error,
    "The slot changed while you were looking at it. Look again before continuing.",
  );
  if (refusal)
    return venuePage(options, organizerId, venue, {
      error: refusal.message,
      status: refusal.status,
    });
  throw error;
}

function mutationRefusal(
  error: unknown,
  conflictMessage: string | null,
  lifecycleStatus = 409,
): { readonly message: string; readonly status: number } | null {
  if (error instanceof AssignmentConflictError) {
    return { message: error.message, status: 409 };
  }
  if (error instanceof SeasonActionError) {
    return { message: stateRefusal(error), status: 409 };
  }
  if (error instanceof SeasonConflictError) {
    return conflictMessage === null
      ? null
      : { message: conflictMessage, status: 409 };
  }
  if (error instanceof SeasonLifecycleError) {
    return { message: error.message, status: lifecycleStatus };
  }
  return null;
}

function findRecord<T extends "act" | "venue">(
  core: CoreRuntime,
  organizerId: number,
  type: T,
  id: number | null,
): Extract<QueueItem, { readonly recordType: T }> | undefined {
  if (id === null) return undefined;
  for (const season of core.setup.listSeasons()) {
    const item = core.queue
      .listForOrganizer(season.id, organizerId)
      .find(
        (candidate) =>
          candidate.recordType === type && candidate.record.id === id,
      );
    if (item?.recordType === type)
      return item as Extract<QueueItem, { readonly recordType: T }>;
  }
  return undefined;
}

function recordRows(records: readonly QueueItem[], type: "act"): Act[];
function recordRows(records: readonly QueueItem[], type: "venue"): Venue[];
function recordRows(records: readonly QueueItem[], type: "contact"): Contact[];
function recordRows(
  records: readonly QueueItem[],
  type: QueueItem["recordType"],
): Array<Act | Venue | Contact> {
  const rows: Array<Act | Venue | Contact> = [];
  for (const item of records) {
    if (item.recordType === type) rows.push(item.record);
  }
  return rows;
}

function findSlot(
  core: CoreRuntime,
  slotId: number,
): { readonly season: Season; readonly venue: Venue } | null {
  try {
    const slot = core.seasons.getSlot(slotId);
    const venue = core.seasons.getVenue(slot.venueId);
    const season = core.seasons.getSeason(slot.seasonId);
    if (venue.seasonId !== season.id) return null;
    return { season, venue };
  } catch (error) {
    if (error instanceof SeasonLifecycleError) return null;
    throw error;
  }
}

function findAssignment(core: CoreRuntime, assignmentId: number) {
  try {
    const assignment = core.seasons.getAssignment(assignmentId);
    const slot = core.seasons.getSlot(assignment.slotId);
    const venue = core.seasons.getVenue(slot.venueId);
    const season = core.seasons.getSeason(assignment.seasonId);
    if (
      slot.seasonId !== season.id ||
      venue.seasonId !== season.id ||
      assignment.seasonId !== season.id
    ) {
      return null;
    }
    return { season, venue, assignment };
  } catch (error) {
    if (error instanceof SeasonLifecycleError) return null;
    throw error;
  }
}

function findLink(core: CoreRuntime, linkId: number) {
  try {
    return core.seasons.getActLink(linkId);
  } catch (error) {
    if (error instanceof SeasonLifecycleError) return null;
    throw error;
  }
}

function positiveId(value: string | undefined): number | null {
  const parsed = Number(value ?? "");
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function versionOf(value: string | undefined): number | null {
  return positiveId(value);
}

function optionalPositiveId(value: string | undefined): number | null | false {
  if ((value ?? "").trim() === "") return null;
  return positiveId(value) ?? false;
}

function nullableText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function stateRefusal(error: SeasonActionError): string {
  return `The season state is ${error.state}; ${error.action} is not allowed.`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: adminHeaders() });
}

function notFound(kind: string): Response {
  return new Response(`No such ${kind}.`, {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
