import type { Organizer } from "@porchfest/core";
import { escapeHtml } from "./signup-view.js";
import { ADMIN_SIGN_IN_PATH, ADMIN_SIGN_OUT_PATH } from "../routes/admin.js";

function page(title: string, body: string): string {
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

export function renderOrganizerSignInRequiredPage(options: {
  readonly organizerSignInPath: string;
}): string {
  return page(
    "Sign-in required",
    `    <header class="signup-header">
      <p class="eyebrow">Organizers</p>
      <h1>Your session has ended</h1>
      <p class="lede">Your changes were not submitted. Sign in again, then return to the record you were editing.</p>
      <p><a class="secondary-action" href="${escapeHtml(options.organizerSignInPath)}">Go to organizer sign-in</a></p>
    </header>`,
  );
}

export function renderSignInPage(options: {
  readonly token: string;
  readonly csrfToken: string;
  readonly needsEmail: boolean;
  readonly errors: readonly string[];
  readonly next?: string;
}): string {
  if (!options.token && options.errors.length === 0) {
    const nextStep = options.needsEmail
      ? "Use the bootstrap sign-in link printed in the container log."
      : "A new sign-in link must come from another organizer. If you are the only organizer, an operator with database access must issue one.";
    return page(
      "Organizer sign-in",
      `    <header class="signup-header">
      <p class="eyebrow">Organizers</p>
      <h1>Your session has ended</h1>
      <p class="lede">Sign-in links work once. ${escapeHtml(nextStep)}</p>
    </header>`,
    );
  }

  const errors =
    options.errors.length === 0
      ? ""
      : `<section class="error-summary" role="alert" tabindex="-1" aria-labelledby="sign-in-error-title">
      <h2 id="sign-in-error-title">Check this link</h2>
      <ul>${options.errors.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>
    </section>`;

  return page(
    "Organizer sign-in",
    `    <header class="signup-header">
      <p class="eyebrow">Organizers</p>
      <h1>Sign in to Porchfest</h1>
      <p class="lede">Sign-in links work once. A new link must come from another organizer. If you are the only organizer, an operator with database access must issue one.</p>
    </header>
    ${errors}
    <form class="signup-form" id="signup-form" method="post" action="${ADMIN_SIGN_IN_PATH}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="token" value="${escapeHtml(options.token)}">
      ${options.next ? `<input type="hidden" name="next" value="${escapeHtml(options.next)}">` : ""}
      <fieldset>
        <legend>Who you are</legend>
        <div class="field">
          <label for="display_name">Your name</label>
          <div class="field-error-slot"></div>
          <input id="display_name" name="display_name" type="text" autocomplete="name" required>
          <p class="help" id="display_name-help">The name other organizers will see beside your notes.</p>
        </div>
        ${
          options.needsEmail
            ? `<div class="field">
          <label for="email">Email</label>
          <div class="field-error-slot"></div>
          <input id="email" name="email" type="email" autocomplete="email" required>
          <p class="help" id="email-help">This becomes the first organizer account for this deployment.</p>
        </div>`
            : `<p class="help">This link already knows which address it was sent to.</p>`
        }
      </fieldset>
      <button class="primary-action" type="submit">Sign in</button>
    </form>`,
  );
}

export function renderAdminShell(options: {
  readonly organizer: Organizer | null;
  readonly csrfToken: string;
}): string {
  const name = options.organizer?.displayName ?? "Organizer";
  return page(
    "Organizers",
    `    <header class="signup-header">
      <p class="eyebrow">Organizers</p>
      <h1>Welcome, ${escapeHtml(name)}</h1>
      <p class="lede">The activity queue and record lists arrive in the next change. This page exists so the sign-in path is real and tested.</p>
    </header>
    <form class="signup-form" method="post" action="${ADMIN_SIGN_OUT_PATH}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <button class="primary-action" type="submit">Sign out</button>
    </form>`,
  );
}

export interface SetupFieldError {
  readonly field: string;
  readonly message: string;
}

export function renderSetupPage(options: {
  readonly csrfToken: string;
  readonly values: Readonly<Record<string, string>>;
  readonly errors: readonly SetupFieldError[];
}): string {
  const value = (name: string) => escapeHtml(options.values[name] ?? "");
  const errorFor = (name: string) =>
    options.errors.find((error) => error.field === name);
  const field = (
    name: string,
    label: string,
    help: string,
    attributes = 'type="text"',
  ) => {
    const error = errorFor(name);
    return `<div class="field ${error ? "has-error" : ""}">
      <label for="${name}">${escapeHtml(label)}</label>
      <div class="field-error-slot">${
        error
          ? `<p class="field-error" id="${name}-error"><span aria-hidden="true">▲</span> ${escapeHtml(error.message)}</p>`
          : ""
      }</div>
      <input id="${name}" name="${name}" ${attributes} value="${value(name)}"${error ? ' aria-invalid="true"' : ""} aria-describedby="${name}-help">
      <p class="help" id="${name}-help">${escapeHtml(help)}</p>
    </div>`;
  };

  const summary =
    options.errors.length === 0
      ? ""
      : `<section class="error-summary" role="alert" tabindex="-1" aria-labelledby="setup-error-title">
      <h2 id="setup-error-title">Check ${options.errors.length === 1 ? "this answer" : "these answers"}</h2>
      <ul>${options.errors
        .map(
          (error) =>
            `<li><a href="#${escapeHtml(error.field)}">${escapeHtml(error.message)}</a></li>`,
        )
        .join("")}</ul>
    </section>`;

  return page(
    "First-run setup",
    `    <header class="signup-header">
      <p class="eyebrow">Organizers</p>
      <h1>Open your first season</h1>
      <p class="lede">Everything a season needs to accept a signup, in one pass. You can change any of it later.</p>
    </header>
    ${summary}
    <form class="signup-form" id="signup-form" method="post" action="/admin/setup">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <fieldset>
        <legend>The event</legend>
        ${field("display_name", "Season name", "What neighbours will see, such as “SAP Porchfest 2027”.")}
        ${field("year", "Year", "The four-digit year this season belongs to.", 'type="number" inputmode="numeric" min="2000" max="2200"')}
        ${field("event_date", "Event date", "The day the porches play.", 'type="date"')}
        ${field("timezone", "Timezone", "The festival's local clock. Everything a participant types is read in this zone.")}
      </fieldset>
      <fieldset>
        <legend>Signups</legend>
        ${field("signup_opens_on", "Signups open", "Optional. Leave blank if you are opening them by hand.", 'type="date"')}
        ${field("signup_closes_on", "Signups close", "Optional.", 'type="date"')}
        <div class="field">
          <label class="choice"><input type="checkbox" name="open_signups" value="yes"${options.values.open_signups === "yes" ? " checked" : ""}><span>Start accepting signups right away</span></label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Time slots</legend>
        <p class="help">The blocks acts play in, on the festival's clock. Leave a row blank to skip it.</p>
        ${[1, 2, 3, 4, 5, 6]
          .map(
            (index) => `<div class="availability-row">
          ${field(`slot_start_${index}`, `Slot ${index} starts`, "", 'type="time"')}
          ${field(`slot_end_${index}`, `Slot ${index} ends`, "", 'type="time"')}
        </div>`,
          )
          .join("")}
      </fieldset>
      <fieldset>
        <legend>Neighbourhood</legend>
        ${field("locality_name", "Locality", "The neighbourhood name, such as “Saint Anthony Park”.")}
        <p class="help">The bounding box is how a geocoded pin gets sanity-checked before it reaches the map.</p>
        <div class="availability-row">
          ${field("bounds_north", "North edge", "", 'type="text" inputmode="decimal"')}
          ${field("bounds_south", "South edge", "", 'type="text" inputmode="decimal"')}
        </div>
        <div class="availability-row">
          ${field("bounds_west", "West edge", "", 'type="text" inputmode="decimal"')}
          ${field("bounds_east", "East edge", "", 'type="text" inputmode="decimal"')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Public addresses and email</legend>
        ${field("public_site_url", "Public site", "Where neighbours read about the festival.", 'type="url"')}
        ${field("public_map_url", "Public map", "Where the map lives.", 'type="url"')}
        ${field("sender_name", "Sender name", "The name organizer email comes from.")}
        ${field("sender_email", "Sender address", "The address organizer email comes from.", 'type="email"')}
      </fieldset>
      <button class="primary-action" type="submit">Open the season</button>
    </form>`,
  );
}
