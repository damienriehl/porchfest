import type {
  ParticipantChangeRequest,
  QueueItem,
  QueueRecordType,
  SeasonState,
} from "@porchfest/core";
import { escapeHtml } from "./signup-view.js";

export interface RecordFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "textarea" | "boolean" | "number";
  readonly help?: string;
}

/** The editable shape of each record type, in one place so the form, the parser
 *  and the conflict view cannot drift apart. */
export const RECORD_FIELDS: Readonly<
  Record<QueueRecordType, readonly RecordFieldSpec[]>
> = {
  venue: [
    { name: "title", label: "Porch name", kind: "text" },
    { name: "address", label: "Street address", kind: "text" },
    { name: "spaceDescription", label: "Performance space", kind: "textarea" },
    { name: "hasPower", label: "Electrical power", kind: "boolean" },
    { name: "rainBackup", label: "Rain backup", kind: "boolean" },
    {
      name: "requestedActNames",
      label: "Requested acts",
      kind: "textarea",
    },
    {
      name: "genrePreferences",
      label: "Genre preferences",
      kind: "textarea",
    },
    { name: "notes", label: "Notes for the organizers", kind: "textarea" },
  ],
  act: [
    { name: "name", label: "Act name", kind: "text" },
    { name: "genre", label: "Genres", kind: "text" },
    { name: "description", label: "Act description", kind: "textarea" },
    { name: "links", label: "Music and website links", kind: "textarea" },
    {
      name: "durationMinutes",
      label: "Set duration in minutes",
      kind: "number",
    },
    { name: "requiresAmplification", label: "Amplification", kind: "boolean" },
    { name: "canLendGear", label: "Can lend gear", kind: "boolean" },
    { name: "housePreference", label: "Porch preference", kind: "textarea" },
    {
      name: "sharedMemberNote",
      label: "Members in other acts",
      kind: "textarea",
    },
    { name: "notes", label: "Notes for the organizers", kind: "textarea" },
  ],
  contact: [
    { name: "name", label: "Name", kind: "text" },
    { name: "email", label: "Email", kind: "text" },
    { name: "phone", label: "Phone", kind: "text" },
  ],
};

