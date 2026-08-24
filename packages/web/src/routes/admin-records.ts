// R5, R6, R15, R26, R27 and R32 at the HTTP layer: the queue an organizer
// works, the lifecycle actions that reconcile records, and the editor that
// saves a correction without letting two organizers overwrite each other.

import {
  ChangeRequestConflictError,
  ChangeRequestLifecycleError,
  RecordLifecycleError,
  recordStatuses,
  RepositoryConflictError,
  SeasonActionError,
  SeasonLifecycleError,
  type CoreRuntime,
  type PlaceholderReachInput,
  type QueueItem,
  type QueueRecordType,
} from "@porchfest/core";
import type { Context } from "hono";
import { adminHeaders, currentOrganizer } from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import { readFields, redirect, unauthorized } from "./admin-http.js";
import {
  RECORD_FIELDS,
  recordTitle,
  renderPlaceholderPage,
  renderRecordPage,
  type ConflictDetail,
} from "../views/admin-records.js";
import { CONTACT_EMAIL_PATTERN } from "./signup.js";

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

  options.routes.register({
    method: "POST",
    path: "/admin/change-requests/:id/apply",
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const requestId = Number(context.req.param("id"));
      const fields = await readFields(context);
      const seasonId = Number(fields.season ?? "");
      const version = Number(fields.version ?? "");
      try {
        let pending;
        try {
          pending = options.core.changeRequests.find(requestId);
        } catch (error) {
          // R33: malformed proposals stay rejectable, but apply must refuse
          // them instead of leaking a decode failure as a server error.
          if (!(error instanceof ChangeRequestLifecycleError)) throw error;
          return html(
            `<h1>This change request could not be applied</h1><p>Its proposal is invalid. Reject it from the activity queue to dismiss it.</p>`,
            409,
          );
        }
        if (
          !pending ||
          pending.seasonId !== seasonId ||
          !Number.isSafeInteger(version)
        ) {
          return notFound();
        }
        if (pending.kind === "address") {
          if (
            pending.status !== "pending" ||
            pending.version !== version ||
            !pending.applicable
          ) {
            throw new ChangeRequestConflictError(requestId, ["recordVersion"]);
          }
          return redirect(
            `/admin/records/venue/${pending.recordId}?season=${seasonId}&change_request=${pending.id}`,
          );
        }
        options.core.changeRequests.apply(requestId, version);
        return redirect(`/admin?season=${seasonId}`);
      } catch (error) {
        if (
          !(error instanceof RepositoryConflictError) &&
          !(error instanceof SeasonActionError) &&
          !(error instanceof SeasonLifecycleError)
        ) {
          throw error;
        }
        if (
          error instanceof SeasonActionError ||
          error instanceof SeasonLifecycleError
        ) {
          const refusal = lifecycleRefusal("change request", error);
          return html(
            `<h1>${refusal.title}</h1><p>${refusal.message}</p>`,
            409,
          );
        }
        // R33 refuses the decision rather than risking a schedule mutation made
        // against a record or request another organizer already changed.
        return html(
          `<h1>This change request could not be applied</h1><p>Reload the activity queue to review its current state.</p>`,
          409,
        );
      }
    },
  });

  options.routes.register({
    method: "POST",
    path: "/admin/change-requests/:id/reject",
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const requestId = Number(context.req.param("id"));
      const fields = await readFields(context);
      const seasonId = Number(fields.season ?? "");
      const version = Number(fields.version ?? "");

      try {
        try {
          const pending = options.core.changeRequests.find(requestId);
          if (
            !pending ||
            pending.seasonId !== seasonId ||
            !Number.isSafeInteger(version)
          ) {
            return notFound();
          }
        } catch (error) {
          // R33: malformed proposals are intentionally absent from the queue,
          // but reject remains their organizer-controlled recovery path.
          if (!(error instanceof ChangeRequestLifecycleError)) throw error;
        }
        options.core.changeRequests.reject(requestId, version, seasonId);
      } catch (error) {
        if (!(error instanceof RepositoryConflictError)) throw error;
        return html(
          `<h1>This change request could not be rejected</h1><p>Reload the activity queue to review its current state.</p>`,
          409,
        );
      }
      return redirect(`/admin?season=${seasonId}`);
    },
  });

  options.routes.register({
    method: "GET",
    path: "/admin/placeholders/:recordType/new",
    tier: "organizer",
    handler: (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const recordType = asPlaceholderType(context.req.param("recordType"));
      const seasonId = Number(context.req.query("season") ?? "");
      if (
        !recordType ||
        !Number.isSafeInteger(seasonId) ||
        !seasonExists(options.core, seasonId)
      ) {
        return notFound();
      }
      return html(
        renderPlaceholderPage({
          recordType,
          seasonId,
          csrfToken: options.csrfTokenFor("/admin/placeholders/:recordType"),
          contacts: contactOptions(options.core, seasonId, organizer.id),
        }),
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: "/admin/placeholders/:recordType",
    tier: "organizer",
    handler: async (context: Context) => {
      const organizer = currentOrganizer(options.core, context);
      if (!organizer) return unauthorized();
      const recordType = asPlaceholderType(context.req.param("recordType"));
      const fields = await readFields(context);
      const seasonId = Number(fields.season ?? "");
      if (
        !recordType ||
        !Number.isSafeInteger(seasonId) ||
        !seasonExists(options.core, seasonId)
      ) {
        return notFound();
      }
      const contacts = contactOptions(options.core, seasonId, organizer.id);
      const reachResult = placeholderReach(
        fields,
        contacts.map(({ id }) => id),
      );
      const titleField = recordType === "act" ? "name" : "title";
      const title = fields[titleField]?.trim() ?? "";
      if (!title || !reachResult.reach) {
        return html(
          renderPlaceholderPage({
            recordType,
            seasonId,
            csrfToken: options.csrfTokenFor("/admin/placeholders/:recordType"),
            contacts,
            values: fields,
            error: !title
              ? `Add a ${recordType === "act" ? "name" : "title"}.`
              : reachResult.error,
          }),
          400,
        );
      }

      let created;
      try {
        created =
          recordType === "act"
            ? options.core.seasons.createPlaceholderAct({
                seasonId,
                reach: reachResult.reach,
                act: {
                  name: title,
                  genre: nullableText(fields.genre),
                  description: nullableText(fields.description),
                  links: nullableText(fields.links),
                  durationMinutes: nullableNumber(fields.durationMinutes),
                  requiresAmplification: nullableBoolean(
                    fields.requiresAmplification,
                  ),
                  housePreference: nullableText(fields.housePreference),
                  canLendGear: nullableBoolean(fields.canLendGear),
                  notes: nullableText(fields.notes),
                },
              })
            : options.core.seasons.createPlaceholderVenue({
                seasonId,
                reach: reachResult.reach,
                venue: {
                  title,
                  address: nullableText(fields.address),
                  spaceDescription: nullableText(fields.spaceDescription),
                  hasPower: nullableBoolean(fields.hasPower),
                  rainBackup: nullableBoolean(fields.rainBackup),
                  notes: nullableText(fields.notes),
                },
              });
      } catch (error) {
        if (
          !(error instanceof SeasonActionError) &&
          !(error instanceof RecordLifecycleError)
        ) {
          throw error;
        }
        return html(
          renderPlaceholderPage({
            recordType,
            seasonId,
            csrfToken: options.csrfTokenFor("/admin/placeholders/:recordType"),
            contacts: contactOptions(options.core, seasonId, organizer.id),
            values: fields,
            error:
              error instanceof SeasonActionError
                ? "This season is archived, so placeholders can no longer be added. Your answers are still here."
                : "That contact is no longer available. Choose another contact or enter a direct email address.",
          }),
          409,
        );
      }
      return redirect(
        `/admin/records/${recordType}/${created.id}?season=${seasonId}&created=1`,
      );
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

        const addressRequest = addressRequestFor(
          options.core,
          context.req.query("change_request"),
          seasonId,
          recordType,
          recordId,
        );
        const storedValues = valuesOf(recordType, item.record);

        return html(
          renderLifecycleRecordPage(options, organizer.id, seasonId, item, {
            saved:
              context.req.query("saved") === "1" ||
              context.req.query("created") === "1",
            values:
              addressRequest === null
                ? undefined
                : {
                    ...storedValues,
                    address: addressRequest.proposedAddress ?? "",
                  },
            conflicts:
              addressRequest === null
                ? undefined
                : [
                    {
                      field: "address",
                      label: "Street address",
                      attempted: addressRequest.proposedAddress ?? "",
                      stored: storedValues.address ?? "",
                    },
                  ],
            changeRequestReview:
              addressRequest === null
                ? undefined
                : { id: addressRequest.id, presentation: "proposal" },
          }),
        );
      },
    });

    if (recordType !== "contact") {
      options.routes.register({
        method: "POST",
        path: `/admin/records/${recordType}/:id/status`,
        tier: "organizer",
        handler: async (context: Context) => {
          const organizer = currentOrganizer(options.core, context);
          if (!organizer) return unauthorized();
          const recordId = Number(context.req.param("id"));
          const fields = await readFields(context);
          const seasonId = Number(fields.season ?? "");
          const version = Number(fields.version ?? "");
          const status = recordStatuses.find(
            (candidate) => candidate === fields.status,
          );
          if (!status) {
            return redirect(
              `/admin/records/${recordType}/${recordId}?season=${seasonId}`,
            );
          }

          try {
            options.core.seasons.setRecordStatus(
              recordType,
              recordId,
              version,
              status,
            );
          } catch (error) {
            if (
              !(error instanceof RepositoryConflictError) &&
              !(error instanceof SeasonActionError) &&
              !(error instanceof SeasonLifecycleError)
            ) {
              throw error;
            }
            const current = findItem(
              options.core,
              seasonId,
              organizer.id,
              recordType,
              recordId,
            );
            if (!current) return notFound();
            if (
              error instanceof SeasonActionError ||
              error instanceof SeasonLifecycleError
            ) {
              return html(
                renderLifecycleRecordPage(
                  options,
                  organizer.id,
                  seasonId,
                  current,
                  { refusal: lifecycleRefusal("status change", error) },
                ),
                409,
              );
            }
            // Same refusal shape as a field edit: named, not overwritten.
            return html(
              renderRecordPage({
                recordType,
                recordId,
                seasonId,
                title: recordTitle(current),
                version: current.version,
                values: valuesOf(recordType, current.record),
                csrfToken: options.csrfTokenFor(
                  `/admin/records/${recordType}/:id`,
                ),
                statusCsrfToken: options.csrfTokenFor(
                  `/admin/records/${recordType}/:id/status`,
                ),
                status: statusOf(current.record),
                conflicts: [
                  {
                    field: "status",
                    label: "Status",
                    attempted: status,
                    stored: statusOf(current.record) ?? "",
                  },
                ],
              }),
              409,
            );
          }
          return redirect(
            `/admin/records/${recordType}/${recordId}?season=${seasonId}&saved=1`,
          );
        },
      });
    }

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
          completeAddressReviewAfterSave(
            options.core,
            fields.change_request,
            seasonId,
            recordType,
            recordId,
            changes.address,
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
              changeRequestReview: changeRequestId(fields.change_request),
            }),
            409,
          );
        }
      },
    });

    if (recordType !== "contact") {
      options.routes.register({
        method: "POST",
        path: `/admin/records/${recordType}/:id/promote`,
        tier: "organizer",
        handler: async (context: Context) => {
          const organizer = currentOrganizer(options.core, context);
          if (!organizer) return unauthorized();
          const recordId = Number(context.req.param("id"));
          const fields = await readFields(context);
          const seasonId = Number(fields.season ?? "");
          const expectedVersion = Number(fields.version ?? "");
          const [submissionIdText, submissionVersionText] = (
            fields.submission ?? ""
          ).split(":", 2);
          const submissionId = Number(submissionIdText ?? "");
          const submissionVersion = Number(submissionVersionText ?? "");
          const current = findItem(
            options.core,
            seasonId,
            organizer.id,
            recordType,
            recordId,
          );
          const submission = findItem(
            options.core,
            seasonId,
            organizer.id,
            recordType,
            submissionId,
          );
          if (
            !current ||
            !submission ||
            current.recordType === "contact" ||
            submission.recordType === "contact" ||
            !current.record.placeholder ||
            submission.record.placeholder ||
            !Number.isSafeInteger(expectedVersion) ||
            !Number.isSafeInteger(submissionVersion)
          ) {
            return notFound();
          }

          try {
            if (recordType === "act") {
              options.core.seasons.promotePlaceholderAct(
                recordId,
                expectedVersion,
                submissionId,
                submissionVersion,
              );
            } else {
              options.core.seasons.promotePlaceholderVenue(
                recordId,
                expectedVersion,
                submissionId,
                submissionVersion,
              );
            }
          } catch (error) {
            if (
              !(error instanceof RepositoryConflictError) &&
              !(error instanceof SeasonActionError) &&
              !(error instanceof SeasonLifecycleError)
            ) {
              throw error;
            }
            const refreshed = findItem(
              options.core,
              seasonId,
              organizer.id,
              recordType,
              recordId,
            );
            if (!refreshed) return notFound();
            if (
              error instanceof SeasonActionError ||
              error instanceof SeasonLifecycleError
            ) {
              return html(
                renderLifecycleRecordPage(
                  options,
                  organizer.id,
                  seasonId,
                  refreshed,
                  { refusal: lifecycleRefusal("promotion", error) },
                ),
                409,
              );
            }
            return html(
              renderLifecycleRecordPage(
                options,
                organizer.id,
                seasonId,
                refreshed,
                {
                  conflicts: [
                    {
                      field: "promotion",
                      label: "Promotion",
                      attempted: `${recordTitle(submission)} · version ${submissionVersion}`,
                      stored: `${recordTitle(refreshed)} · version ${refreshed.version}`,
                    },
                  ],
                },
              ),
              409,
            );
          }
          return redirect(
            `/admin/records/${recordType}/${recordId}?season=${seasonId}&saved=1`,
          );
        },
      });
    }

    options.routes.register({
      method: "POST",
      path: `/admin/records/${recordType}/:id/supersede`,
      tier: "organizer",
      handler: async (context: Context) => {
        const organizer = currentOrganizer(options.core, context);
        if (!organizer) return unauthorized();
        const recordId = Number(context.req.param("id"));
        const fields = await readFields(context);
        const seasonId = Number(fields.season ?? "");
        const expectedVersion = Number(fields.version ?? "");
        const canonicalId = Number(fields.canonical_id ?? "");
        const current = findItem(
          options.core,
          seasonId,
          organizer.id,
          recordType,
          recordId,
        );
        const canonical = findItem(
          options.core,
          seasonId,
          organizer.id,
          recordType,
          canonicalId,
        );
        if (
          !current ||
          !canonical ||
          recordId === canonicalId ||
          !Number.isSafeInteger(expectedVersion)
        ) {
          return notFound();
        }

        try {
          if (recordType === "act") {
            options.core.seasons.supersedeAct(
              recordId,
              expectedVersion,
              canonicalId,
            );
          } else if (recordType === "venue") {
            options.core.seasons.supersedeVenue(
              recordId,
              expectedVersion,
              canonicalId,
            );
          } else {
            options.core.seasons.supersedeContact(
              recordId,
              expectedVersion,
              canonicalId,
            );
          }
        } catch (error) {
          if (
            !(error instanceof RepositoryConflictError) &&
            !(error instanceof SeasonActionError) &&
            !(error instanceof SeasonLifecycleError)
          ) {
            throw error;
          }
          const refreshed = findItem(
            options.core,
            seasonId,
            organizer.id,
            recordType,
            recordId,
          );
          if (!refreshed) return notFound();
          if (
            error instanceof SeasonActionError ||
            error instanceof SeasonLifecycleError
          ) {
            return html(
              renderLifecycleRecordPage(
                options,
                organizer.id,
                seasonId,
                refreshed,
                { refusal: lifecycleRefusal("supersession", error) },
              ),
              409,
            );
          }
          return html(
            renderLifecycleRecordPage(
              options,
              organizer.id,
              seasonId,
              refreshed,
              {
                conflicts: [
                  {
                    field: "supersession",
                    label: "Canonical record",
                    attempted: recordTitle(canonical),
                    stored: `${recordTitle(refreshed)} · version ${refreshed.version}`,
                  },
                ],
              },
            ),
            409,
          );
        }
        return redirect(
          `/admin/records/${recordType}/${canonicalId}?season=${seasonId}&saved=1`,
        );
      },
    });
  }
}

