import type { QueueItem, QueueRecordType } from "@porchfest/core";
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
  readonly csrfToken: string;
  readonly signOutCsrf: string;
}): string {
  const newItems = options.items.filter((item) => item.isNew);
  const seen = options.items.filter((item) => !item.isNew);

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

  return shell(
    "Activity queue",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.seasonName)}</p>
      <h1>Welcome, ${escapeHtml(options.organizerName)}</h1>
      <p class="lede">${newItems.length === 0 ? "Nothing new for you right now." : `${newItems.length} ${newItems.length === 1 ? "item needs" : "items need"} your review.`}</p>
    </header>
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
  readonly csrfToken: string;
  readonly saved?: boolean;
  readonly statusCsrfToken?: string;
  readonly conflicts?: readonly ConflictDetail[];
}): string {
  const fields = RECORD_FIELDS[options.recordType];
  const conflicts = options.conflicts ?? [];

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
      <h2 id="conflict-title">Someone else saved this first</h2>
      <p>Your answers are below, unchanged. Here is what is stored now — save again to overwrite it, or edit yours first.</p>
      <dl class="submission-list">${conflicts
        .map(
          (conflict) =>
            `<div class="submission-row"><dt>${escapeHtml(conflict.label)}</dt><dd><strong>Yours:</strong> ${escapeHtml(conflict.attempted || "(empty)")}<br><strong>Stored:</strong> ${escapeHtml(conflict.stored || "(empty)")}</dd></div>`,
        )
        .join("")}</dl>
    </section>`;

  return shell(
    options.title,
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.recordType)}</p>
      <h1>${escapeHtml(options.title || "Untitled")}</h1>
      <p class="lede"><a href="/admin?season=${options.seasonId}">Back to the queue</a></p>
    </header>
    ${options.saved ? `<section class="confirmation" role="status"><p class="eyebrow success-mark">Saved</p></section>` : ""}
    ${
      options.status
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
    <form class="signup-form" method="post" action="/admin/records/${escapeHtml(options.recordType)}/${options.recordId}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="season" value="${options.seasonId}">
      <input type="hidden" name="version" value="${options.version}">
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
    </form>`,
  );
}
