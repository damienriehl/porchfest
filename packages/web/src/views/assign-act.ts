import {
  isSeasonActionLegal,
  type Act,
  type ActLink,
  type Assignment,
  type MatchingAct,
  type RankedPairing,
  type Season,
  type Slot,
  type Venue,
} from "@porchfest/core";
import { escapeHtml } from "./signup-view.js";
import { assignmentPage as page, formatSlot } from "./assign-venue.js";

export interface ActAssignmentPageOptions {
  readonly season: Season;
  readonly act: Act;
  readonly matchingAct: MatchingAct;
  readonly acts: readonly Act[];
  readonly venues: readonly Venue[];
  readonly slots: readonly Slot[];
  readonly assignments: readonly Assignment[];
  readonly links: readonly ActLink[];
  readonly suggestions: readonly RankedPairing[];
  readonly csrf: {
    readonly assign: string;
    readonly unassign: string;
    readonly link: string;
    readonly unlink: string;
  };
  readonly error?: string;
  readonly assigned?: boolean;
}

export function renderAssignActPage(options: ActAssignmentPageOptions): string {
  const assignmentLegal = isSeasonActionLegal(
    options.season.state,
    "assignment",
  );
  const current = options.assignments.find(
    (assignment) => assignment.actId === options.act.id,
  );
  const currentSlot = current
    ? options.slots.find((slot) => slot.id === current.slotId)
    : undefined;
  const currentVenue = currentSlot
    ? options.venues.find((venue) => venue.id === currentSlot.venueId)
    : undefined;
  const notice = !assignmentLegal
    ? `<section class="error-summary" role="status"><h2>Assignments are closed</h2><p>The season state is ${escapeHtml(options.season.state)}; assigning acts to slots is not allowed.</p></section>`
    : options.error
      ? `<section class="error-summary" role="alert"><h2>Assignment was not changed</h2><p>${escapeHtml(options.error)}</p></section>`
      : options.assigned
        ? '<section class="confirmation" role="status"><p>Act was assigned.</p></section>'
        : "";

  return page(
    `Find a porch for ${options.act.name}`,
    `<header class="signup-header">
      <p class="eyebrow">${escapeHtml(options.season.displayName)} · Act matching</p>
      <h1>${escapeHtml(options.act.name)}</h1>
      <p class="lede">${escapeHtml(options.act.genre ?? "Genre not provided")} · ${options.act.requiresAmplification ? "Amplification required" : "Acoustic / no amplification required"}</p>
      <p class="lede"><a href="/admin/records/act/${options.act.id}?season=${options.season.id}">View act record</a> · <a href="/admin?season=${options.season.id}">Back to activity queue</a></p>
    </header>
    ${notice}
    <section aria-labelledby="act-details-title"><h2 id="act-details-title">Matching details</h2>
      <dl class="submission-list">
        <div class="submission-row"><dt>Availability</dt><dd>${escapeHtml(availability(options.matchingAct, options.season.timezone))}</dd></div>
        <div class="submission-row"><dt>Porch preference</dt><dd>${escapeHtml(options.act.housePreference ?? "None stated")}</dd></div>
        <div class="submission-row"><dt>Shared-member note</dt><dd>${escapeHtml(options.act.sharedMemberNote ?? "None stated")}</dd></div>
      </dl>
    </section>
    <section aria-labelledby="current-assignment-title"><h2 id="current-assignment-title">Current assignment</h2>
      ${current && currentSlot && currentVenue ? `<p><a href="/admin/venues/${currentVenue.id}/assign">${escapeHtml(currentVenue.title)}</a>, ${escapeHtml(formatSlot(currentSlot, options.season.timezone))}</p><form class="signup-form compact-form" method="post" action="/admin/assignments/${current.id}/unassign"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.unassign)}"><input type="hidden" name="version" value="${current.version}"><input type="hidden" name="return_to" value="act"><button class="secondary-action" type="submit">Unassign</button></form>` : '<p class="help">Not assigned yet.</p>'}
    </section>
    <section aria-labelledby="candidate-slots-title"><h2 id="candidate-slots-title">Ranked porch slots</h2>
      ${!assignmentLegal ? '<p class="help">Candidate assignments are unavailable in this season state.</p>' : current ? '<p class="help">Unassign this act before choosing another slot.</p>' : renderSuggestions(options)}
    </section>
    ${renderLinks(options)}`,
  );
}

function renderSuggestions(options: ActAssignmentPageOptions): string {
  const candidates = options.suggestions.slice(0, 10);
  if (candidates.length === 0)
    return '<p class="help">No eligible porch slots are available.</p>';
  const groups: Array<{
    readonly venueId: number;
    readonly pairings: RankedPairing[];
  }> = [];
  for (const pairing of candidates) {
    const group = groups.find((item) => item.venueId === pairing.venue.id);
    if (group) group.pairings.push(pairing);
    else groups.push({ venueId: pairing.venue.id, pairings: [pairing] });
  }
  return groups
    .map(({ venueId, pairings }) => {
      const venue = pairings[0]?.venue;
      return `<section class="matching-venue"><h3><a href="/admin/venues/${venueId}/assign">${escapeHtml(venue?.title ?? "Venue")}</a></h3><ol class="matching-candidates">${pairings
        .map((pairing) =>
          actCandidate(
            options,
            options.slots.find((slot) => slot.id === pairing.slot.id),
            pairing,
          ),
        )
        .join("")}</ol></section>`;
    })
    .join("");
}

function actCandidate(
  options: ActAssignmentPageOptions,
  slot: Slot | undefined,
  pairing: RankedPairing,
): string {
  if (!slot) return "";
  const sharedMember = pairing.warnings.some(
    (warning) => warning.code === "shared_member",
  );
  return `<li class="matching-candidate"><h4>${escapeHtml(formatSlot(slot, options.season.timezone))}</h4>
    <div class="matching-explanation"><p class="help">Why this match:</p><ul>${pairing.reasons.map((reason) => `<li>${escapeHtml(reason.text)}</li>`).join("")}</ul>${pairing.warnings.length ? `<p class="help">Warnings:</p><ul class="matching-warnings">${pairing.warnings.map((warning) => `<li>${escapeHtml(warning.text)}</li>`).join("")}</ul>` : ""}</div>
    <form class="signup-form compact-form" method="post" action="/admin/slots/${slot.id}/assign"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.assign)}"><input type="hidden" name="slot" value="${slot.id}"><input type="hidden" name="act" value="${options.act.id}"><input type="hidden" name="version" value="${slot.version}"><input type="hidden" name="return_to" value="act">${sharedMember ? `<div class="field"><label for="override-${slot.id}-${options.act.id}">Shared-member override reason</label><input id="override-${slot.id}-${options.act.id}" name="override_reason" type="text" required></div>` : ""}<button class="primary-action" type="submit">Assign to ${escapeHtml(pairing.venue.title)}</button></form>
  </li>`;
}

function renderLinks(options: ActAssignmentPageOptions): string {
  const linkedIds = new Set<number>();
  for (const link of options.links) {
    linkedIds.add(
      link.actId === options.act.id ? link.linkedActId : link.actId,
    );
  }
  const otherActs = options.acts.filter(
    (act) => act.id !== options.act.id && !linkedIds.has(act.id),
  );
  return `<section aria-labelledby="act-links-title"><h2 id="act-links-title">Acts sharing a member</h2>
    ${
      options.links.length === 0
        ? '<p class="help">No linked acts.</p>'
        : `<ul class="queue-list">${options.links
            .map((link) => {
              const linkedId =
                link.actId === options.act.id ? link.linkedActId : link.actId;
              return `<li class="queue-item"><div class="queue-item-body"><h3><a href="/admin/acts/${linkedId}/assign">${escapeHtml(options.acts.find((act) => act.id === linkedId)?.name ?? "Linked act")}</a></h3>${link.note ? `<p>${escapeHtml(link.note)}</p>` : ""}</div><form method="post" action="/admin/act-links/${link.id}/unlink"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.unlink)}"><input type="hidden" name="version" value="${link.version}"><input type="hidden" name="act" value="${options.act.id}"><button class="secondary-action" type="submit">Unlink</button></form></li>`;
            })
            .join("")}</ul>`
    }
    ${otherActs.length === 0 ? "" : `<form class="signup-form compact-form" method="post" action="/admin/acts/${options.act.id}/links"><input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.link)}"><div class="field"><label for="linked-act">Link another act (shares a member)</label><select id="linked-act" name="linked_act" required><option value="">Choose an act</option>${otherActs.map((act) => `<option value="${act.id}">${escapeHtml(act.name)}</option>`).join("")}</select></div><div class="field"><label for="link-note">Shared-member note (optional)</label><input id="link-note" name="note" type="text"></div><button class="secondary-action" type="submit">Link acts</button></form>`}
  </section>`;
}

function availability(act: MatchingAct, timezone: string): string {
  if (act.availabilities.length === 0) return "Not stated";
  return act.availabilities
    .map((window) => formatSlot(window, timezone))
    .join(", ");
}
