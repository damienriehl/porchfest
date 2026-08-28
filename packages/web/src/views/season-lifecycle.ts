import {
  isSeasonActionLegal,
  type Season,
  type SeasonAction,
  type SeasonState,
} from "@porchfest/core";
import { escapeHtml } from "./signup-view.js";

export const SEASON_ACTION_LABELS: Readonly<Record<SeasonAction, string>> = {
  signup: "public signups",
  assignment: "assigning acts to slots",
  hold: "holding slots",
  hold_release: "releasing holds",
  correction: "correcting records",
};

const ACTIONS = Object.keys(SEASON_ACTION_LABELS) as SeasonAction[];
export const SEASON_STATES: readonly SeasonState[] = [
  "setup",
  "signups_open",
  "signups_closed",
  "assigning",
  "locked",
  "archived",
];

export function stoppedActions(
  current: SeasonState,
  target: SeasonState,
): readonly SeasonAction[] {
  return ACTIONS.filter(
    (action) =>
      isSeasonActionLegal(current, action) &&
      !isSeasonActionLegal(target, action),
  );
}

export function renderSeasonLifecyclePage(options: {
  readonly season: Season;
  readonly csrfToken: string;
  readonly error?: string;
  readonly transitioned?: boolean;
}): string {
  const currentIndex = SEASON_STATES.indexOf(options.season.state);
  const transitions = SEASON_STATES.slice(currentIndex + 1);
  const notice = options.error
    ? `<section class="error-summary" role="alert" tabindex="-1"><h2>Season state was not changed</h2><p>${escapeHtml(options.error)}</p></section>`
    : options.transitioned
      ? `<section class="confirmation-card" role="status"><p>Season moved to ${escapeHtml(options.season.state)}.</p></section>`
      : "";

  return page(
    "Season settings & state",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)}</p>
      <h1>Season settings &amp; state</h1>
      <p class="lede"><a href="/admin?season=${options.season.id}">Back to activity queue</a></p>
    </header>
    ${notice}
    <section aria-labelledby="current-season-state">
      <h2 id="current-season-state">Current season</h2>
      <dl class="submission-list">
        <div class="submission-row"><dt>Name</dt><dd>${escapeHtml(options.season.displayName)}</dd></div>
        <div class="submission-row"><dt>Year</dt><dd>${options.season.year}</dd></div>
        <div class="submission-row"><dt>Current state</dt><dd>${escapeHtml(options.season.state)}</dd></div>
      </dl>
    </section>
    <section aria-labelledby="season-transitions">
      <h2 id="season-transitions">Available forward transitions</h2>
      ${
        transitions.length === 0
          ? '<p class="help">This season is archived. No further transitions are available.</p>'
          : `<ul class="queue-list">${transitions
              .map((target) => transitionForm(options, target))
              .join("")}</ul>`
      }
    </section>`,
  );
}

function transitionForm(
  options: { readonly season: Season; readonly csrfToken: string },
  target: SeasonState,
): string {
  const stopped = stoppedActions(options.season.state, target).map(
    (action) => SEASON_ACTION_LABELS[action],
  );
  const irreversible = target === "locked" || target === "archived";
  return `<li class="queue-item">
    <div class="queue-item-body">
      <h3>Move to ${escapeHtml(target)}</h3>
      <p>Moving to ${escapeHtml(target)} stops allowing: ${stopped.length ? escapeHtml(stopped.join(", ")) : "nothing new"}.</p>
    </div>
    <form class="signup-form" method="post" action="/admin/seasons/${options.season.id}/transition">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
      <input type="hidden" name="version" value="${options.season.version}">
      <input type="hidden" name="target_state" value="${escapeHtml(target)}">
      ${irreversible ? `<div class="field"><label class="choice" for="confirmation-${escapeHtml(target)}"><input id="confirmation-${escapeHtml(target)}" name="confirmation" type="checkbox" value="confirmed" required> I confirm moving this season to ${escapeHtml(target)}</label></div>` : ""}
      <button class="${irreversible ? "primary-action" : "secondary-action"}" type="submit">Move to ${escapeHtml(target)}</button>
    </form>
  </li>`;
}

function page(title: string, body: string): string {
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
