import {
  formatZonedWindow,
  isSeasonActionLegal,
  type Act,
  type Assignment,
  type RankedSuggestion,
  type Season,
  type Slot,
  type Venue,
} from "@porchfest/core";
import { escapeHtml, renderOrganizerPage } from "./signup-view.js";
import { formatZonedDateInput } from "../timezone.js";

export interface VenueAssignmentPageOptions {
  readonly season: Season;
  readonly venue: Venue;
  readonly hostName: string | null;
  readonly slots: readonly Slot[];
  readonly acts: readonly Act[];
  readonly venues: readonly Venue[];
  readonly assignments: readonly Assignment[];
  readonly suggestions: readonly RankedSuggestion[];
  readonly csrf: {
    readonly assign: string;
    readonly unassign: string;
    readonly hold: string;
    readonly release: string;
  };
  readonly error?: string;
  readonly assignedActId?: number | null;
  readonly releasedTargetVenue?: Venue | null;
}

export function renderAssignVenuePage(
  options: VenueAssignmentPageOptions,
): string {
  const assignmentLegal = isSeasonActionLegal(
    options.season.state,
    "assignment",
  );
  const notice = renderNotice(options, assignmentLegal);
  const released = options.releasedTargetVenue
    ? `<section class="confirmation" role="status"><p>Hold released. <a href="/admin/venues/${options.releasedTargetVenue.id}/assign">Assign at ${escapeHtml(options.releasedTargetVenue.title)}</a>.</p></section>`
    : "";

  return renderOrganizerPage(
    `Assign acts at ${options.venue.title}`,
    `<header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)} · Venue matching</p>
      <h1>${escapeHtml(options.venue.title)}</h1>
      <p class="lede">${escapeHtml(options.venue.address ?? "Address not provided")} · ${options.venue.hasPower === true ? "Power available" : options.venue.hasPower === false ? "No power" : "Power unknown"}</p>
      <p class="lede">Host: ${escapeHtml(options.hostName ?? "Not named")}</p>
      <p class="lede"><a href="/admin/records/venue/${options.venue.id}?season=${options.season.id}">View venue record</a> · <a href="/admin?season=${options.season.id}">Back to activity queue</a></p>
    </header>
    ${notice}${released}
    <section aria-labelledby="venue-slots-title">
      <h2 id="venue-slots-title">Venue slots</h2>
      ${
        options.slots.length === 0
          ? '<p class="help">This season has no configured time slots.</p>'
          : options.slots
              .map((slot) =>
                slotSection(
                  options,
                  slot,
                  options.assignments.find(
                    (assignment) => assignment.slotId === slot.id,
                  ),
                  assignmentLegal,
                ),
              )
              .join("")
      }
    </section>`,
  );
}

function renderNotice(
  options: VenueAssignmentPageOptions,
  assignmentLegal: boolean,
): string {
  if (!assignmentLegal) {
    return `<section class="error-summary" role="status"><h2>Assignments are closed</h2><p>The season state is ${escapeHtml(options.season.state)}; assigning acts to slots is not allowed.</p></section>`;
  }
  if (options.error) {
    return `<section class="error-summary" role="alert"><h2>Assignment was not changed</h2><p>${escapeHtml(options.error)}</p></section>`;
  }
  if (options.assignedActId) {
    const actName =
      options.acts.find((act) => act.id === options.assignedActId)?.name ??
      "Act";
    return `<section class="confirmation" role="status"><p>${escapeHtml(actName)} was assigned.</p></section>`;
  }
  return "";
}

