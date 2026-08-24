import type { AntibotClientChallenge } from "@porchfest/core";
import {
  HOST_SIGNUP_PATH,
  PERFORMER_SIGNUP_PATH,
} from "../routes/signup-paths.js";

export type SignupValues = Readonly<Record<string, readonly string[]>>;

export interface SignupError {
  readonly field: string;
  readonly label: string;
  readonly message: string;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function firstValue(values: SignupValues, name: string): string {
  return values[name]?.[0] ?? "";
}

export function allValues(
  values: SignupValues,
  name: string,
): readonly string[] {
  return values[name] ?? [];
}

export function renderSignupSeasonPage(options: {
  readonly kind: "host" | "performer";
  readonly seasons: readonly {
    readonly id: number;
    readonly displayName: string;
  }[];
  readonly errors: readonly SignupError[];
}): string {
  const path =
    options.kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;
  const title =
    options.kind === "host" ? "Host a Porchfest stage" : "Play Porchfest";
  const eyebrow = options.kind === "host" ? "Host signup" : "Performer signup";
  const content =
    options.seasons.length === 0
      ? `<section class="confirmation-card" id="signup-form" aria-labelledby="signup-availability-heading">
      <h2 id="signup-availability-heading">Signups are not open right now</h2>
      <p>Please check back when the organizers open a Porchfest season.</p>
    </section>`
      : `<form class="signup-form" id="signup-form" method="get" action="${path}">
      <fieldset class="choice-group">
        <legend>Choose a Porchfest season</legend>
        <p class="help">Choose the Porchfest you want to join.</p>
        <div class="choices">${options.seasons
          .map(
            (season) =>
              `<label class="choice"><input type="radio" name="season" value="${season.id}" required><span>${escapeHtml(season.displayName)}</span></label>`,
          )
          .join("")}</div>
      </fieldset>
      <button class="primary-action" type="submit">Continue</button>
    </form>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Porchfest</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body>
  <main class="signup-page">
    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(title)}</h1>
    </header>
    ${renderErrorSummary(options.errors)}
    <div class="signup-single-column">${content}</div>
  </main>
</body>
</html>`;
}

export function renderSignupPage(options: {
  readonly title: string;
  readonly eyebrow: string;
  readonly intro: string;
  readonly form: string;
  readonly preview: string;
  readonly errors: readonly SignupError[];
  readonly challenge?: AntibotClientChallenge | null;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)} · Porchfest</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body>
  <main class="signup-page">
    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.eyebrow)}</p>
      <h1>${escapeHtml(options.title)}</h1>
      <p class="lede">${escapeHtml(options.intro)}</p>
    </header>
    ${renderErrorSummary(options.errors)}
    <div class="signup-layout">
      ${options.form}
      <aside class="preview-column" aria-labelledby="preview-heading">
        <p class="preview-kicker" id="preview-heading">Your map card</p>
        <p class="help">This is the public card your answers are helping create.</p>
        ${options.preview}
      </aside>
    </div>
  </main>
  ${renderChallengeScript(options.challenge ?? null)}
  <script type="module" src="/signup/assets/signup-preview.js"></script>
</body>
</html>`;
}

export function renderConfirmationPage(options: {
  readonly title: string;
  readonly kind: "host" | "performer";
  readonly seasonId: number;
  readonly emailConfigured: boolean;
  readonly preview: string;
  readonly submission: string;
}): string {
  const kindLabel = options.kind === "host" ? "porch" : "act";
  const formPath =
    options.kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;
  const formHref = escapeHtml(`${formPath}?season=${options.seasonId}`);
  const emailNotice = options.emailConfigured
    ? "If the organizers send confirmation by email, it will go to the address you provided."
    : "No confirmation email will follow because email delivery is not configured for this deployment.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signup received · Porchfest</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body>
  <main class="signup-page confirmation-page">
    <section class="confirmation" aria-labelledby="confirmation-title">
      <p class="eyebrow success-mark">Received</p>
      <h1 id="confirmation-title">${escapeHtml(options.title)}</h1>
      <p>The organizer will review your ${kindLabel} details and contact you when matching and scheduling move forward.</p>
      <p class="email-notice">${escapeHtml(emailNotice)}</p>
    </section>
    <section class="confirmation-card" aria-labelledby="confirmation-card-title">
      <h2 id="confirmation-card-title">Your public map card</h2>
      <p class="help">This is what neighbours will see.</p>
      ${options.preview}
    </section>
    ${options.submission}
    <a class="secondary-action" href="${formHref}">Submit another ${kindLabel}</a>
  </main>
</body>
</html>`;
}

