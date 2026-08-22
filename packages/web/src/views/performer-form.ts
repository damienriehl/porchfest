import {
  escapeHtml,
  firstValue,
  renderBooleanChoices,
  renderField,
  renderFieldError,
  renderHoneypot,
  renderPerformerPreview,
  renderSignupPage,
  renderTextarea,
  type SignupError,
  type SignupValues,
} from "./signup-view.js";
import { PERFORMER_SIGNUP_PATH } from "../routes/signup-paths.js";

export function renderPerformerForm(options: {
  readonly seasonId: string;
  readonly csrfToken: string;
  readonly values?: SignupValues;
  readonly errors?: readonly SignupError[];
  readonly challengeConfigured: boolean;
}): string {
  const values = options.values ?? {};
  const errors = options.errors ?? [];
  const starts = values.availability_start ?? [""];
  const ends = values.availability_end ?? [""];
  const windowCount = Math.max(starts.length, ends.length, 2);
  const availabilityError = errors.find(
    ({ field }) => field === "availability_start",
  );
  const availabilityRows = Array.from({ length: windowCount }, (_, index) => {
    const number = index + 1;
    return `<div class="availability-row">
      ${renderField({ id: `availability_start_${number}`, name: "availability_start", label: `Available from ${number}`, value: starts[index] ?? "", errors: [], type: "datetime-local" })}
      ${renderField({ id: `availability_end_${number}`, name: "availability_end", label: `Available until ${number}`, value: ends[index] ?? "", errors: [], type: "datetime-local" })}
    </div>`;
  }).join("");

  const form = `<form class="signup-form" id="signup-form" data-signup-form="performer" method="post" action="${PERFORMER_SIGNUP_PATH}" novalidate>
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="season_id" value="${escapeHtml(options.seasonId)}">
    ${
      errors.some(({ field }) => field === "signup-form")
        ? `<div class="form-level-error">${renderFieldError(
            "signup-form",
            errors.find(({ field }) => field === "signup-form"),
          )}</div>`
        : ""
    }
    <fieldset>
      <legend>Who you are</legend>
      ${renderField({ id: "contact_name", label: "Your name", value: firstValue(values, "contact_name"), errors, required: true, autocomplete: "name" })}
      ${renderField({ id: "contact_email", label: "Email", value: firstValue(values, "contact_email"), errors, required: true, type: "email", autocomplete: "email" })}
      ${renderField({ id: "contact_phone", label: "Phone", value: firstValue(values, "contact_phone"), errors, type: "tel", autocomplete: "tel" })}
    </fieldset>
    <fieldset>
      <legend>Your act</legend>
      ${renderField({ id: "act_name", label: "Act name", value: firstValue(values, "act_name"), errors, required: true })}
      ${renderField({ id: "genres", label: "Genres", value: firstValue(values, "genres"), errors, required: true, help: "Use the words listeners would use to find your music." })}
      ${renderTextarea({ id: "description", label: "Act description", value: firstValue(values, "description"), errors, required: true, help: "A short public description for the map and organizer materials." })}
      ${renderTextarea({ id: "links", label: "Music and website links", value: firstValue(values, "links"), errors, help: "One http:// or https:// link per line." })}
    </fieldset>
    <fieldset>
      <legend>How you play</legend>
      ${renderField({ id: "duration_minutes", label: "Set duration in minutes", value: firstValue(values, "duration_minutes"), errors, required: true, type: "number", inputmode: "numeric", min: "5", max: "240", step: "5" })}
      ${renderBooleanChoices({ id: "requires_amplification", label: "Does your act need amplification?", value: firstValue(values, "requires_amplification"), errors })}
      <div class="field ${availabilityError ? "has-error" : ""}" id="availability_start">
        <h3 class="field-heading">Available time windows <span aria-hidden="true">*</span></h3>
        ${renderFieldError("availability_start", availabilityError)}
        <p class="help">Add every window when your whole act can perform. Leave unused rows blank.</p>
        ${availabilityRows}
      </div>
      ${renderTextarea({ id: "house_preference", label: "Porch or neighborhood preference", value: firstValue(values, "house_preference"), errors, help: "Name a host, area, accessibility need, or say that you have no preference." })}
      ${renderBooleanChoices({ id: "can_lend_gear", label: "Can your act lend gear?", value: firstValue(values, "can_lend_gear"), errors })}
    </fieldset>
    <fieldset>
      <legend>Anything else</legend>
      <p class="help">The organizers will follow up if they need details that do not fit above.</p>
    </fieldset>
    ${options.challengeConfigured ? renderField({ id: "antibot_token", label: "Verification response", value: firstValue(values, "antibot_token"), errors, required: true, help: "Complete the configured anti-bot check and provide its response." }) : ""}
    ${renderHoneypot()}
    <button class="primary-action" type="submit">Sign up this act</button>
  </form>`;

  return renderSignupPage({
    title: "Play Porchfest",
    eyebrow: "Performer signup",
    intro:
      "Tell the organizers how your act plays and when everyone is available. Nothing typed disappears if an answer needs fixing.",
    form,
    preview: renderPerformerPreview(values),
    errors,
  });
}
