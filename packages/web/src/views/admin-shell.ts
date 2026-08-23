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

export function renderSignInPage(options: {
  readonly token: string;
  readonly csrfToken: string;
  readonly needsEmail: boolean;
  readonly errors: readonly string[];
}): string {
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
      <p class="lede">Sign-in links work once. If yours has expired, ask another organizer for a new one.</p>
    </header>
    ${errors}
    <form class="signup-form" id="signup-form" method="post" action="${ADMIN_SIGN_IN_PATH}">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="token" value="${escapeHtml(options.token)}">
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