function slotSection(
  options: VenueAssignmentPageOptions,
  slot: Slot,
  assignment: Assignment | undefined,
  assignmentLegal: boolean,
): string {
  const title = formatZonedWindow(slot, options.season.timezone);
  if (slot.state === "held") {
    const fallback =
      slot.fallbackVenueId === null
        ? "No fallback venue"
        : `Fallback: ${options.venues.find((venue) => venue.id === slot.fallbackVenueId)?.title ?? "Unknown venue"}`;
    return `<section class="matching-slot" aria-labelledby="slot-${slot.id}">
      <h3 id="slot-${slot.id}">${escapeHtml(title)} · Held</h3>
      <p>Held for ${escapeHtml(slot.heldForName ?? "Unnamed act")} until ${escapeHtml(slot.heldDecideBy ? formatZonedDateInput(slot.heldDecideBy, options.season.timezone) : "no decide-by date")}.</p>
      <p class="help">${escapeHtml(fallback)}</p>
      <form class="signup-form compact-form" method="post" action="/admin/slots/${slot.id}/release">
        ${hidden(options.csrf.release, slot.version, "venue")}
        <button class="secondary-action" type="submit">Release hold</button>
      </form>
    </section>`;
  }
  if (slot.state === "assigned") {
    const act = assignment
      ? options.acts.find((item) => item.id === assignment.actId)
      : undefined;
    return `<section class="matching-slot" aria-labelledby="slot-${slot.id}">
      <h3 id="slot-${slot.id}">${escapeHtml(title)} · Assigned</h3>
      <p>${act ? `<a href="/admin/acts/${act.id}/assign">${escapeHtml(act.name)}</a>` : "Assigned act unavailable"}</p>
      ${
        assignment && assignmentLegal
          ? `<form class="signup-form compact-form" method="post" action="/admin/assignments/${assignment.id}/unassign">
        ${hidden(options.csrf.unassign, assignment.version, "venue")}
        <button class="secondary-action" type="submit">Unassign</button>
      </form>`
          : ""
      }
    </section>`;
  }

  const candidates = options.suggestions
    .filter((pairing) => pairing.slot.id === slot.id)
    .slice(0, 5);
  return `<section class="matching-slot" aria-labelledby="slot-${slot.id}">
    <h3 id="slot-${slot.id}">${escapeHtml(title)} · Open</h3>
    ${
      assignmentLegal
        ? candidates.length === 0
          ? '<p class="help">No eligible acts are available for this slot.</p>'
          : `<ol class="matching-candidates">${candidates.map((pairing) => venueCandidate(options, slot, pairing)).join("")}</ol>`
        : '<p class="help">Candidate assignments are unavailable in this season state.</p>'
    }
    ${isSeasonActionLegal(options.season.state, "hold") ? holdForm(options, slot) : ""}
  </section>`;
}

function venueCandidate(
  options: VenueAssignmentPageOptions,
  slot: Slot,
  pairing: RankedSuggestion,
): string {
  const sharedMember = pairing.warnings.some(
    (warning) => warning.code === "shared_member",
  );
  return `<li class="matching-candidate">
    <h4><a href="/admin/acts/${pairing.act.id}/assign">${escapeHtml(pairing.act.name)}</a></h4>
    ${pairing.isBestScoreTie ? '<p class="help">Equally suitable based on recorded information</p>' : ""}
    ${explanation(pairing)}
    <form class="signup-form compact-form" method="post" action="/admin/slots/${slot.id}/assign">
      <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.assign)}">
      <input type="hidden" name="slot" value="${slot.id}">
      <input type="hidden" name="act" value="${pairing.act.id}">
      <input type="hidden" name="version" value="${slot.version}">
      <input type="hidden" name="return_to" value="venue">
      ${sharedMember ? `<div class="field"><label for="override-${slot.id}-${pairing.act.id}">Shared-member override reason</label><input id="override-${slot.id}-${pairing.act.id}" name="override_reason" type="text" required></div>` : ""}
      <button class="primary-action" type="submit">Assign ${escapeHtml(pairing.act.name)}</button>
    </form>
  </li>`;
}

function holdForm(options: VenueAssignmentPageOptions, slot: Slot): string {
  return `<form class="signup-form compact-form hold-form" method="post" action="/admin/slots/${slot.id}/hold">
    ${hidden(options.csrf.hold, slot.version, "venue")}
    <fieldset><legend>Hold this slot</legend>
      <div class="field"><label for="held-for-${slot.id}">Named act</label><input id="held-for-${slot.id}" name="held_for" type="text" required></div>
      <div class="field"><label for="decide-by-${slot.id}">Decide-by date</label><input id="decide-by-${slot.id}" name="decide_by" type="date" required></div>
      <div class="field"><label for="fallback-${slot.id}">Fallback venue (optional)</label><select id="fallback-${slot.id}" name="fallback_venue"><option value="">No fallback</option>${options.venues
        .filter((venue) => venue.id !== options.venue.id)
        .map(
          (venue) =>
            `<option value="${venue.id}">${escapeHtml(venue.title)}</option>`,
        )
        .join("")}</select></div>
    </fieldset>
    <button class="secondary-action" type="submit">Hold this slot</button>
  </form>`;
}

function explanation(pairing: RankedSuggestion): string {
  return `<div class="matching-explanation"><p class="help">Why this match:</p><ul>${pairing.reasons.map((reason) => `<li>${escapeHtml(reason.text)}</li>`).join("")}</ul>${pairing.warnings.length === 0 ? "" : `<p class="help">Warnings:</p><ul class="matching-warnings">${pairing.warnings.map((warning) => `<li>${escapeHtml(warning.text)}</li>`).join("")}</ul>`}</div>`;
}

function hidden(csrf: string, version: number, returnTo: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="version" value="${version}"><input type="hidden" name="return_to" value="${returnTo}">`;
}
