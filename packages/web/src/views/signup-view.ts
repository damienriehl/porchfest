import {
  formatZonedWindow,
  type AntibotClientChallenge,
  type Season,
  type SeasonTimeSlot,
} from "@porchfest/core";
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

export const SIGNUP_AUDIENCE_LABELS = Object.freeze({
  public: "Public map",
  match: "Shared with a confirmed match",
  organizer: "Organizer-only",
} as const);

export type SignupAudience = keyof typeof SIGNUP_AUDIENCE_LABELS;

const SEASON_STATE_LABELS: Readonly<Record<Season["state"], string>> = {
  setup: "Preparing the season",
  signups_open: "Accepting signups",
  signups_closed: "Signups closed",
  assigning: "Building the schedule",
  locked: "Schedule confirmed",
  archived: "Season closed and archived",
};

const eventDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * The participant-facing disclosure contract. Forms and receipts both read
 * these tables so a field cannot quietly change audiences between submission
 * and confirmation.
 */
export const HOST_SIGNUP_AUDIENCES = Object.freeze({
  contact_name: "match",
  contact_email: "match",
  contact_phone: "match",
  venue_title: "public",
  venue_address: "public",
  space_description: "public",
  has_power: "public",
  rain_backup: "public",
  requested_act_names: "organizer",
  genre_preferences: "organizer",
  gear: "public",
  drinks: "public",
  amenities: "public",
  notes: "match",
} satisfies Readonly<Record<string, SignupAudience>>);