function renderLifecycleRecordPage(
  options: AdminRecordRouteOptions,
  organizerId: number,
  seasonId: number,
  item: QueueItem,
  overrides: {
    readonly saved?: boolean;
    readonly conflicts?: readonly ConflictDetail[];
    readonly refusal?: { readonly title: string; readonly message: string };
    readonly values?: Readonly<Record<string, string>>;
    readonly changeRequestReview?: {
      readonly id: number;
      readonly presentation?: "proposal";
    };
  } = {},
): string {
  const candidates = options.core.queue
    .listForOrganizer(seasonId, organizerId)
    .filter(
      (candidate) =>
        candidate.recordType === item.recordType &&
        candidate.record.id !== item.record.id,
    )
    .map((candidate) => ({
      id: candidate.record.id,
      version: candidate.version,
      title: recordTitle(candidate),
      placeholder:
        candidate.recordType === "contact"
          ? false
          : candidate.record.placeholder,
    }));
  const promotion =
    item.recordType !== "contact" && item.record.placeholder
      ? {
          csrfToken: options.csrfTokenFor(
            `/admin/records/${item.recordType}/:id/promote`,
          ),
          candidates: candidates.filter((candidate) => !candidate.placeholder),
        }
      : undefined;
  const supersession =
    candidates.length === 0
      ? undefined
      : {
          csrfToken: options.csrfTokenFor(
            `/admin/records/${item.recordType}/:id/supersede`,
          ),
          candidates,
        };
  return renderRecordPage({
    recordType: item.recordType,
    recordId: item.record.id,
    seasonId,
    title: recordTitle(item),
    version: item.version,
    values: overrides.values ?? valuesOf(item.recordType, item.record),
    csrfToken: options.csrfTokenFor(`/admin/records/${item.recordType}/:id`),
    statusCsrfToken: options.csrfTokenFor(
      `/admin/records/${item.recordType}/:id/status`,
    ),
    status: statusOf(item.record),
    saved: overrides.saved,
    conflicts: overrides.conflicts,
    refusal: overrides.refusal,
    changeRequestReview: overrides.changeRequestReview,
    promotion,
    supersession,
  });
}