export function recordTitle(item: QueueItem): string {
  if (item.recordType === "act") return item.record.name;
  if (item.recordType === "venue") return item.record.title;
  return item.record.name;
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Porchfest organizers</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body>
  <main class="signup-page">
${body}
  </main>
</body>
</html>`;
}

export function renderQueuePage(options: {
  readonly organizerName: string;
  readonly seasonName: string;
  readonly seasonId: number;
  readonly items: readonly QueueItem[];
  readonly changeRequests: readonly ParticipantChangeRequest[];
  readonly correctionsClosed: boolean;
  readonly csrfToken: string;
  readonly applyChangeCsrfToken: string;
  readonly rejectChangeCsrfToken: string;
  readonly signOutCsrf: string;
}): string {
  const newItems = options.items.filter((item) => item.isNew);
  const seen = options.items.filter((item) => !item.isNew);
  const needsReview = newItems.length + options.changeRequests.length;

  const card = (item: QueueItem) => `<li class="queue-item">
      <div class="queue-item-body">
        <p class="queue-item-kind">${escapeHtml(item.recordType)}</p>
        <h3><a href="/admin/records/${escapeHtml(item.recordType)}/${item.record.id}?season=${options.seasonId}">${escapeHtml(recordTitle(item) || "Untitled")}</a></h3>
        <p class="help">Updated ${escapeHtml(item.updatedAt.toISOString().slice(0, 16).replace("T", " "))} UTC · version ${item.version}</p>
      </div>
      ${
        item.isNew
          ? `<form method="post" action="/admin/queue/dismiss">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
        <input type="hidden" name="season" value="${options.seasonId}">
        <input type="hidden" name="record_type" value="${escapeHtml(item.recordType)}">
        <input type="hidden" name="record_id" value="${item.record.id}">
        <input type="hidden" name="version" value="${item.version}">
        <button class="secondary-action" type="submit">Mark reviewed</button>
      </form>`
          : ""
      }
    </li>`;

  const changeRequestCard = (request: ParticipantChangeRequest) => {
    const label =
      request.kind === "withdrawal"
        ? "Withdrawal"
        : request.kind === "availability"
          ? "Availability change"
          : "Address correction";
    const proposal =
      request.kind === "withdrawal"
        ? "Participant asked to withdraw this record."
        : request.kind === "address"
          ? (request.proposedAddress ?? "")
          : (request.proposedAvailability ?? [])
              .map(formatAvailabilityWindow)
              .join(", ") || "No availability";
    return `<li class="queue-item change-request-item">
      <div class="queue-item-body">
        <p class="queue-item-kind">Change request · ${escapeHtml(request.recordType)}</p>
        <h3>${escapeHtml(label)}</h3>
        <p>${escapeHtml(proposal)}</p>
        <p class="help">Target record ${request.recordId} · record version ${request.recordVersion}</p>
        ${request.applicable ? "" : '<p class="help">This record changed after the request was filed. It can no longer be applied; reject it after reviewing the current record.</p>'}
      </div>
      <div class="queue-item-actions">
        ${
          request.applicable
            ? `<form method="post" action="/admin/change-requests/${request.id}/apply">
          <input type="hidden" name="_csrf" value="${escapeHtml(options.applyChangeCsrfToken)}">
          <input type="hidden" name="season" value="${options.seasonId}">
          <input type="hidden" name="version" value="${request.version}">
          <button class="primary-action" type="submit">${request.kind === "address" ? "Review in editor" : "Apply"}</button>
        </form>`
            : ""
        }
        <form method="post" action="/admin/change-requests/${request.id}/reject">
          <input type="hidden" name="_csrf" value="${escapeHtml(options.rejectChangeCsrfToken)}">
          <input type="hidden" name="season" value="${options.seasonId}">
          <input type="hidden" name="version" value="${request.version}">
          <button class="secondary-action" type="submit">Reject</button>
        </form>
      </div>
    </li>`;
  };

  return shell(
    "Activity queue",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.seasonName)}</p>
      <h1>Welcome, ${escapeHtml(options.organizerName)}</h1>
      <p class="lede">${needsReview === 0 ? "Nothing new for you right now." : `${needsReview} ${needsReview === 1 ? "item needs" : "items need"} your review.`}</p>
      ${options.correctionsClosed ? "" : `<p class="lede"><a href="/admin/placeholders/act/new?season=${options.seasonId}">Add an act without a submission</a> · <a href="/admin/placeholders/venue/new?season=${options.seasonId}">Add a venue without a submission</a></p>`}
      <p class="lede"><a href="/admin/retention">Review participant retention</a></p>
      <p class="lede"><a href="/admin/seasons/${options.seasonId}">Season settings &amp; state</a></p>
    </header>
    <section aria-labelledby="change-requests-title">
      <h2 id="change-requests-title">Change requests needing a decision</h2>
      <p class="help">Assignments remain unchanged until you apply a request. Rejecting closes it without changing the record.</p>
      ${
        options.changeRequests.length === 0
          ? `<p class="help">No pending change requests.</p>`
          : `<ul class="queue-list">${options.changeRequests.map(changeRequestCard).join("")}</ul>`
      }
    </section>
    <section aria-labelledby="queue-title">
      <h2 id="queue-title">New for you</h2>
      <p class="help">Marking an item reviewed clears it for you only — another organizer still sees it.</p>
      ${
        newItems.length === 0
          ? `<p class="help">You are all caught up.</p>`
          : `<ul class="queue-list">${newItems.map(card).join("")}</ul>`
      }
    </section>
    <section aria-labelledby="records-title">
      <h2 id="records-title">Everything in this season</h2>
      ${
        seen.length === 0
          ? `<p class="help">Nothing reviewed yet.</p>`
          : `<ul class="queue-list">${seen.map(card).join("")}</ul>`
      }
    </section>
    <form class="signup-form" method="post" action="/admin/sign-out">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.signOutCsrf)}">
      <button class="secondary-action" type="submit">Sign out</button>
    </form>`,
  );
}

function formatAvailabilityWindow({
  startsAt,
  endsAt,
}: {
  readonly startsAt: Date;
  readonly endsAt: Date;
}): string {
  const start = startsAt.toISOString();
  const end = endsAt.toISOString();
  const endDisplay =
    start.slice(0, 10) === end.slice(0, 10)
      ? end.slice(11, 16)
      : end.slice(0, 16).replace("T", " ");
  return `${start.slice(0, 16).replace("T", " ")}–${endDisplay} UTC`;
}

