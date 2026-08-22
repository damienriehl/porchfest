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

export function renderSignupPage(options: {
  readonly title: string;
  readonly eyebrow: string;
  readonly intro: string;
  readonly form: string;
  readonly preview: string;
  readonly errors: readonly SignupError[];
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
  <script type="module" src="/signup/assets/signup-preview.js"></script>
</body>
</html>`;
}

export function renderConfirmationPage(options: {
  readonly title: string;
  readonly kind: "host" | "performer";
  readonly emailConfigured: boolean;
  readonly preview: string;
}): string {
  const kindLabel = options.kind === "host" ? "porch" : "act";
  const formPath =
    options.kind === "host" ? HOST_SIGNUP_PATH : PERFORMER_SIGNUP_PATH;
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
      <h2 id="confirmation-card-title">What you submitted</h2>
      ${options.preview}
    </section>
    <a class="secondary-action" href="${formPath}">Submit another ${kindLabel}</a>
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
