// R11's review-before-send surface.
//
// The whole screen is built around one promise: nothing here transmits until an
// organizer presses a button that says so. Generation, editing and export are
// all reachable without a provider; the send control only exists when one is
// configured (AE1), and a sent message renders as history rather than as a form.
//
// One selection, two destinations. The list lives in a single form so an
// organizer ticks messages once; "Send selected" posts it, and the export
// buttons re-aim the same selection at the export route with
// `formmethod="get"`. Export is a read - it writes nothing and transmits
// nothing - so GET is the honest method, and it sidesteps the fact that a CSRF
// token is minted per route pattern: one form cannot carry two of them. The
// format rides on the submit button's own name/value, because a GET submission
// discards the query string written into `formaction`.

import {
  outboxWaveKinds,
  type OutboxMessage,
  type OutboxMessageState,
  type OutboxMessageView,
  type OutboxWave,
  type OutboxWaveKind,
  type QueueItem,
  type Season,
  type SendReport,
} from "@porchfest/core";
import { escapeHtml, renderOrganizerPage } from "./signup-view.js";

export const ADMIN_SCRIPT_PATH = "/admin/assets/admin.js";
export const SELECTION_FORM_ID = "outbox-selection";

/** The wave kinds an organizer can generate from a template. */
export const STANDARD_WAVE_KINDS = outboxWaveKinds.filter(
  (kind): kind is Exclude<OutboxWaveKind, "ad_hoc"> => kind !== "ad_hoc",
);

export const WAVE_KIND_LABELS: Readonly<Record<OutboxWaveKind, string>> = {
  thank_you: "Thank-you (porches without a match)",
  match: "Match notification (matched porches)",
  reminder_7day: "Seven-day reminder",
  day_of: "Day-of details",
  post_event: "Post-event follow-up",
  ad_hoc: "Ad-hoc",
};

/** Short enough to sit inside a button next to the full label. */
export const WAVE_KIND_SHORT_LABELS: Readonly<Record<OutboxWaveKind, string>> =
  {
    thank_you: "thank-you",
    match: "match notification",
    reminder_7day: "seven-day reminder",
    day_of: "day-of details",
    post_event: "post-event follow-up",
    ad_hoc: "ad-hoc",
  };

/**
 * A standard wave's stored label is a machine name ("reminder_7day"), so the
 * heading says what the wave is and the label stays visible beside it. An
 * ad-hoc wave has no template to name, so its label IS the heading.
 */
export function waveHeading(wave: Pick<OutboxWave, "kind" | "label">): string {
  return wave.kind === "ad_hoc" ? wave.label : WAVE_KIND_LABELS[wave.kind];
}

const STALE_NOTE = "Data changed since this was written";

const STATE_LABELS: Readonly<Record<OutboxMessageState, string>> = {
  generated: "Generated",
  edited: "Edited",
  sent: "Sent",
  generated_stale: `Generated · ${STALE_NOTE}`,
  edited_stale: `Edited · ${STALE_NOTE}`,
};

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  sent: "Sent",
  skipped: "Skipped",
  failed: "Failed",
};

/** `Contact` is not exported from core; the queue's own record shape is. */
export type OutboxContact = Extract<
  QueueItem,
  { readonly recordType: "contact" }
>["record"];

export interface ProviderStatus {
  readonly configured: boolean;
  readonly name: string;
}

export interface WaveSummary {
  readonly wave: OutboxWave;
  readonly counts: Readonly<Record<OutboxMessageState, number>>;
  readonly total: number;
}

function providerLine(provider: ProviderStatus): string {
  return provider.configured
    ? `<p class="help">Sending through ${escapeHtml(provider.name)}.</p>`
    : `<p class="help">No email provider configured — messages can be copied or exported.</p>`;
}

function errorSummary(heading: string, message: string | undefined): string {
  if (!message) return "";
  return `<section class="error-summary" role="alert" tabindex="-1"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p></section>`;
}

function confirmation(message: string | undefined): string {
  if (!message) return "";
  return `<section class="confirmation-card" role="status"><p>${escapeHtml(message)}</p></section>`;
}