function renderErrorSummary(errors: readonly SignupError[]): string {
  if (errors.length === 0) return "";
  return `<section class="error-summary" role="alert" tabindex="-1" aria-labelledby="error-summary-title">
    <h2 id="error-summary-title">Check ${errors.length === 1 ? "this answer" : "these answers"}</h2>
    <ul>${errors
      .map(
        (error) =>
          `<li><a href="#${escapeHtml(error.field)}">${escapeHtml(error.label)}: ${escapeHtml(error.message)}</a></li>`,
      )
      .join("")}</ul>
  </section>`;
}

export function renderField(options: {
  readonly id: string;
  readonly name?: string;
  readonly label: string;
  readonly value: string;
  readonly errors: readonly SignupError[];
  readonly help?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly autocomplete?: string;
  readonly inputmode?: string;
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  const describedBy = [
    error ? `${options.id}-error` : "",
    options.help ? `${options.id}-help` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const attributes = [
    `id="${escapeHtml(options.id)}"`,
    `name="${escapeHtml(options.name ?? options.id)}"`,
    `type="${escapeHtml(options.type ?? "text")}"`,
    `value="${escapeHtml(options.value)}"`,
    options.required ? "required" : "",
    options.autocomplete
      ? `autocomplete="${escapeHtml(options.autocomplete)}"`
      : "",
    options.inputmode ? `inputmode="${escapeHtml(options.inputmode)}"` : "",
    options.min ? `min="${escapeHtml(options.min)}"` : "",
    options.max ? `max="${escapeHtml(options.max)}"` : "",
    options.step ? `step="${escapeHtml(options.step)}"` : "",
    error ? 'aria-invalid="true"' : "",
    describedBy ? `aria-describedby="${describedBy}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="field ${error ? "has-error" : ""}">
    <label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}${options.required ? ' <span aria-hidden="true">*</span>' : ""}</label>
    ${renderFieldError(options.id, error)}
    <input ${attributes}>
    ${options.help ? `<p class="help" id="${options.id}-help">${escapeHtml(options.help)}</p>` : ""}
  </div>`;
}

export function renderTextarea(options: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly errors: readonly SignupError[];
  readonly help?: string;
  readonly required?: boolean;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  const describedBy = [
    error ? `${options.id}-error` : "",
    options.help ? `${options.id}-help` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="field ${error ? "has-error" : ""}">
    <label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}${options.required ? ' <span aria-hidden="true">*</span>' : ""}</label>
    ${renderFieldError(options.id, error)}
    <textarea id="${escapeHtml(options.id)}" name="${escapeHtml(options.id)}" rows="4"${options.required ? " required" : ""}${error ? ' aria-invalid="true"' : ""}${describedBy ? ` aria-describedby="${describedBy}"` : ""}>${escapeHtml(options.value)}</textarea>
    ${options.help ? `<p class="help" id="${options.id}-help">${escapeHtml(options.help)}</p>` : ""}
  </div>`;
}

export function renderBooleanChoices(options: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly errors: readonly SignupError[];
  readonly help?: string;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  return `<fieldset class="choice-group field ${error ? "has-error" : ""}" id="${escapeHtml(options.id)}">
    <legend>${escapeHtml(options.label)} <span aria-hidden="true">*</span></legend>
    ${renderFieldError(options.id, error)}
    <div class="choices">
      ${["yes", "no"]
        .map(
          (choice) =>
            `<label class="choice"><input type="radio" name="${escapeHtml(options.id)}" value="${choice}"${options.value === choice ? " checked" : ""} required${error ? ' aria-invalid="true"' : ""}><span>${choice === "yes" ? "Yes" : "No"}</span></label>`,
        )
        .join("")}
    </div>
    ${options.help ? `<p class="help">${escapeHtml(options.help)}</p>` : ""}
  </fieldset>`;
}

export function renderCheckboxGroup(options: {
  readonly id: string;
  readonly label: string;
  readonly selected: readonly string[];
  readonly choices: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly errors: readonly SignupError[];
  readonly help?: string;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  return `<fieldset class="choice-group field ${error ? "has-error" : ""}" id="${escapeHtml(options.id)}">
    <legend>${escapeHtml(options.label)}</legend>
    ${renderFieldError(options.id, error)}
    ${options.help ? `<p class="help">${escapeHtml(options.help)}</p>` : ""}
    <div class="checkboxes">${options.choices
      .map(
        (choice) =>
          `<label class="choice"><input type="checkbox" name="${escapeHtml(options.id)}" value="${escapeHtml(choice.value)}"${options.selected.includes(choice.value) ? " checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`,
      )
      .join("")}</div>
  </fieldset>`;
}

export function renderFieldError(
  id: string,
  error: SignupError | undefined,
): string {
  return `<div class="field-error-slot">${
    error
      ? `<p class="field-error" id="${escapeHtml(id)}-error"><span aria-hidden="true">▲</span> ${escapeHtml(error.message)}</p>`
      : ""
  }</div>`;
}

/** Human labels for the venue multi-select values. Shared so the form controls
 *  and the confirmation read-back can never disagree about what "pa" means. */
export const VENUE_CHOICE_LABELS: Readonly<Record<string, string>> = {
  pa: "PA system",
  microphone: "Microphone",
  microphone_stand: "Microphone stand",
  instrument_amplifier: "Instrument amplifier",
  drum_kit: "Drum kit",
  keyboard: "Keyboard",
  music_stand: "Music stand",
  extension_cord: "Extension cord",
  power_strip: "Power strip",
  water: "Water",
  non_alcoholic: "Non-alcoholic drinks",
  beer: "Beer",
  wine: "Wine",
  seating: "Seating",
  shade: "Shade",
  restroom: "Restroom",
  accessible_entry: "Accessible entry",
  parking: "Parking",
  other: "Other",
};

export function renderChallenge(
  challenge: AntibotClientChallenge | null,
  errors: readonly SignupError[],
): string {
  if (!challenge) return "";
  const error = errors.find(
    ({ field }) => field === challenge.responseFieldName,
  );
  const attributes = Object.entries(challenge.mountAttributes)
    .map(([name, value]) => `${escapeHtml(name)}="${escapeHtml(value)}"`)
    .join(" ");
  const tag = escapeHtml(challenge.mountTag);
  return `<div class="field challenge-field ${error ? "has-error" : ""}" id="${escapeHtml(challenge.responseFieldName)}">
    <h3 class="field-heading">${escapeHtml(challenge.label)} <span aria-hidden="true">*</span></h3>
    ${renderFieldError(challenge.responseFieldName, error)}
    <${tag} ${attributes}></${tag}>
    <noscript><p class="help">This signup needs JavaScript enabled so the verification check can run.</p></noscript>
  </div>`;
}

export function renderChallengeScript(
  challenge: AntibotClientChallenge | null,
): string {
  if (!challenge?.scriptUrl) return "";
  return `<script src="${escapeHtml(challenge.scriptUrl)}" async defer></script>`;
}

export function renderHoneypot(): string {
  return `<div class="honeypot" aria-hidden="true">
    <label for="website">Leave website blank</label>
    <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
  </div>`;
}

export function renderHostPreview(values: SignupValues): string {
  return renderPreviewCard({
    kind: "host",
    title: firstValue(values, "venue_title"),
    subtitle: firstValue(values, "venue_address"),
    description: firstValue(values, "space_description"),
    details: [
      firstValue(values, "has_power") === "yes" ? "Power available" : "",
      firstValue(values, "rain_backup") === "yes" ? "Rain backup" : "",
    ],
  });
}

export function renderPerformerPreview(values: SignupValues): string {
  return renderPreviewCard({
    kind: "performer",
    title: firstValue(values, "act_name"),
    subtitle: firstValue(values, "genres"),
    description: firstValue(values, "description"),
    details: [
      firstValue(values, "duration_minutes")
        ? `${firstValue(values, "duration_minutes")} minutes`
        : "",
      firstValue(values, "requires_amplification") === "yes" ? "Amplified" : "",
    ],
  });
}

export function renderPreviewCard(options: {
  readonly kind: "host" | "performer";
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly details?: readonly string[];
}): string {
  const emptyTitle = options.kind === "host" ? "Your porch" : "Your act";
  return `<article class="porchfest-venue-card porch-card" data-signup-preview="${options.kind}">
    <div class="porchfest-venue-band porch-card-band">
      <p class="porch-card-type">${options.kind === "host" ? "Host porch" : "Performer"}</p>
      <h2 class="porchfest-venue-title" data-preview-title>${escapeHtml(options.title || emptyTitle)}</h2>
      <p class="porchfest-venue-address" data-preview-subtitle>${escapeHtml(options.subtitle || "Your details will appear here")}</p>
    </div>
    <div class="porchfest-venue-acts porch-card-body">
      <p data-preview-description>${escapeHtml(options.description || "Keep filling in the form to shape this card.")}</p>
      <p class="porch-card-details" data-preview-details>${escapeHtml((options.details ?? []).filter(Boolean).join(" · "))}</p>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------------
// Confirmation read-back
// ---------------------------------------------------------------------------
//
// A host fills this in on a phone for ten minutes; the map card alone is not a
// receipt. The split is the point: everything under "public" is headed for the
// map neighbours read, everything under "private" stays with the organizers.
// Saying which is which on the confirmation page is how a participant finds out
// before the season opens rather than after.

interface SubmissionRow {
  readonly label: string;
  readonly value: string;
}

function rows(entries: readonly (SubmissionRow | null)[]): string {
  const present = entries.filter((row): row is SubmissionRow => row !== null);
  if (present.length === 0) return "";
  return `<dl class="submission-list">${present
    .map(
      (row) =>
        `<div class="submission-row"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

function row(label: string, value: string): SubmissionRow | null {
  const trimmed = value.trim();
  return trimmed ? { label, value: trimmed } : null;
}

function listRow(
  label: string,
  values: readonly string[],
): SubmissionRow | null {
  const present = values.filter((value) => value.trim().length > 0);
  if (present.length === 0) return null;
  return { label, value: present.map(readableChoice).join(", ") };
}

function readableChoice(value: string): string {
  return VENUE_CHOICE_LABELS[value] ?? value.replaceAll("_", " ");
}

function yesNo(value: string): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "No";
  return "";
}

function renderSubmission(
  publicRows: string,
  privateRows: string,
  note: string,
): string {
  return `<section class="submission" aria-labelledby="submission-title">
    <h2 id="submission-title">Everything you sent</h2>
    <section class="submission-group submission-public" aria-labelledby="submission-public-title">
      <h3 id="submission-public-title">Shown publicly</h3>
      <p class="help">${escapeHtml(note)}</p>
      ${publicRows || `<p class="help">Nothing public was submitted.</p>`}
    </section>
    <section class="submission-group submission-private" aria-labelledby="submission-private-title">
      <h3 id="submission-private-title">Kept private</h3>
      <p class="help">Only the Porchfest organizers see these. They never appear on the public map.</p>
      ${privateRows || `<p class="help">Nothing private was submitted.</p>`}
    </section>
  </section>`;
}

export function renderHostSubmission(values: SignupValues): string {
  return renderSubmission(
    rows([
      row("Porch name", firstValue(values, "venue_title")),
      row("Street address", firstValue(values, "venue_address")),
      row("Performance space", firstValue(values, "space_description")),
      row("Electrical power", yesNo(firstValue(values, "has_power"))),
      row("Rain backup", yesNo(firstValue(values, "rain_backup"))),
      listRow("Gear", allValues(values, "gear")),
      listRow("Drinks", allValues(values, "drinks")),
      listRow("Amenities", allValues(values, "amenities")),
    ]),
    rows([
      row("Your name", firstValue(values, "contact_name")),
      row("Email", firstValue(values, "contact_email")),
      row("Phone", firstValue(values, "contact_phone")),
      row("Notes for the organizers", firstValue(values, "notes")),
    ]),
    "These details help neighbours find your porch and help performers plan.",
  );
}

export function renderPerformerSubmission(
  values: SignupValues,
  timezone: string,
): string {
  const starts = allValues(values, "availability_start");
  const ends = allValues(values, "availability_end");
  const windows = starts
    .map((start, index) => {
      const end = ends[index] ?? "";
      if (!start.trim() || !end.trim()) return "";
      return `${start.replace("T", " ")} to ${end.replace("T", " ")}`;
    })
    .filter(Boolean);

  return renderSubmission(
    rows([
      row("Act name", firstValue(values, "act_name")),
      row("Genres", firstValue(values, "genres")),
      row("Act description", firstValue(values, "description")),
      row("Music and website links", firstValue(values, "links")),
      row(
        "Set duration",
        durationLabel(firstValue(values, "duration_minutes")),
      ),
      row("Amplification", yesNo(firstValue(values, "requires_amplification"))),
    ]),
    rows([
      row("Your name", firstValue(values, "contact_name")),
      row("Email", firstValue(values, "contact_email")),
      row("Phone", firstValue(values, "contact_phone")),
      listRow(`Availability (${timezone})`, windows),
      row("Can lend gear", yesNo(firstValue(values, "can_lend_gear"))),
      row(
        "Porch or neighbourhood preference",
        firstValue(values, "house_preference"),
      ),
      row("Anything else", firstValue(values, "performer_notes")),
    ]),
    "These details go on the public map and into organizer materials.",
  );
}

function durationLabel(raw: string): string {
  const trimmed = raw.trim();
  return trimmed ? `${trimmed} minutes` : "";
}