function addressRequestFor(
  core: CoreRuntime,
  requestIdValue: string | undefined,
  seasonId: number,
  recordType: QueueRecordType,
  recordId: number,
): ReturnType<CoreRuntime["changeRequests"]["find"]> {
  const requestId = Number(requestIdValue ?? "");
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return null;
  const request = core.changeRequests.find(requestId);
  if (
    !request ||
    request.status !== "pending" ||
    !request.applicable ||
    request.kind !== "address" ||
    recordType !== "venue" ||
    request.seasonId !== seasonId ||
    request.recordId !== recordId
  ) {
    return null;
  }
  return request;
}

function changeRequestId(
  value: string | undefined,
): { readonly id: number } | undefined {
  const id = Number(value ?? "");
  return Number.isSafeInteger(id) && id > 0 ? { id } : undefined;
}

function completeAddressReviewAfterSave(
  core: CoreRuntime,
  requestIdValue: string | undefined,
  seasonId: number,
  recordType: QueueRecordType,
  recordId: number,
  savedAddress: unknown,
): void {
  const review = changeRequestId(requestIdValue);
  if (!review) return;
  try {
    const request = core.changeRequests.find(review.id);
    if (
      !request ||
      request.status !== "pending" ||
      request.kind !== "address" ||
      recordType !== "venue" ||
      request.seasonId !== seasonId ||
      request.recordId !== recordId ||
      request.proposedAddress !== savedAddress
    ) {
      return;
    }
    core.changeRequests.completeAddressReview(request.id, request.version);
  } catch (error) {
    // R33: the venue save already succeeded. A malformed proposal or another
    // organizer resolving it first must not turn that successful save into a
    // 500 that invites the organizer to repeat the committed write.
    if (
      error instanceof ChangeRequestLifecycleError ||
      error instanceof ChangeRequestConflictError
    ) {
      return;
    }
    throw error;
  }
}

