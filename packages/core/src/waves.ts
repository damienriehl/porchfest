// R10's deterministic wave rendering, kept deliberately pure: no database, no
// clock, no adapter. Everything a template can say arrives in a RenderContext
// that `outbox.ts` builds from database rows, so every byte of a generated
// message is traceable to a record rather than to something this module knew.
//
// The five Goal-1 templates are ported verbatim, with one substitution: the
// literal "SAP Porchfest" became {{event_name}} so another neighborhood can run
// the same waves. A sixth post-event template covers R24's follow-up.

import { createHash } from "node:crypto";
import {
  CRLF,
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatRfc5322Date,
} from "./mime.js";

export class WaveTemplateError extends Error {
  override readonly name = "WaveTemplateError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Every placeholder any template may use. A context is checked against the
 * template it renders, not against this list, but naming them makes a typo in a
 * caller a type error rather than a runtime throw.
 */
export const wavePlaceholders = [
  "event_name",
  "event_date_display",
  "event_time_display",
  "map_url",
  "organizer_signature",
  "organizer_name",
  "organizer_phone",
  "venue_title",
  "address_display",
  "space_line",
  "electrical_line",
  "rain_line",
  "notes_block",
  "status_note",
  "status_lines",
  "host_first_name",
  "performer_greeting_names",
  "greeting_names",
  "participation_line",
  "band_name",
  "slot_lines",
  "slot_summary",
  "contact_lines",
  "logistics_lines",
  "asks_lines",
  "followup_lines",
] as const;

export type WavePlaceholder = (typeof wavePlaceholders)[number];

export type RenderContext = Readonly<Partial<Record<WavePlaceholder, string>>>;

/**
 * A template key is finer-grained than a stored wave kind: one `thank_you` wave
 * addresses unmatched venues with one letter and floating performers with
 * another, so the record type picks the template while the wave keeps its kind.
 */
export const waveTemplateKeys = [
  "match",
  "thank_you_venue",
  "floating_performer",
  "reminder_7day",
  "day_of",
  "post_event",
] as const;

export type WaveTemplateKey = (typeof waveTemplateKeys)[number];

const MATCH_TEMPLATE = `Subject: {{event_name}} {{event_date_display}}: {{address_display}} — you're matched!

Hi {{host_first_name}} and {{performer_greeting_names}},

Thank you for signing up for {{event_name}} — {{event_date_display}}, {{event_time_display}}. Here's your match! You're all on this email together so you can coordinate directly — just reply-all.

THE MATCH
{{slot_lines}}

VENUE
- Porch: {{venue_title}}
- Address: {{address_display}}
- Space: {{space_line}}
- Power: {{electrical_line}}
- Rain plan: {{rain_line}}

PEOPLE
{{contact_lines}}

GEAR & LOGISTICS
{{logistics_lines}}

{{notes_block}}

PLEASE DO THIS
{{asks_lines}}

The event map at {{map_url}} will show every porch and act as matches confirm.

Thanks for making the neighborhood sing!

{{organizer_signature}}`;

const THANK_YOU_VENUE_TEMPLATE = `Subject: {{event_name}} {{event_date_display}}: thank you — {{address_display}}

Hi {{host_first_name}},

Thank you for offering {{address_display}} for {{event_name}} ({{event_date_display}}, {{event_time_display}})!

{{status_note}}

We'll follow up as matching continues — and the event map at {{map_url}} will grow as matches confirm.

{{organizer_signature}}`;

const FLOATING_PERFORMER_TEMPLATE = `Subject: {{event_name}} {{event_date_display}}: {{band_name}} — almost matched!

Hi {{performer_greeting_names}},

Thank you for signing up for {{event_name}} ({{event_date_display}}, {{event_time_display}})!

{{status_lines}}

{{asks_lines}}

More soon — thanks for playing!

{{organizer_signature}}`;

const REMINDER_7DAY_TEMPLATE = `Subject: {{event_name}} is in one week — {{address_display}}, {{slot_summary}}

Hi {{host_first_name}} and {{performer_greeting_names}},

One week to {{event_name}} — {{event_date_display}}, {{event_time_display}}.

YOUR DETAILS
{{slot_lines}}
- Address: {{address_display}}
- Power: {{electrical_line}}
- Rain plan: {{rain_line}}
{{logistics_lines}}

BEFORE THE DAY
- Hosts: confirm any gear you're providing works; clear the performance space.
- Performers: confirm arrival/setup time directly with your host (reply-all works).
- Everyone: the live map is at {{map_url}} — check your listing and tell us if anything's off.

See you on the porch!

{{organizer_signature}}`;

const DAY_OF_TEMPLATE = `Subject: Today is {{event_name}}! {{address_display}}, {{slot_summary}}

Hi {{host_first_name}} and {{performer_greeting_names}},

It's Porchfest day — music from {{event_time_display}} tonight.

{{slot_lines}}
- Address: {{address_display}}
- Map of every porch: {{map_url}}

Weather plan: {{rain_line}}

Day-of questions or emergencies: reply here or text {{organizer_name}} at {{organizer_phone}}.

Have a blast — and thank you for making this happen.

{{organizer_signature}}`;

// R24's follow-up. Its body is deliberately short: {{followup_lines}} is the
// part an organizer rewrites in the outbox before anything is sent.
const POST_EVENT_TEMPLATE = `Subject: Thank you for being part of {{event_name}} — {{event_date_display}}

Hi {{greeting_names}},

Thank you for being part of {{event_name}} on {{event_date_display}}. {{participation_line}}

{{followup_lines}}

The map of every porch stays up at {{map_url}} for a while yet.

{{organizer_signature}}`;

export const waveTemplates: Readonly<Record<WaveTemplateKey, string>> =
  Object.freeze({
    match: MATCH_TEMPLATE,
    thank_you_venue: THANK_YOU_VENUE_TEMPLATE,
    floating_performer: FLOATING_PERFORMER_TEMPLATE,
    reminder_7day: REMINDER_7DAY_TEMPLATE,
    day_of: DAY_OF_TEMPLATE,
    post_event: POST_EVENT_TEMPLATE,
  });

const PLACEHOLDER_PATTERN = /\{\{([a-z0-9_]+)\}\}/g;

export interface RenderedWave {
  readonly subject: string;
  readonly text: string;
}

function fill(template: string, context: RenderContext): string {
  return template.replaceAll(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = (context as Record<string, string | undefined>)[name];
    // A missing value must never reach a participant as literal braces, and
    // must never be quietly blanked either: both hide a wiring mistake until an
    // organizer reads it in their own inbox.
    if (value === undefined) {
      throw new WaveTemplateError(
        `wave placeholder ${name} has no value in this render context`,
      );
    }
    return value;
  });
}