export const PERFORMER_SIGNUP_AUDIENCES = Object.freeze({
  contact_name: "match",
  contact_email: "match",
  contact_phone: "match",
  act_name: "public",
  genres: "public",
  description: "public",
  links: "public",
  duration_minutes: "public",
  requires_amplification: "public",
  availability_start: "organizer",
  availability_end: "organizer",
  house_preference: "organizer",
  shared_member_note: "organizer",
  can_lend_gear: "organizer",
  performer_notes: "organizer",
} satisfies Readonly<Record<string, SignupAudience>>);

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderOrganizerPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Porchfest organizers</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body><main class="signup-page">${body}</main></body>
</html>`;
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
  readonly seasons: readonly Season[];
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
              `<label class="choice"><input type="radio" name="season" value="${season.id}" required><span><strong>${escapeHtml(season.displayName)}</strong><br><span class="help">${escapeHtml(formatSeasonDate(season))} · ${escapeHtml(formatSeasonLocality(season))} · ${escapeHtml(SEASON_STATE_LABELS[season.state])}</span></span></label>`,
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

export function renderSelectedSeason(season: Season | null): string {
  if (season === null) return "";
  return `<section class="confirmation-card season-context" aria-labelledby="selected-season-heading">
    <h2 id="selected-season-heading">Selected Porchfest</h2>
    <dl class="submission-list">
      <div class="submission-row"><dt>Name</dt><dd>${escapeHtml(season.displayName)}</dd></div>
      <div class="submission-row"><dt>Event date</dt><dd>${escapeHtml(formatSeasonDate(season))}</dd></div>
      <div class="submission-row"><dt>Locality</dt><dd>${escapeHtml(formatSeasonLocality(season))}</dd></div>
      <div class="submission-row"><dt>Signup status</dt><dd>${escapeHtml(SEASON_STATE_LABELS[season.state])}</dd></div>
    </dl>
  </section>`;
}

export function renderPublishedTimeSlots(
  season: Season | null,
  timeSlots: readonly SeasonTimeSlot[],
): string {
  if (season === null) return "";
  const slots =
    timeSlots.length === 0
      ? '<p class="help">The organizers have not published performance slots yet.</p>'
      : `<ul>${timeSlots
          .map(
            (slot) =>
              `<li>${escapeHtml(formatZonedWindow(slot, season.timezone))}</li>`,
          )
          .join("")}</ul>`;
  return `<section class="season-slots" aria-labelledby="published-slots-heading">
    <h3 id="published-slots-heading">Published performance slots</h3>
    ${slots}
    <p class="help">Your availability does not need to match a published slot exactly. Include the setup and teardown buffer your full act needs so organizers know the complete window when everyone can be on site.</p>
  </section>`;
}

function formatSeasonDate(season: Season): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(season.eventDate ?? "");
  if (match === null) return "Date to be announced";
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(date.getTime())
    ? "Date to be announced"
    : eventDateFormatter.format(date);
}

function formatSeasonLocality(season: Season): string {
  const locality =
    cleanSeasonPlace(season.localityName) ?? cleanSeasonPlace(season.eventCity);
  const region = cleanSeasonPlace(season.eventState);
  const parts = [locality, region].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(", ") : "Locality to be announced";
}

function cleanSeasonPlace(value: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned && cleaned.toLowerCase() !== "unconfigured" ? cleaned : null;
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
  readonly recordId: number;
  readonly publicSiteUrl: string | null;
  readonly emailConfigured: boolean;
  readonly preview: string;
  readonly submission: string;
}): string {
  const kindLabel = options.kind === "host" ? "porch" : "act";
  const formPath =
    options.kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;
  const formHref = escapeHtml(`${formPath}?season=${options.seasonId}`);
  const submissionReference = `${options.kind === "host" ? "HOST" : "PERFORMER"}-${options.recordId}`;
  const organizerContact = options.publicSiteUrl
    ? `<p>Use the <a href="${escapeHtml(options.publicSiteUrl)}">Porchfest public site</a> to find the organizer's public contact channel.</p>`
    : "<p>Keep this reference and use the same public organizer channel that supplied this form.</p>";
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
    <section class="confirmation-card" aria-labelledby="submission-reference-title">
      <h2 id="submission-reference-title">Submission reference</h2>
      <p><strong data-submission-reference="${escapeHtml(submissionReference)}">${escapeHtml(submissionReference)}</strong></p>
      <p>Quote this reference when contacting the organizers about your signup.</p>
      <p>This receipt cannot be reopened to edit or withdraw your signup, or to check its status. Participant self-service is not available yet.</p>
      ${organizerContact}
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
  readonly audience?: SignupAudience;
  readonly audienceField?: string;
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
    <label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}${options.required ? ' <span aria-hidden="true">*</span>' : ""}${renderAudienceLabel(options.audienceField ?? options.name ?? options.id, options.audience)}</label>
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
  readonly audience?: SignupAudience;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  const describedBy = [
    error ? `${options.id}-error` : "",
    options.help ? `${options.id}-help` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="field ${error ? "has-error" : ""}">
    <label for="${escapeHtml(options.id)}">${escapeHtml(options.label)}${options.required ? ' <span aria-hidden="true">*</span>' : ""}${renderAudienceLabel(options.id, options.audience)}</label>
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
  readonly audience?: SignupAudience;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  return `<fieldset class="choice-group field ${error ? "has-error" : ""}" id="${escapeHtml(options.id)}">
    <legend>${escapeHtml(options.label)} <span aria-hidden="true">*</span>${renderAudienceLabel(options.id, options.audience)}</legend>
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
  readonly audience?: SignupAudience;
}): string {
  const error = options.errors.find(({ field }) => field === options.id);
  return `<fieldset class="choice-group field ${error ? "has-error" : ""}" id="${escapeHtml(options.id)}">
    <legend>${escapeHtml(options.label)}${renderAudienceLabel(options.id, options.audience)}</legend>
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

function renderAudienceLabel(
  field: string,
  audience: SignupAudience | undefined,
): string {
  if (audience === undefined) return "";
  const label = SIGNUP_AUDIENCE_LABELS[audience];
  return ` <span class="audience-label" data-audience-field="${escapeHtml(field)}" data-audience-label="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
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
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly audience: SignupAudience;
}

function rows(
  entries: readonly (SubmissionRow | null)[],
  audience: SignupAudience,
): string {
  const present = entries.filter(
    (row): row is SubmissionRow => row !== null && row.audience === audience,
  );
  if (present.length === 0) return "";
  return `<dl class="submission-list">${present
    .map(
      (row) =>
        `<div class="submission-row" data-submission-field="${escapeHtml(row.field)}" data-audience-label="${escapeHtml(SIGNUP_AUDIENCE_LABELS[row.audience])}"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`,
    )
    .join("")}</dl>`;
}

function row(
  audiences: Readonly<Record<string, SignupAudience>>,
  field: string,
  label: string,
  value: string,
): SubmissionRow | null {
  const trimmed = value.trim();
  const audience = audiences[field];
  if (!trimmed || audience === undefined) return null;
  return { field, label, value: trimmed, audience };
}

function listRow(
  audiences: Readonly<Record<string, SignupAudience>>,
  field: string,
  label: string,
  values: readonly string[],
): SubmissionRow | null {
  const present = values.filter((value) => value.trim().length > 0);
  if (present.length === 0) return null;
  const audience = audiences[field];
  if (audience === undefined) return null;
  return {
    field,
    label,
    value: present.map(readableChoice).join(", "),
    audience,
  };
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
  entries: readonly (SubmissionRow | null)[],
  note: string,
): string {
  const publicRows = rows(entries, "public");
  const organizerRows = rows(entries, "organizer");
  const matchRows = rows(entries, "match");
  return `<section class="submission" aria-labelledby="submission-title">
    <h2 id="submission-title">Everything you sent</h2>
    <section class="submission-group submission-public" aria-labelledby="submission-public-title">
      <h3 id="submission-public-title">${SIGNUP_AUDIENCE_LABELS.public}</h3>
      <p class="help">Shown publicly. ${escapeHtml(note)}</p>
      ${publicRows || `<p class="help">Nothing public was submitted.</p>`}
    </section>
    <section class="submission-group submission-organizer" aria-labelledby="submission-organizer-title">
      <h3 id="submission-organizer-title">${SIGNUP_AUDIENCE_LABELS.organizer}</h3>
      <p class="help">Kept private from the public map and confirmed matches. Only Porchfest organizers see these answers.</p>
      ${organizerRows || `<p class="help">No organizer-only answers were submitted.</p>`}
    </section>
    <section class="submission-group submission-match" aria-labelledby="submission-match-title">
      <h3 id="submission-match-title">${SIGNUP_AUDIENCE_LABELS.match}</h3>
      <p class="help">These answers are sent to the host and performers only after the organizer confirms their match. They never appear on the public map.</p>
      ${matchRows || `<p class="help">No match-shared answers were submitted.</p>`}
    </section>
  </section>`;
}

export function renderHostSubmission(values: SignupValues): string {
  return renderSubmission(
    [
      row(
        HOST_SIGNUP_AUDIENCES,
        "venue_title",
        "Porch name",
        firstValue(values, "venue_title"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "venue_address",
        "Street address",
        firstValue(values, "venue_address"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "space_description",
        "Performance space",
        firstValue(values, "space_description"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "has_power",
        "Electrical power",
        yesNo(firstValue(values, "has_power")),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "rain_backup",
        "Rain backup",
        yesNo(firstValue(values, "rain_backup")),
      ),
      listRow(HOST_SIGNUP_AUDIENCES, "gear", "Gear", allValues(values, "gear")),
      listRow(
        HOST_SIGNUP_AUDIENCES,
        "drinks",
        "Drinks",
        allValues(values, "drinks"),
      ),
      listRow(
        HOST_SIGNUP_AUDIENCES,
        "amenities",
        "Amenities",
        allValues(values, "amenities"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "contact_name",
        "Your name",
        firstValue(values, "contact_name"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "contact_email",
        "Email",
        firstValue(values, "contact_email"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "contact_phone",
        "Phone",
        firstValue(values, "contact_phone"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "requested_act_names",
        "Requested acts",
        firstValue(values, "requested_act_names"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "genre_preferences",
        "Genre preferences",
        firstValue(values, "genre_preferences"),
      ),
      row(
        HOST_SIGNUP_AUDIENCES,
        "notes",
        "Notes for your confirmed match",
        firstValue(values, "notes"),
      ),
    ],
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
    [
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "act_name",
        "Act name",
        firstValue(values, "act_name"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "genres",
        "Genres",
        firstValue(values, "genres"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "description",
        "Act description",
        firstValue(values, "description"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "links",
        "Music and website links",
        firstValue(values, "links"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "duration_minutes",
        "Set duration",
        durationLabel(firstValue(values, "duration_minutes")),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "requires_amplification",
        "Amplification",
        yesNo(firstValue(values, "requires_amplification")),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "contact_name",
        "Your name",
        firstValue(values, "contact_name"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "contact_email",
        "Email",
        firstValue(values, "contact_email"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "contact_phone",
        "Phone",
        firstValue(values, "contact_phone"),
      ),
      listRow(
        PERFORMER_SIGNUP_AUDIENCES,
        "availability_start",
        `Availability (${timezone})`,
        windows,
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "can_lend_gear",
        "Can lend gear",
        yesNo(firstValue(values, "can_lend_gear")),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "house_preference",
        "Porch or neighbourhood preference",
        firstValue(values, "house_preference"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "shared_member_note",
        "Members in other acts",
        firstValue(values, "shared_member_note"),
      ),
      row(
        PERFORMER_SIGNUP_AUDIENCES,
        "performer_notes",
        "Anything else",
        firstValue(values, "performer_notes"),
      ),
    ],
    "These details go on the public map and into organizer materials.",
  );
}

function durationLabel(raw: string): string {
  const trimmed = raw.trim();
  return trimmed ? `${trimmed} minutes` : "";
}