/** A UTC-free stamp read in the season's own timezone. */
export function formatZonedStamp(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function countPhrases(summary: WaveSummary): string {
  const stale = summary.counts.generated_stale + summary.counts.edited_stale;
  const phrases = [
    summary.counts.generated === 0
      ? null
      : `${summary.counts.generated} generated`,
    summary.counts.edited === 0 ? null : `${summary.counts.edited} edited`,
    summary.counts.sent === 0 ? null : `${summary.counts.sent} sent`,
    stale === 0 ? null : `${stale} stale`,
  ].filter((phrase): phrase is string => phrase !== null);
  return phrases.length === 0 ? "no messages yet" : phrases.join(", ");
}

export function renderSeasonOutboxPage(options: {
  readonly season: Season;
  readonly provider: ProviderStatus;
  readonly waves: readonly WaveSummary[];
  readonly contacts: readonly OutboxContact[];
  readonly csrf: { readonly generate: string; readonly adHoc: string };
  readonly error?: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly selectedContactIds?: readonly number[];
}): string {
  const values = options.values ?? {};
  const selected = new Set(options.selectedContactIds ?? []);
  const waveRows = options.waves
    .map(
      (summary) => `<li class="queue-item">
      <div class="queue-item-body">
        <p class="queue-item-kind">Wave “${escapeHtml(summary.wave.label)}”</p>
        <h3><a href="/admin/outbox/waves/${summary.wave.id}">${escapeHtml(waveHeading(summary.wave))}</a></h3>
        <p class="help">${escapeHtml(countPhrases(summary))}${summary.wave.status === "complete" ? " · complete (bodies purged)" : ""}</p>
      </div>
    </li>`,
    )
    .join("");

  const generateForms = STANDARD_WAVE_KINDS.map(
    (kind) => `<li class="queue-item">
      <div class="queue-item-body">
        <h3>${escapeHtml(WAVE_KIND_LABELS[kind])}</h3>
      </div>
      <form class="signup-form" method="post" action="/admin/seasons/${options.season.id}/outbox/generate">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.generate)}">
        <input type="hidden" name="kind" value="${escapeHtml(kind)}">
        <button class="secondary-action" type="submit">Generate ${escapeHtml(WAVE_KIND_SHORT_LABELS[kind])}</button>
      </form>
    </li>`,
  ).join("");

  const contactChoices =
    options.contacts.length === 0
      ? `<p class="help">This season has no contacts to write to yet.</p>`
      : `<div class="checkboxes">${options.contacts
          .map(
            (contact) => `<label class="choice" for="contact-${contact.id}">
          <input id="contact-${contact.id}" name="contact" type="checkbox" value="${contact.id}"${selected.has(contact.id) ? " checked" : ""}>
          ${escapeHtml(contact.name)}${contact.email ? ` — ${escapeHtml(contact.email)}` : " — no address on file"}
        </label>`,
          )
          .join("")}</div>`;

  return renderOrganizerPage(
    "Email outbox",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)}</p>
      <h1>Email outbox</h1>
      <p class="lede">Every wave is generated here for review. Nothing is sent until you select messages and press send.</p>
      <p class="lede"><a href="/admin?season=${options.season.id}">Back to activity queue</a> · <a href="/admin/seasons/${options.season.id}">Season settings &amp; state</a></p>
      ${providerLine(options.provider)}
    </header>
    ${errorSummary("This wave was not created", options.error)}
    <section aria-labelledby="outbox-waves-title">
      <h2 id="outbox-waves-title">Waves in this season</h2>
      ${
        options.waves.length === 0
          ? `<p class="help">No waves generated yet.</p>`
          : `<ul class="queue-list">${waveRows}</ul>`
      }
    </section>
    <section aria-labelledby="outbox-generate-title">
      <h2 id="outbox-generate-title">Generate a wave</h2>
      <p class="help">Generating rewrites messages that are still generated, and leaves edited or sent messages alone.</p>
      <ul class="queue-list">${generateForms}</ul>
    </section>
    <section aria-labelledby="outbox-ad-hoc-title">
      <h2 id="outbox-ad-hoc-title">Ad-hoc wave</h2>
      <form class="signup-form" method="post" action="/admin/seasons/${options.season.id}/outbox/ad-hoc">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.adHoc)}">
        <div class="field">
          <label for="ad-hoc-label">Wave name</label>
          <p class="help" id="ad-hoc-label-help">Used to tell this wave apart from every other wave in the season.</p>
          <input id="ad-hoc-label" name="label" type="text" aria-describedby="ad-hoc-label-help" required value="${escapeHtml(values.label ?? "")}">
        </div>
        <div class="field">
          <label for="ad-hoc-subject">Subject</label>
          <input id="ad-hoc-subject" name="subject" type="text" required value="${escapeHtml(values.subject ?? "")}">
        </div>
        <div class="field">
          <label for="ad-hoc-text">Message</label>
          <p class="help" id="ad-hoc-text-help">Plain text. The HTML part is generated from what you write here.</p>
          <textarea id="ad-hoc-text" name="text" rows="10" aria-describedby="ad-hoc-text-help" required>${escapeHtml(values.text ?? "")}</textarea>
        </div>
        <fieldset class="choice-group">
          <legend>Who it goes to</legend>
          ${contactChoices}
        </fieldset>
        <button class="primary-action" type="submit">Create ad-hoc wave</button>
      </form>
    </section>`,
  );
}

export function renderOutboxWavePage(options: {
  readonly season: Season;
  readonly wave: OutboxWave;
  readonly messages: readonly OutboxMessageView[];
  readonly provider: ProviderStatus;
  readonly csrf: { readonly send: string; readonly generate: string };
  readonly generatedCount?: number;
  readonly error?: string;
}): string {
  const unsent = options.messages.filter(
    (message) => message.sentAt === null && message.state !== "sent",
  );
  const regenerate =
    options.wave.kind === "ad_hoc"
      ? `<p class="help">An ad-hoc wave is written by hand and is not regenerated.</p>`
      : `<form class="signup-form" method="post" action="/admin/seasons/${options.season.id}/outbox/generate">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.generate)}">
        <input type="hidden" name="kind" value="${escapeHtml(options.wave.kind)}">
        <input type="hidden" name="recipient_rule" value="${escapeHtml(options.wave.recipientRule)}">
        <p class="help">Regenerating rewrites messages that are still generated or stale. Edited and sent messages are left alone.</p>
        <button class="secondary-action" type="submit">Regenerate</button>
      </form>`;

  const list = options.messages
    .map((message) => renderMessageCard(options.season, message))
    .join("");

  const selectAll =
    unsent.length === 0
      ? ""
      : `<div class="field"><label class="choice" for="select-all">
        <input id="select-all" name="select_all" type="checkbox" value="all">
        Select every unsent message
      </label></div>`;

  const heading = waveHeading(options.wave);

  return renderOrganizerPage(
    `Outbox wave: ${heading}`,
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)}</p>
      <h1>${escapeHtml(heading)}</h1>
      <p class="lede">Wave “${escapeHtml(options.wave.label)}” · ${options.messages.length} ${options.messages.length === 1 ? "message" : "messages"}</p>
      <p class="lede"><a href="/admin/seasons/${options.season.id}/outbox">Back to the outbox</a></p>
      ${providerLine(options.provider)}
    </header>
    ${errorSummary("Nothing was sent", options.error)}
    ${confirmation(options.generatedCount === undefined ? undefined : `${options.generatedCount} ${options.generatedCount === 1 ? "message is" : "messages are"} ready for review.`)}
    <section aria-labelledby="outbox-regenerate-title">
      <h2 id="outbox-regenerate-title">Regenerate</h2>
      ${regenerate}
    </section>
    <section aria-labelledby="outbox-review-title">
      <h2 id="outbox-review-title">Review and send</h2>
      ${
        options.messages.length === 0
          ? `<p class="help">This wave has no messages. Regenerate it once the season has records to write to.</p>`
          : `<form class="signup-form" id="${SELECTION_FORM_ID}" method="post" action="/admin/outbox/waves/${options.wave.id}/send">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.send)}">
        ${selectAll}
        <ul class="queue-list">${list}</ul>
        <p class="help">Exporting never transmits anything; it hands you the text and the .eml files to send yourself.</p>
        ${
          options.provider.configured
            ? `<button class="primary-action" type="submit">Send selected</button>`
            : `<p class="help">Sending is unavailable until an email provider is configured.</p>`
        }
        <button class="secondary-action" type="submit" name="format" value="text" formmethod="get" formaction="/admin/outbox/waves/${options.wave.id}/export">Export selected</button>
        <button class="secondary-action" type="submit" name="format" value="eml" formmethod="get" formaction="/admin/outbox/waves/${options.wave.id}/export">Export selected as .eml</button>
      </form>`
      }
    </section>
    <script src="${ADMIN_SCRIPT_PATH}" defer></script>`,
  );
}

