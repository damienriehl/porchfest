import type { AntibotClientChallenge } from "@porchfest/core";
import {
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
} from "@porchfest/core";
import { HOST_SIGNUP_PATH } from "../routes/signup-paths.js";
import {
  allValues,
  escapeHtml,
  firstValue,
  renderBooleanChoices,
  renderChallenge,
  renderCheckboxGroup,
  renderField,
  renderFieldError,
  renderHoneypot,
  renderHostPreview,
  renderSignupPage,
  renderTextarea,
  VENUE_CHOICE_LABELS,
  type SignupError,
  type SignupValues,
} from "./signup-view.js";

type VenueChoice =
  | (typeof venueGearValues)[number]
  | (typeof venueDrinkValues)[number]
  | (typeof venueAmenityValues)[number];

const labels = VENUE_CHOICE_LABELS satisfies Record<string, string>;

function choices(values: readonly VenueChoice[]) {
  // Every venue value has a label; falling back to the value keeps a future
  // schema addition rendering as a readable control instead of an empty one.
  return values.map((value) => ({
    value,
    label: labels[value] ?? value.replaceAll("_", " "),
  }));
}

const gearChoices = choices(venueGearValues);
const drinkChoices = choices(venueDrinkValues);
const amenityChoices = choices(venueAmenityValues);

export function renderHostForm(options: {
  readonly seasonId: string;
  readonly csrfToken: string;
  readonly values?: SignupValues;
  readonly errors?: readonly SignupError[];
  readonly challenge: AntibotClientChallenge | null;
  readonly timezone?: string | null;
}): string {
  const values = options.values ?? {};
  const errors = options.errors ?? [];
  const form = `<form class="signup-form" id="signup-form" data-signup-form="host" method="post" action="${HOST_SIGNUP_PATH}" novalidate>
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
      <legend>Your porch</legend>
      ${renderField({ id: "venue_title", label: "Porch name", value: firstValue(values, "venue_title"), errors, required: true, help: "A friendly public name, such as “The Oak Street Porch.”" })}
      ${renderField({ id: "venue_address", label: "Street address", value: firstValue(values, "venue_address"), errors, required: true, autocomplete: "street-address" })}
      ${renderTextarea({ id: "space_description", label: "Performance space", value: firstValue(values, "space_description"), errors, required: true, help: "Describe the porch, yard, driveway, audience space, and anything performers should know." })}
      ${renderBooleanChoices({ id: "has_power", label: "Can performers use electrical power?", value: firstValue(values, "has_power"), errors })}
      ${renderBooleanChoices({ id: "rain_backup", label: "Do you have a rain backup space?", value: firstValue(values, "rain_backup"), errors })}
    </fieldset>
    <fieldset>
      <legend>What the porch offers</legend>
      ${renderCheckboxGroup({ id: "gear", label: "Gear", selected: allValues(values, "gear"), choices: gearChoices, errors, help: "Choose everything performers may use." })}
      ${renderCheckboxGroup({ id: "drinks", label: "Drinks", selected: allValues(values, "drinks"), choices: drinkChoices, errors })}
      ${renderCheckboxGroup({ id: "amenities", label: "Amenities", selected: allValues(values, "amenities"), choices: amenityChoices, errors })}
    </fieldset>
    <fieldset>
      <legend>Anything else</legend>
      ${renderTextarea({ id: "notes", label: "Notes for the organizers", value: firstValue(values, "notes"), errors, help: "Share access details, neighbor considerations, or questions." })}
    </fieldset>
    ${renderChallenge(options.challenge, errors)}
    ${renderHoneypot()}
    <button class="primary-action" type="submit">Sign up this porch</button>
  </form>`;

  return renderSignupPage({
    title: "Host a Porchfest stage",
    eyebrow: "Host signup",
    intro:
      "Tell the organizers what your porch can offer. Your answers stay on this page if anything needs fixing.",
    form,
    preview: renderHostPreview(values),
    errors,
    challenge: options.challenge,
  });
}
