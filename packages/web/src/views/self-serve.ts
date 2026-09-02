import {
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  type AntibotClientChallenge,
  type ParticipantRecordView,
} from "@porchfest/core";
import {
  escapeHtml,
  renderBooleanChoices,
  renderChallenge,
  renderChallengeScript,
  renderCheckboxGroup,
  renderField,
  renderFieldError,
  renderHoneypot,
  renderTextarea,
  VENUE_CHOICE_LABELS,
  type SignupError,
} from "./signup-view.js";
import {
  SELF_SERVE_CHANGE_REQUEST_PATH,
  SELF_SERVE_PATH,
  SELF_SERVE_REQUEST_PATH,
} from "../routes/self-serve-paths.js";

export interface SelfServePageOptions {
  readonly participant: ParticipantRecordView;
  readonly editCsrf: string;
  readonly changeCsrf: string;
  readonly assignment: string;
  readonly coordinates: string;
  readonly annotations: readonly string[];
  readonly timezone: string;
  readonly notice?: string;
  readonly errors?: readonly SignupError[];
}

export function renderParticipantAccessRequiredPage(): string {
  return page(
    "Your private link is unavailable",
    `<section class="confirmation" aria-labelledby="access-title">
      <p class="eyebrow">Private submission</p>
      <h1 id="access-title">This link has expired or is no longer available.</h1>
      <p>Request a fresh private link and we’ll send it to the email address on your signup.</p>
      <a class="primary-action" href="${SELF_SERVE_REQUEST_PATH}">Request a new link</a>
    </section>`,
  );
}

export function renderRequestLinkPage(options: {
  readonly csrfToken: string;
  readonly challenge: AntibotClientChallenge | null;
  readonly accepted?: boolean;
  readonly error?: string;
}): string {
  if (options.accepted) {
    return page(
      "Check your email",
      `<section class="confirmation" aria-labelledby="request-title">
        <p class="eyebrow success-mark">Request received</p>
        <h1 id="request-title">Check your email</h1>
        <p>If that address belongs to a current signup, a private link is on its way. For privacy, this page gives the same answer for every address.</p>
      </section>`,
    );
  }
  const errors: SignupError[] = options.error
    ? [{ field: "request-form", label: "Request", message: options.error }]
    : [];
  return page(
    "Request your private link",
    `<header class="signup-header">
      <p class="eyebrow">Participant self-serve</p>
      <h1>Request your private link</h1>
      <p class="lede">Enter the email address on your host or performer signup.</p>
    </header>
    ${errors.length > 0 ? `<section class="error-summary" role="alert"><p>${escapeHtml(errors[0]?.message)}</p></section>` : ""}
    <form class="signup-form signup-single-column" id="request-form" method="post" action="${SELF_SERVE_REQUEST_PATH}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      ${renderField({ id: "email", label: "Email", value: "", errors, type: "email", autocomplete: "email", required: true })}
      ${renderChallenge(options.challenge, errors)}
      ${renderHoneypot()}
      <button class="primary-action" type="submit">Email my private link</button>
    </form>
    ${renderChallengeScript(options.challenge)}`,
  );
}

export function renderSelfServePage(options: SelfServePageOptions): string {
  const { participant } = options;
  const errors = options.errors ?? [];
  const title =
    participant.recordType === "venue"
      ? participant.record.title
      : participant.record.name;
  const record = participant.record;
  const notice = options.notice
    ? `<p class="email-notice" role="status">${escapeHtml(options.notice)}</p>`
    : "";
  return page(
    `Edit ${title}`,
    `<header class="signup-header">
      <p class="eyebrow">Private submission</p>
      <h1>Edit ${escapeHtml(title)}</h1>
      <p class="lede">Update the details you own. Schedule-changing requests wait for an organizer.</p>
      ${notice}
    </header>
    ${renderErrors(errors)}
    <div class="signup-layout">
      ${renderEditForm(options, errors)}
      <aside class="preview-column" aria-labelledby="readonly-heading">
        <h2 id="readonly-heading">Organizer-controlled details</h2>
        <dl class="submission-list">
          ${readOnlyRow("Status", record.status)}
          ${readOnlyRow("Assignment and slot", options.assignment)}
          ${readOnlyRow("Coordinates", options.coordinates)}
          ${readOnlyRow("Organizer annotations", options.annotations.join(" · ") || "None")}
        </dl>
        ${renderChangeRequestForm(options, errors)}
      </aside>
    </div>`,
  );
}

