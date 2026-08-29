import {
  isSeasonActionLegal,
  seasonStates,
  type Season,
  type SeasonAction,
  type SeasonState,
} from "@porchfest/core";
import { escapeHtml, renderOrganizerPage } from "./signup-view.js";

export const SEASON_ACTION_LABELS: Readonly<Record<SeasonAction, string>> = {
  signup: "public signups",
  assignment: "assigning acts to slots",
  hold: "holding slots",
  hold_release: "releasing holds",
  correction: "correcting records",
};

const ACTIONS = Object.keys(SEASON_ACTION_LABELS) as SeasonAction[];

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
  readonly heldSlotCount: number;
  readonly csrfToken: string;
  readonly error?: string;
  readonly transitioned?: boolean;
}): string {
  const currentIndex = seasonStates.indexOf(options.season.state);
  const transitions = seasonStates.slice(currentIndex + 1);
  const notice = renderNotice(options);

  return renderOrganizerPage(
    "Season settings & state",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)}</p>
      <h1>Season settings &amp; state</h1>
      <p class="lede"><a href="/admin?season=${options.season.id}">Back to activity queue</a> · <a href="/admin/seasons/${options.season.id}/outbox">Email outbox</a> · <a href="/seasons/${options.season.id}/coordinates">Coordinate review &amp; map publication</a></p>
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

function renderNotice(options: {
  readonly season: Season;
  readonly error?: string;
  readonly transitioned?: boolean;
}): string {
  if (options.error) {
    return `<section class="error-summary" role="alert" tabindex="-1"><h2>Season state was not changed</h2><p>${escapeHtml(options.error)}</p></section>`;
  }
  if (options.transitioned) {
    return `<section class="confirmation-card" role="status"><p>Season moved to ${escapeHtml(options.season.state)}.</p></section>`;
  }
  return "";
}

function transitionForm(
  options: {
    readonly season: Season;
    readonly csrfToken: string;
    readonly heldSlotCount: number;
  },
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
      ${target === "archived" && options.heldSlotCount > 0 ? `<p class="help">${options.heldSlotCount === 1 ? "1 slot is still held; release it before archiving." : `${options.heldSlotCount} slots are still held; release them before archiving.`}</p>` : ""}
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