/**
 * Render one wave. Same context in, byte-identical output every time: nothing
 * here reads a clock, a locale default, or an environment variable.
 */
export function renderWave(
  kind: WaveTemplateKey,
  context: RenderContext,
): RenderedWave {
  const template = waveTemplates[kind];
  if (template === undefined) {
    throw new WaveTemplateError(`unknown wave template ${String(kind)}`);
  }
  const filled = fill(template, context);
  const firstBreak = filled.indexOf("\n");
  const subjectLine = firstBreak === -1 ? filled : filled.slice(0, firstBreak);
  if (!subjectLine.startsWith("Subject: ")) {
    throw new WaveTemplateError(`wave template ${kind} has no subject line`);
  }
  const body = firstBreak === -1 ? "" : filled.slice(firstBreak + 1);
  return {
    subject: subjectLine.slice("Subject: ".length).trim(),
    // An optional block (host notes, say) renders empty; collapsing the run of
    // blank lines it leaves keeps the letter looking written rather than
    // generated.
    text: body.replaceAll(/\n{3,}/g, "\n\n").trim(),
  };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => {
    const escaped = HTML_ESCAPES[character];
    return escaped ?? character;
  });
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Escape first, then linkify, so a URL's own characters cannot open a tag. */
function escapeAndLink(line: string): string {
  let result = "";
  let index = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = match[0].replace(/[.,;:!?)\]]+$/, "");
    result += escapeHtml(line.slice(index, start));
    const href = escapeHtml(raw);
    result += `<a href="${href}">${href}</a>`;
    index = start + raw.length;
  }
  return result + escapeHtml(line.slice(index));
}

/**
 * The HTML half of R11's stored payload. It is generated from the same text an
 * organizer edits, so the two parts of a message can never drift apart.
 */
export function textToHtml(text: string): string {
  const blocks = text.split(/\n\s*\n/);
  const rendered: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    let buffer: string[] = [];
    let bufferIsList = false;
    const flush = () => {
      if (buffer.length === 0) return;
      rendered.push(
        bufferIsList
          ? `<ul>\n${buffer.map((item) => `<li>${item}</li>`).join("\n")}\n</ul>`
          : `<p>${buffer.join("<br />\n")}</p>`,
      );
      buffer = [];
    };
    for (const line of lines) {
      const isListItem = line.trimStart().startsWith("- ");
      if (buffer.length > 0 && isListItem !== bufferIsList) flush();
      bufferIsList = isListItem;
      buffer.push(
        escapeAndLink(isListItem ? line.trimStart().slice(2) : line.trim()),
      );
    }
    flush();
  }
  return rendered.join("\n");
}

export interface EmlInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly date?: Date;
  readonly messageId?: string;
}

/**
 * A complete RFC 5322 message. Core never transmits, but an organizer with no
 * configured provider still needs something they can import or forward (R12),
 * and the SMTP adapter needs a payload core already committed to.
 */
export function renderEml(input: EmlInput): string {
  const boundary = `=_porchfest_${createHash("sha256")
    .update([input.subject, input.text, input.html].join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
  const headers = [
    `From: ${encodeHeaderValue(input.from)}`,
    `To: ${input.to.map((address) => encodeHeaderValue(address)).join(", ")}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
  ];
  if (input.date) headers.push(`Date: ${formatRfc5322Date(input.date)}`);
  if (input.messageId) headers.push(`Message-ID: <${input.messageId}>`);
  headers.push(
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  );

  return [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