function renderEditForm(
  options: SelfServePageOptions,
  errors: readonly SignupError[],
): string {
  const { participant } = options;
  const common = `<fieldset>
    <legend>Your contact details</legend>
    ${renderField({ id: "contact_name", label: "Your name", value: participant.contact.name, errors, autocomplete: "name", required: true })}
    ${renderField({ id: "contact_email", label: "Email", value: participant.contact.email ?? "", errors, type: "email", autocomplete: "email", required: true })}
    ${renderField({ id: "contact_phone", label: "Phone", value: participant.contact.phone ?? "", errors, type: "tel", autocomplete: "tel" })}
  </fieldset>`;
  const recordFields =
    participant.recordType === "venue"
      ? renderVenueFields(participant, errors)
      : renderActFields(participant, errors);
  return `<form class="signup-form" id="edit-form" method="post" action="${SELF_SERVE_PATH}">
    <input type="hidden" name="_csrf" value="${escapeHtml(options.editCsrf)}">
    <input type="hidden" name="record_version" value="${participant.record.version}">
    <input type="hidden" name="contact_version" value="${participant.contact.version}">
    ${common}
    ${recordFields}
    <button class="primary-action" type="submit">Save my details</button>
  </form>`;
}

function renderVenueFields(
  participant: Extract<ParticipantRecordView, { recordType: "venue" }>,
  errors: readonly SignupError[],
): string {
  const venue = participant.record;
  return `<fieldset>
    <legend>Your porch details</legend>
    ${renderField({ id: "venue_title", label: "Porch name", value: venue.title, errors, required: true })}
    ${renderTextarea({ id: "space_description", label: "Performance space", value: venue.spaceDescription ?? "", errors })}
    ${renderBooleanChoices({ id: "has_power", label: "Electrical power", value: venue.hasPower ? "yes" : "no", errors })}
    ${renderBooleanChoices({ id: "rain_backup", label: "Rain backup", value: venue.rainBackup ? "yes" : "no", errors })}
    ${renderTextarea({ id: "requested_act_names", label: "Acts you requested", value: venue.requestedActNames ?? "", errors })}
    ${renderTextarea({ id: "genre_preferences", label: "Genre preferences", value: venue.genrePreferences ?? "", errors })}
    ${choiceGroup(
      "gear",
      "Gear you can provide",
      participant.gear.map(({ value }) => value),
      venueGearValues,
      errors,
    )}
    ${choiceGroup(
      "drinks",
      "Drinks you can provide",
      participant.drinks.map(({ value }) => value),
      venueDrinkValues,
      errors,
    )}
    ${choiceGroup(
      "amenities",
      "Amenities",
      participant.amenities.map(({ value }) => value),
      venueAmenityValues,
      errors,
    )}
    ${renderTextarea({ id: "participant_notes", label: "Notes for the organizers", value: venue.notes ?? "", errors, help: "These are your notes. Organizer annotations stay separate and read-only." })}
  </fieldset>`;
}

function renderActFields(
  participant: Extract<ParticipantRecordView, { recordType: "act" }>,
  errors: readonly SignupError[],
): string {
  const act = participant.record;
  return `<fieldset>
    <legend>Your act details</legend>
    ${renderField({ id: "act_name", label: "Act name", value: act.name, errors, required: true })}
    ${renderField({ id: "genres", label: "Genres", value: act.genre ?? "", errors, required: true })}
    ${renderTextarea({ id: "description", label: "Act description", value: act.description ?? "", errors, required: true })}
    ${renderTextarea({ id: "links", label: "Public links", value: act.links ?? "", errors })}
    ${renderField({ id: "duration_minutes", label: "Set length in minutes", value: String(act.durationMinutes ?? ""), errors, type: "number", min: "1", max: "240", required: true })}
    ${renderBooleanChoices({ id: "requires_amplification", label: "Amplification", value: act.requiresAmplification ? "yes" : "no", errors })}
    ${renderTextarea({ id: "house_preference", label: "Porch preference", value: act.housePreference ?? "", errors })}
    ${renderTextarea({ id: "shared_member_note", label: "Shared members", value: act.sharedMemberNote ?? "", errors })}
    ${renderBooleanChoices({ id: "can_lend_gear", label: "Can lend gear", value: act.canLendGear ? "yes" : "no", errors })}
    ${renderTextarea({ id: "participant_notes", label: "Notes for the organizers", value: act.notes ?? "", errors, help: "These are your notes. Organizer annotations stay separate and read-only." })}
  </fieldset>`;
}

