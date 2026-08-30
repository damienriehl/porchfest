import type { AntibotClientChallenge, Season } from "@porchfest/core";
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
  renderSelectedSeason,
  renderSignupPage,
  renderTextarea,
  HOST_SIGNUP_AUDIENCES,
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
  readonly season?: Season | null;
}): string {
  const values = options.values ?? {};
  const errors = options.errors ?? [];
  const form = `<form class="signup-form" id="signup-form" data-signup-form="host" method="post" action="${HOST_SIGNUP_PATH}" novalidate>
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="season_id" value="${escapeHtml(options.seasonId)}">
    ${renderSelectedSeason(options.season ?? null)}
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
      ${renderField({ id: "contact_name", label: "Your name", value: firstValue(values, "contact_name"), errors, required: true, autocomplete: "name", audience: HOST_SIGNUP_AUDIENCES.contact_name })}
      ${renderField({ id: "contact_email", label: "Email", value: firstValue(values, "contact_email"), errors, required: true, type: "email", autocomplete: "email", audience: HOST_SIGNUP_AUDIENCES.contact_email })}
      ${renderField({ id: "contact_phone", label: "Phone", value: firstValue(values, "contact_phone"), errors, type: "tel", autocomplete: "tel", audience: HOST_SIGNUP_AUDIENCES.contact_phone })}
    </fieldset>
    <fieldset>
      <legend>Your porch</legend>
      ${renderField({ id: "venue_title", label: "Porch name", value: firstValue(values, "venue_title"), errors, required: true, help: "A friendly public name, such as “The Oak Street Porch.”", audience: HOST_SIGNUP_AUDIENCES.venue_title })}
      ${renderField({ id: "venue_address", label: "Street address", value: firstValue(values, "venue_address"), errors, required: true, autocomplete: "street-address", help: "Your full street address will appear on the public map once the organizer publishes the matched porch.", audience: HOST_SIGNUP_AUDIENCES.venue_address })}
      ${renderTextarea({ id: "space_description", label: "Performance space", value: firstValue(values, "space_description"), errors, required: true, help: "Describe the porch, yard, driveway, audience space, and anything performers should know.", audience: HOST_SIGNUP_AUDIENCES.space_description })}
      ${renderBooleanChoices({ id: "has_power", label: "Can performers use electrical power?", value: firstValue(values, "has_power"), errors, audience: HOST_SIGNUP_AUDIENCES.has_power })}
      ${renderBooleanChoices({ id: "rain_backup", label: "Do you have a rain backup space?", value: firstValue(values, "rain_backup"), errors, help: "No means there is no covered or indoor backup space; organizers and a confirmed match will need to plan accordingly.", audience: HOST_SIGNUP_AUDIENCES.rain_backup })}
      ${renderTextarea({ id: "requested_act_names", label: "Any acts you'd love on your porch?", value: firstValue(values, "requested_act_names"), errors, audience: HOST_SIGNUP_AUDIENCES.requested_act_names })}
      ${renderTextarea({ id: "genre_preferences", label: "What kinds of music would suit your porch?", value: firstValue(values, "genre_preferences"), errors, audience: HOST_SIGNUP_AUDIENCES.genre_preferences })}
    </fieldset>
    <fieldset>
      <legend>What the porch offers</legend>
      ${renderCheckboxGroup({ id: "gear", label: "Gear", selected: allValues(values, "gear"), choices: gearChoices, errors, help: "Choose everything performers may use.", audience: HOST_SIGNUP_AUDIENCES.gear })}
      ${renderCheckboxGroup({ id: "drinks", label: "Drinks", selected: allValues(values, "drinks"), choices: drinkChoices, errors, audience: HOST_SIGNUP_AUDIENCES.drinks })}
      ${renderCheckboxGroup({ id: "amenities", label: "Amenities", selected: allValues(values, "amenities"), choices: amenityChoices, errors, help: "A checked amenity is available to the performers matched with your porch and may also help visitors plan.", audience: HOST_SIGNUP_AUDIENCES.amenities })}
    </fieldset>
    <fieldset>
      <legend>Anything else</legend>
      ${renderTextarea({ id: "notes", label: "Notes for your confirmed match", value: firstValue(values, "notes"), errors, help: "Share access details or neighbour considerations that organizers will include in the confirmed match notification.", audience: HOST_SIGNUP_AUDIENCES.notes })}
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