function renderMessageCard(season: Season, message: OutboxMessageView): string {
  const sendable = message.sentAt === null && message.state !== "sent";
  const recipients = message.recipients
    .map(
      (recipient) =>
        `<li>${escapeHtml(recipient.address)}${
          recipient.previousAddress
            ? ` <span class="help">(corrected from ${escapeHtml(recipient.previousAddress)} — needs resend)</span>`
            : ""
        }${
          recipient.outcome
            ? ` — ${escapeHtml(OUTCOME_LABELS[recipient.outcome] ?? recipient.outcome)}${
                recipient.sentAt
                  ? ` ${escapeHtml(formatZonedStamp(recipient.sentAt, season.timezone))}`
                  : ""
              }${recipient.reason ? `: ${escapeHtml(recipient.reason)}` : ""}`
            : " — not sent yet"
        }</li>`,
    )
    .join("");

  return `<li class="queue-item">
      <div class="queue-item-body">
        <p class="queue-item-kind">${escapeHtml(STATE_LABELS[message.state])}</p>
        <h3 id="message-${message.id}-subject"><a href="/admin/outbox/messages/${message.id}">${escapeHtml(message.subject)}</a></h3>
        <ul class="outbox-recipients">${recipients}</ul>
        <details>
          <summary>Read the message</summary>
          <pre class="outbox-body">${escapeHtml(bodyOrPurged(message))}</pre>
        </details>
        <p class="help"><a href="/admin/outbox/messages/${message.id}.eml">Download this message as .eml</a></p>
        ${
          sendable
            ? `<div class="field"><label class="choice" for="message-${message.id}">
          <input id="message-${message.id}" name="message" type="checkbox" value="${message.id}" aria-describedby="message-${message.id}-subject">
          Include this message
        </label></div>
        <input type="hidden" name="version_${message.id}" value="${message.version}">`
            : `<p class="help">This message was sent and cannot change.</p>`
        }
      </div>
    </li>`;
}