export interface LifecycleRecordOption {
  readonly id: number;
  readonly version: number;
  readonly title: string;
}

export interface ReachContactOption {
  readonly id: number;
  readonly title: string;
}

// R26 deliberately presents both reachability modes together. Organizers often
// know the host first, but can still enter a direct address when nobody already
// in the season should act as intermediary.
export function renderPlaceholderPage(options: {
  readonly recordType: "act" | "venue";
  readonly seasonId: number;
  readonly csrfToken: string;
  readonly contacts: readonly ReachContactOption[];
  readonly values?: Readonly<Record<string, string>>;
  readonly error?: string;
  readonly formDisabled?: boolean;
}): string {
  const fields = RECORD_FIELDS[options.recordType];
  const values = options.values ?? {};
  const kind = options.recordType;
  const fieldControl = (spec: RecordFieldSpec) => {
    const value = values[spec.name] ?? "";
    if (spec.kind === "textarea") {
      return `<textarea id="placeholder_${escapeHtml(spec.name)}" name="${escapeHtml(spec.name)}" rows="4">${escapeHtml(value)}</textarea>`;
    }
    if (spec.kind === "boolean") {
      return `<div class="choices">${["yes", "no"]
        .map(
          (choice) =>
            `<label class="choice"><input type="radio" name="${escapeHtml(spec.name)}" value="${choice}"${value === choice ? " checked" : ""}><span>${choice === "yes" ? "Yes" : "No"}</span></label>`,
        )
        .join("")}</div>`;
    }
    return `<input id="placeholder_${escapeHtml(spec.name)}" name="${escapeHtml(spec.name)}" type="${spec.kind === "number" ? "number" : "text"}" value="${escapeHtml(value)}"${spec.name === "name" || spec.name === "title" ? " required" : ""}>`;
  };

  return shell(
    `Add placeholder ${kind}`,
    `    <header class="signup-header">
      <p class="eyebrow">Organizer placeholder</p>
      <h1>Add ${kind} without a submission</h1>
      <p class="lede"><a href="/admin?season=${options.seasonId}">Back to the queue</a></p>
    </header>
    ${options.error ? `<section class="error-summary" role="alert"><h2>Check the placeholder</h2><p>${escapeHtml(options.error)}</p></section>` : ""}
    ${
      options.formDisabled
        ? ""
        : `<form class="signup-form" method="post" action="/admin/placeholders/${kind}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <fieldset>
        <legend>${kind === "act" ? "Act" : "Venue"} details</legend>
        ${fields
          .map(
            (spec) => `<div class="field">
          <label for="placeholder_${escapeHtml(spec.name)}">${escapeHtml(spec.label)}</label>
          ${fieldControl(spec)}
        </div>`,
          )
          .join("")}
      </fieldset>
      <fieldset>
        <legend>How organizers can reach them</legend>
        <p class="help">Choose an existing party who can pass messages along, or enter a direct email address below.</p>
        <div class="field">
          <label for="reach_via_contact_id">Reach through an existing contact</label>
          <select id="reach_via_contact_id" name="reach_via_contact_id">
            <option value="">Enter a direct address instead</option>
            ${options.contacts.map((contact) => `<option value="${contact.id}"${values.reach_via_contact_id === String(contact.id) ? " selected" : ""}>${escapeHtml(contact.title)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label for="manual_name">Direct contact name</label><input id="manual_name" name="manual_name" type="text" value="${escapeHtml(values.manual_name ?? "")}"></div>
        <div class="field"><label for="manual_email">Direct email address</label><input id="manual_email" name="manual_email" type="email" value="${escapeHtml(values.manual_email ?? "")}"></div>
        <div class="field"><label for="manual_phone">Direct phone (optional)</label><input id="manual_phone" name="manual_phone" type="text" value="${escapeHtml(values.manual_phone ?? "")}"></div>
      </fieldset>
      <button class="primary-action" type="submit">Create placeholder</button>
    </form>`
    }`,
  );
}

export interface ConflictDetail {
  readonly field: string;
  readonly label: string;
  readonly attempted: string;
  readonly stored: string;
}

export function renderRecordPage(options: {
  readonly recordType: QueueRecordType;
  readonly status?: string | null;
  readonly recordId: number;
  readonly seasonId: number;
  readonly title: string;
  readonly version: number;
  readonly values: Readonly<Record<string, string>>;
  readonly staticValues: Readonly<Record<string, string>>;
  readonly csrfToken: string;
  readonly correctionsClosed: boolean;
  readonly seasonState: SeasonState;
  readonly saved?: boolean;
  readonly statusCsrfToken?: string;
  readonly conflicts?: readonly ConflictDetail[];
  readonly refusal?: { readonly title: string; readonly message: string };
  readonly changeRequestReview?: {
    readonly id: number;
    readonly presentation?: "proposal";
  };
  readonly promotion?: {
    readonly csrfToken: string;
    readonly candidates: readonly LifecycleRecordOption[];
  };
  readonly supersession?: {
    readonly csrfToken: string;
    readonly candidates: readonly LifecycleRecordOption[];
  };
}): string {
  const fields = RECORD_FIELDS[options.recordType];
  const conflicts = options.correctionsClosed ? [] : (options.conflicts ?? []);
  const proposalPresentation =
    options.changeRequestReview?.presentation === "proposal";
  const refusalBlock = options.refusal
    ? `<section class="error-summary" role="alert"><h2>${escapeHtml(options.refusal.title)}</h2><p>${escapeHtml(options.refusal.message)}</p></section>`
    : "";
  const correctionsClosedBlock = options.correctionsClosed
    ? `<section class="confirmation" role="status" tabindex="-1" aria-labelledby="corrections-closed-title"><h2 id="corrections-closed-title">${escapeHtml(correctionsClosedMessage(options.seasonState))}</h2></section>`
    : "";

  const control = (spec: RecordFieldSpec) => {
    const value = options.values[spec.name] ?? "";
    const id = `field_${spec.name}`;
    if (spec.kind === "textarea") {
      return `<textarea id="${id}" name="${escapeHtml(spec.name)}" rows="4">${escapeHtml(value)}</textarea>`;
    }
    if (spec.kind === "boolean") {
      return `<div class="choices">${["yes", "no"]
        .map(
          (choice) =>
            `<label class="choice"><input type="radio" name="${escapeHtml(spec.name)}" value="${choice}"${value === choice ? " checked" : ""}><span>${choice === "yes" ? "Yes" : "No"}</span></label>`,
        )
        .join("")}</div>`;
    }
    const type = spec.kind === "number" ? "number" : "text";
    return `<input id="${id}" name="${escapeHtml(spec.name)}" type="${type}" value="${escapeHtml(value)}">`;
  };

  // R32: a refused save shows what the organizer typed BESIDE what is stored, and
  // re-arms the form against the refreshed version. Discarding their work and
  // showing the stored row would be the same as overwriting, from their side.
  const conflictBlock =
    conflicts.length === 0
      ? ""
      : `<section class="error-summary" role="alert" tabindex="-1" aria-labelledby="conflict-title">
      <h2 id="conflict-title">${proposalPresentation ? "Review the participant's proposed correction" : "Someone else saved this first"}</h2>
      <p>${proposalPresentation ? "The participant proposed the value below. The stored value has not changed; saving this form accepts the proposal." : "Your answers are below, unchanged. Here is what is stored now — save again to overwrite it, or edit yours first."}</p>
      <dl class="submission-list">${conflicts
        .map(
          (conflict) =>
            `<div class="submission-row"><dt>${escapeHtml(conflict.label)}</dt><dd><strong>${proposalPresentation ? "Participant proposed" : "Yours"}:</strong> ${escapeHtml(conflict.attempted || "(empty)")}<br><strong>Stored:</strong> ${escapeHtml(conflict.stored || "(empty)")}</dd></div>`,
        )
        .join("")}</dl>
    </section>`;

  const promotionBlock =
    !options.correctionsClosed && options.promotion
      ? `<form class="signup-form" method="post" action="/admin/records/${escapeHtml(options.recordType)}/${options.recordId}/promote">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.promotion.csrfToken)}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <input type="hidden" name="version" value="${options.version}">
      <fieldset><legend>Promote a submitted form into this placeholder</legend>
        <p class="help">The submitted details become canonical here. Existing matches and email history follow this record.</p>
        <label for="promotion_submission">Submitted ${escapeHtml(options.recordType)}</label>
        <select id="promotion_submission" name="submission" required>
          <option value="">Choose a submission</option>
          ${options.promotion.candidates.map((candidate) => `<option value="${candidate.id}:${candidate.version}">${escapeHtml(candidate.title)} · version ${candidate.version}</option>`).join("")}
        </select>
      </fieldset>
      <button class="primary-action" type="submit">Promote submission</button>
    </form>`
      : "";

  const supersessionBlock =
    !options.correctionsClosed && options.supersession
      ? `<form class="signup-form" method="post" action="/admin/records/${escapeHtml(options.recordType)}/${options.recordId}/supersede">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.supersession.csrfToken)}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <input type="hidden" name="version" value="${options.version}">
      <fieldset><legend>Reconcile this record as a resubmission</legend>
        <p class="help">This record will be marked superseded and disappear from new activity. Its history remains linked to the canonical record.</p>
        <label for="supersession_canonical">Canonical ${escapeHtml(options.recordType)}</label>
        <select id="supersession_canonical" name="canonical_id" required>
          <option value="">Choose the record to keep</option>
          ${options.supersession.candidates.map((candidate) => `<option value="${candidate.id}">${escapeHtml(candidate.title)} · version ${candidate.version}</option>`).join("")}
        </select>
      </fieldset>
      <button class="secondary-action" type="submit">Mark this record superseded</button>
    </form>`
      : "";

  return shell(
    options.title,
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.recordType)}</p>
      <h1>${escapeHtml(options.title || "Untitled")}</h1>
      <p class="lede"><a href="/admin?season=${options.seasonId}">Back to the queue</a></p>
    </header>
    ${correctionsClosedBlock}
    ${options.saved ? `<section class="confirmation" role="status"><p class="eyebrow success-mark">Saved</p></section>` : ""}
    ${refusalBlock}
    ${
      !options.correctionsClosed && options.status
        ? `<form class="signup-form status-form" method="post" action="/admin/records/${escapeHtml(options.recordType)}/${options.recordId}/status">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.statusCsrfToken ?? "")}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <input type="hidden" name="version" value="${options.version}">
      <fieldset class="choice-group field" id="status">
        <legend>Status</legend>
        <p class="help">Withdrawing reopens any slot this record holds. The email history is kept either way.</p>
        <div class="choices">${["tentative", "confirmed", "withdrawn"]
          .map(
            (choice) =>
              `<label class="choice"><input type="radio" name="status" value="${choice}"${options.status === choice ? " checked" : ""}><span>${choice[0]?.toUpperCase()}${choice.slice(1)}</span></label>`,
          )
          .join("")}</div>
      </fieldset>
      <button class="secondary-action" type="submit">Set status</button>
    </form>`
        : ""
    }
    ${conflictBlock}
    ${promotionBlock}
    ${supersessionBlock}
    ${
      options.correctionsClosed
        ? `<section class="submission" aria-labelledby="record-details-title">
      <h2 id="record-details-title">Details</h2>
      <dl class="submission-list">${[
        ...(options.status
          ? [{ label: "Status", value: readableStaticValue(options.status) }]
          : []),
        ...fields.map((spec) => ({
          label: spec.label,
          value: readableStaticValue(
            options.staticValues[spec.name] ?? "",
            spec,
          ),
        })),
      ]
        .map(
          ({ label, value }) =>
            `<div class="submission-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join("")}</dl>
    </section>`
        : `<form class="signup-form" method="post" action="/admin/records/${escapeHtml(options.recordType)}/${options.recordId}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <input type="hidden" name="version" value="${options.version}">
      ${options.changeRequestReview ? `<input type="hidden" name="change_request" value="${options.changeRequestReview.id}">` : ""}
      <fieldset>
        <legend>Details</legend>
        ${fields
          .map(
            (spec) => `<div class="field">
          <label for="field_${escapeHtml(spec.name)}">${escapeHtml(spec.label)}</label>
          <div class="field-error-slot"></div>
          ${control(spec)}
        </div>`,
          )
          .join("")}
      </fieldset>
      <button class="primary-action" type="submit">Save changes</button>
    </form>`
    }`,
  );
}

function correctionsClosedMessage(state: SeasonState): string {
  return state === "archived"
    ? "This season is archived. Records can no longer be changed."
    : `The season's current state is ${state}. Records can no longer be changed.`;
}

function readableStaticValue(value: string, spec?: RecordFieldSpec): string {
  if (value.length === 0) return "(empty)";
  if (spec?.kind === "boolean" || spec === undefined) {
    return `${value[0]?.toUpperCase()}${value.slice(1)}`;
  }
  return value;
}
