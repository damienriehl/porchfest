import type { CoreRuntime, DeletionReceipt } from "@porchfest/core";
import { escapeHtml } from "./signup-view.js";

type EligibleContact = ReturnType<
  CoreRuntime["retention"]["listEligible"]
>[number];

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

export interface RetentionNotice {
  readonly participantName: string;
  readonly kind: "confirmation" | "conflict";
}

export function renderRetentionPage(options: {
  readonly retentionMonths: number;
  readonly eligible: readonly EligibleContact[];
  readonly receipts: readonly DeletionReceipt[];
  readonly csrfToken: string;
  readonly anonymized: boolean;
  readonly notice?: RetentionNotice;
}): string {
  const notice = options.notice
    ? `<section class="error-summary" role="alert" tabindex="-1" aria-labelledby="retention-error-title">
      <h2 id="retention-error-title">${
        options.notice.kind === "conflict"
          ? "Anonymization conflict"
          : "Confirmation required"
      }</h2>
      <p>${escapeHtml(
        options.notice.kind === "conflict"
          ? `${options.notice.participantName} changed since you opened this page. Nothing was anonymized; review the refreshed participant below before trying again.`
          : `Confirm this irreversible action for ${options.notice.participantName}. Nothing was anonymized.`,
      )}</p>
    </section>`
    : "";
  const success = options.anonymized
    ? `<section role="status" aria-labelledby="retention-success-title">
      <h2 id="retention-success-title">Application anonymization recorded</h2>
      <p>The application data is anonymized. Backup removal is still pending until the operator completes the rotation procedure.</p>
    </section>`
    : "";

  return shell(
    "Participant retention",
    `    <header class="signup-header">
      <p class="eyebrow">Organizer data controls</p>
      <h1>Participant retention</h1>
      <p class="lede">Participants last updated before the ${options.retentionMonths}-month retention window are due for anonymization.</p>
      <p class="lede"><a href="/admin">Back to the activity queue</a></p>
    </header>
    ${notice}
    ${success}
    <section aria-labelledby="eligible-title">
      <h2 id="eligible-title">Due for anonymization</h2>
      <p class="help">Anonymization removes participant identity and linked private details. It cannot be undone.</p>
      ${
        options.eligible.length === 0
          ? `<p class="help">No participants are currently past the retention window.</p>`
          : `<ul class="queue-list">${options.eligible
              .map((contact) => eligibleParticipant(contact, options.csrfToken))
              .join("")}</ul>`
      }
    </section>
    <section aria-labelledby="receipts-title">
      <h2 id="receipts-title">Deletion receipts</h2>
      <p class="help">Each receipt separates the application work from the off-host backup work. Pending backup work means deletion is not yet complete.</p>
      ${
        options.receipts.length === 0
          ? `<p class="help">No anonymization receipts yet.</p>`
          : `<ul class="queue-list">${options.receipts.map(receipt).join("")}</ul>`
      }
    </section>`,
  );
}

function eligibleParticipant(
  contact: EligibleContact,
  csrfToken: string,
): string {
  const action = `/admin/retention/${contact.id}/anonymize`;
  return `<li class="queue-item">
      <div class="queue-item-body">
        <h3>${escapeHtml(contact.name)}</h3>
        <p class="help">Participant ${contact.id} · last updated ${formatDate(contact.updatedAt)}</p>
      </div>
      <form class="signup-form" method="post" action="${action}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="version" value="${contact.version}">
        <label>
          <input type="checkbox" name="confirmation" value="anonymize" required>
          I understand that anonymizing ${escapeHtml(contact.name)} cannot be undone.
        </label>
        <button class="primary-action" type="submit">Anonymize ${escapeHtml(contact.name)}</button>
      </form>
    </li>`;
}

function receipt(item: DeletionReceipt): string {
  const backup =
    item.backupStatus === "completed"
      ? `<strong>Backup rotation completed</strong>${
          item.backupCompletedAt
            ? ` on ${formatDate(item.backupCompletedAt)}`
            : ""
        }. Deletion complete.`
      : `<strong>Backup rotation pending</strong> — awaiting the next backup cycle. Deletion is not complete.`;
  return `<li class="queue-item">
      <div class="queue-item-body">
        <h3>Receipt ${item.id}</h3>
        <p><strong>Application data anonymized</strong> on ${formatDate(item.applicationAnonymizedAt)}.</p>
        <p>${backup}</p>
        <p class="help">Participant key ${item.contactId} · action ${escapeHtml(item.action)}</p>
      </div>
    </li>`;
}

function formatDate(value: Date): string {
  return `${escapeHtml(value.toISOString().slice(0, 16).replace("T", " "))} UTC`;
}