function bodyOrPurged(message: OutboxMessage): string {
  return (
    message.textBody ??
    "This wave is complete, so its body was purged. Regenerate the wave to read it again."
  );
}

export function renderOutboxMessagePage(options: {
  readonly season: Season;
  readonly wave: OutboxWave;
  readonly message: OutboxMessageView;
  readonly csrf: string;
  readonly values?: { readonly subject: string; readonly text: string };
  readonly error?: string;
  readonly saved?: boolean;
}): string {
  const message = options.message;
  const readOnly = message.sentAt !== null || message.state === "sent";
  const subject = options.values?.subject ?? message.subject;
  const text = options.values?.text ?? message.textBody ?? "";
  const history = message.recipients
    .map(
      (recipient) => `<div class="submission-row">
        <dt>${escapeHtml(recipient.address)}</dt>
        <dd>${
          recipient.outcome
            ? `${escapeHtml(OUTCOME_LABELS[recipient.outcome] ?? recipient.outcome)}${
                recipient.sentAt
                  ? ` ${escapeHtml(formatZonedStamp(recipient.sentAt, options.season.timezone))}`
                  : ""
              }${recipient.reason ? ` — ${escapeHtml(recipient.reason)}` : ""}`
            : "Not sent yet"
        }${
          recipient.previousAddress
            ? ` (corrected from ${escapeHtml(recipient.previousAddress)} — needs resend)`
            : ""
        }</dd>
      </div>`,
    )
    .join("");

  const editor = readOnly
    ? `<p class="help">This message was sent and cannot change.</p>
      <h3>Subject</h3>
      <p>${escapeHtml(message.subject)}</p>
      <h3>Message</h3>
      <pre class="outbox-body">${escapeHtml(bodyOrPurged(message))}</pre>`
    : `<form class="signup-form" method="post" action="/admin/outbox/messages/${message.id}">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf)}">
        <input type="hidden" name="version" value="${message.version}">
        <div class="field">
          <label for="message-subject">Subject</label>
          <input id="message-subject" name="subject" type="text" required value="${escapeHtml(subject)}">
        </div>
        <div class="field">
          <label for="message-text">Message</label>
          <p class="help" id="message-text-help">Plain text. Saving rewrites the HTML part from this text, so the two can never disagree.</p>
          <textarea id="message-text" name="text" rows="18" aria-describedby="message-text-help" required>${escapeHtml(text)}</textarea>
        </div>
        <button class="primary-action" type="submit">Save this message</button>
      </form>`;

  return renderOrganizerPage(
    `Outbox message: ${message.subject}`,
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)} · ${escapeHtml(waveHeading(options.wave))}</p>
      <h1>Review this message</h1>
      <p class="lede">${escapeHtml(STATE_LABELS[message.state])}</p>
      <p class="lede"><a href="/admin/outbox/waves/${options.wave.id}">Back to the wave</a></p>
    </header>
    ${errorSummary("This message was not saved", options.error)}
    ${confirmation(options.saved ? "Your edit was saved. It will send exactly as written." : undefined)}
    <section aria-labelledby="outbox-editor-title">
      <h2 id="outbox-editor-title">Text</h2>
      ${editor}
    </section>
    <section aria-labelledby="outbox-preview-title">
      <h2 id="outbox-preview-title">HTML preview</h2>
      <p class="help">Generated from the text above. Recipients whose mail client prefers HTML see this.</p>
      <div class="outbox-preview">${message.htmlBody ?? "<p>This wave is complete, so its body was purged.</p>"}</div>
    </section>
    <section aria-labelledby="outbox-history-title">
      <h2 id="outbox-history-title">Recipients and send history</h2>
      <dl class="submission-list">${history || '<div class="submission-row"><dt>No recipients</dt><dd>Nobody on this message has an address on file.</dd></div>'}</dl>
      <p class="help"><a href="/admin/outbox/messages/${message.id}.eml">Download this message as .eml</a></p>
    </section>`,
  );
}

export function renderOutboxSendResultPage(options: {
  readonly season: Season;
  readonly wave: OutboxWave;
  readonly report: SendReport;
}): string {
  const rows = options.report.recipients
    .map(
      (outcome) => `<div class="submission-row">
        <dt>${escapeHtml(outcome.address)}</dt>
        <dd>${escapeHtml(OUTCOME_LABELS[outcome.status] ?? outcome.status)}${outcome.reason ? ` — ${escapeHtml(outcome.reason)}` : ""}</dd>
      </div>`,
    )
    .join("");

  return renderOrganizerPage(
    "Send results",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)} · ${escapeHtml(options.wave.label)}</p>
      <h1>Send results</h1>
      <p class="lede">${options.report.sent} sent, ${options.report.skipped} skipped, ${options.report.failed} failed of ${options.report.attempted} attempted.</p>
      <p class="lede"><a href="/admin/outbox/waves/${options.wave.id}">Back to the wave</a></p>
    </header>
    <section aria-labelledby="outbox-results-title">
      <h2 id="outbox-results-title">Every recipient</h2>
      ${
        options.report.recipients.length === 0
          ? `<p class="help">Nothing was attempted: every selected message had already been sent.</p>`
          : `<dl class="submission-list">${rows}</dl>`
      }
      <p class="help">A failed or skipped recipient keeps no send stamp, so the next send tries them again.</p>
    </section>`,
  );
}