function lifecycleRefusal(
  action: "change request" | "promotion" | "status change" | "supersession",
  error: SeasonActionError | SeasonLifecycleError,
): { readonly title: string; readonly message: string } {
  if (error instanceof SeasonActionError) {
    return {
      title: `This ${action} could not be completed`,
      message: `This season is archived, so the ${action} is no longer allowed. The records were left unchanged.`,
    };
  }
  return {
    title: `This ${action} could not be completed`,
    message: `${error.message}. Review the records' schedule assignments before trying again.`,
  };
}

function contactOptions(
  core: CoreRuntime,
  seasonId: number,
  organizerId: number,
) {
  return core.queue
    .listForOrganizer(seasonId, organizerId)
    .filter((item) => item.recordType === "contact")
    .map((item) => ({
      id: item.record.id,
      title: `${item.record.name}${item.record.email ? ` · ${item.record.email}` : ""}`,
    }));
}

function seasonExists(core: CoreRuntime, seasonId: number): boolean {
  return core.setup.listSeasons().some((season) => season.id === seasonId);
}

function placeholderReach(
  fields: Readonly<Record<string, string>>,
  allowedContactIds: readonly number[],
): { readonly reach: PlaceholderReachInput | null; readonly error: string } {
  const selectedContact = fields.reach_via_contact_id?.trim() ?? "";
  if (selectedContact) {
    const reachViaContactId = Number(selectedContact);
    if (
      Number.isSafeInteger(reachViaContactId) &&
      reachViaContactId > 0 &&
      allowedContactIds.includes(reachViaContactId)
    ) {
      return { reach: { reachViaContactId }, error: "" };
    }
    return {
      reach: null,
      error:
        "That selected contact is no longer available. Choose another contact or enter a direct email address.",
    };
  }
  const name = fields.manual_name?.trim() ?? "";
  const email = fields.manual_email?.trim() ?? "";
  if (!name || !CONTACT_EMAIL_PATTERN.test(email)) {
    return {
      reach: null,
      error:
        "Choose an existing contact or enter a contact name and valid email address.",
    };
  }
  return {
    reach: {
      contact: {
        name,
        email,
        phone: nullableText(fields.manual_phone),
      },
    },
    error: "",
  };
}

function nullableText(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function nullableNumber(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableBoolean(value: string | undefined): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

/** Only acts and venues carry an organizer-set status; a contact has none. */
function statusOf(record: Record<string, unknown>): string | null {
  const status = record.status;
  return typeof status === "string" ? status : null;
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

function asPlaceholderType(value: string | undefined): "act" | "venue" | null {
  return value === "act" || value === "venue" ? value : null;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: adminHeaders() });
}

function notFound(): Response {
  return new Response("No such record in this season.", {
    status: 404,
    headers: { ...adminHeaders(), "content-type": "text/plain; charset=UTF-8" },
  });
}