function renderChangeRequestForm(
  options: SelfServePageOptions,
  errors: readonly SignupError[],
): string {
  const { participant } = options;
  const specific =
    participant.recordType === "venue"
      ? `${renderField({ id: "proposed_address", label: "Corrected venue address", value: participant.record.address ?? "", errors })}
         <button class="secondary-action" type="submit" name="kind" value="address">Request address correction</button>`
      : `${renderAvailabilityFields(participant, options.timezone, errors)}
         <button class="secondary-action" type="submit" name="kind" value="availability">Request availability change</button>`;
  return `<section class="confirmation-card" aria-labelledby="request-change-heading">
    <h2 id="request-change-heading">Request a schedule-changing update</h2>
    <p class="help">Your confirmed assignment stays in place until an organizer applies or rejects this request.</p>
    <form method="post" action="${SELF_SERVE_CHANGE_REQUEST_PATH}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.changeCsrf)}">
      <input type="hidden" name="record_version" value="${participant.record.version}">
      ${specific}
      <button class="secondary-action" type="submit" name="kind" value="withdrawal">Request withdrawal</button>
    </form>
  </section>`;
}

function renderAvailabilityFields(
  participant: Extract<ParticipantRecordView, { recordType: "act" }>,
  timezone: string,
  errors: readonly SignupError[],
): string {
  const availabilityError = errors.find(
    ({ field }) => field === "availability_start",
  );
  const rowCount = Math.max(participant.availabilities.length, 2);
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const number = index + 1;
    const window = participant.availabilities[index];
    return `<div class="availability-row">
      ${renderField({ id: `availability_start_${number}`, name: "availability_start", label: `Available from ${number}`, value: window ? formatZonedDateTime(window.startsAt, timezone) : "", errors: [], type: "datetime-local" })}
      ${renderField({ id: `availability_end_${number}`, name: "availability_end", label: `Available until ${number}`, value: window ? formatZonedDateTime(window.endsAt, timezone) : "", errors: [], type: "datetime-local" })}
    </div>`;
  }).join("");
  return `<div class="field ${availabilityError ? "has-error" : ""}" id="availability_start">
    <h3 class="field-heading">Available time windows</h3>
    ${renderFieldError("availability_start", availabilityError)}
    <p class="help">Times use ${escapeHtml(timezone)}, the festival’s local clock. Leave unused rows blank.</p>
    ${rows}
  </div>`;
}

function formatZonedDateTime(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function choiceGroup(
  id: string,
  label: string,
  selected: readonly string[],
  values: readonly string[],
  errors: readonly SignupError[],
): string {
  return renderCheckboxGroup({
    id,
    label,
    selected,
    choices: values.map((value) => ({
      value,
      label: VENUE_CHOICE_LABELS[value] ?? value.replaceAll("_", " "),
    })),
    errors,
  });
}

function renderErrors(errors: readonly SignupError[]): string {
  if (errors.length === 0) return "";
  return `<section class="error-summary" role="alert"><h2>Nothing was saved</h2><ul>${errors
    .map((error) => `<li>${escapeHtml(error.message)}</li>`)
    .join("")}</ul></section>`;
}

function readOnlyRow(label: string, value: string): string {
  return `<div class="submission-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Porchfest</title>
  <link rel="stylesheet" href="/signup/assets/signup.css">
</head>
<body><main class="signup-page">${body}</main></body>
</html>`;
}
