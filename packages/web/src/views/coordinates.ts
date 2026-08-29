import {
  type CoordinateRejectionCode,
  type Season,
  type VenueCoordinateReview,
} from "@porchfest/core";
import { escapeHtml, renderOrganizerPage } from "./signup-view.js";

export const COORDINATE_REJECTION_MEANINGS = {
  "invalid-coordinate":
    "The provider returned an invalid latitude or longitude.",
  "missing-ref": "The provider result has no provenance reference.",
  interpolated:
    "The point was interpolated along a street rather than located at the address.",
  imprecise: "The result is only precise to the street level.",
  "out-of-bounds": "The point is outside the season bounding box.",
  "cross-check-missing":
    "A house-level result is missing an independent cross-check.",
  "cross-check-distance":
    "The independent cross-check is too far from the result.",
  "address-changed": "The venue address changed after this point was stored.",
  "not-found": "The provider could not locate the address.",
  refused: "The provider refused this lookup.",
} satisfies Record<CoordinateRejectionCode, string>;

export interface GeocodeSeasonCounts {
  stored: number;
  cached: number;
  preserved: number;
  needsReview: number;
  unavailable: number;
  remaining: number;
}

export function renderCoordinatesPage(options: {
  readonly season: Season;
  readonly rows: readonly VenueCoordinateReview[];
  readonly geoConfigured: boolean;
  readonly csrf: {
    readonly verify: string;
    readonly geocode: string;
    readonly publish: string;
    readonly unpublish: string;
  };
  readonly error?: string;
  readonly notice?: string;
  readonly counts?: GeocodeSeasonCounts;
}): string {
  const { season } = options;
  const boxName = season.localityName ?? season.displayName;
  const bounds = completeBounds(season);
  const boundsText = bounds
    ? `${boxName}: north ${bounds.north}, south ${bounds.south}, east ${bounds.east}, west ${bounds.west}`
    : `${boxName}: no complete bounding box is configured`;

  return renderOrganizerPage(
    "Coordinate review",
    `    <header class="signup-header">
      <p class="eyebrow">${escapeHtml(season.displayName)}</p>
      <h1>Coordinate review</h1>
      <p class="lede"><a href="/admin/seasons/${season.id}">Season settings &amp; state</a></p>
    </header>
    ${renderNotice(options)}
    <section aria-labelledby="coordinate-bounds">
      <h2 id="coordinate-bounds">Season bounding box</h2>
      <p>${escapeHtml(boundsText)}</p>
    </section>
    ${renderGeocodeSection(options)}
    ${renderPublicationSection(options)}
    <section aria-labelledby="coordinate-review-list">
      <h2 id="coordinate-review-list">Coordinates needing review</h2>
      ${renderRows(options)}
    </section>`,
  );
}

function renderNotice(options: {
  readonly error?: string;
  readonly notice?: string;
  readonly counts?: GeocodeSeasonCounts;
}): string {
  if (options.error) {
    return `<section class="error-summary" role="alert" tabindex="-1"><h2>Coordinate action was not completed</h2><p>${escapeHtml(options.error)}</p>${options.counts ? `<p>${geocodeCountsText(options.counts)}</p>` : ""}</section>`;
  }
  if (options.counts) {
    return `<section class="confirmation-card" role="status"><p>Season geocoding finished: ${geocodeCountsText(options.counts)}</p></section>`;
  }
  return options.notice
    ? `<section class="confirmation-card" role="status"><p>${escapeHtml(options.notice)}</p></section>`
    : "";
}

function geocodeCountsText(counts: GeocodeSeasonCounts): string {
  const summary = `stored ${counts.stored}; cached ${counts.cached}; preserved ${counts.preserved}; needs review ${counts.needsReview}; unavailable ${counts.unavailable}.`;
  return counts.remaining > 0
    ? `${summary} ${counts.remaining} venues remain — run again.`
    : summary;
}

function renderGeocodeSection(options: {
  readonly season: Season;
  readonly geoConfigured: boolean;
  readonly csrf: { readonly geocode: string };
}): string {
  const disabled = options.geoConfigured ? "" : " disabled";
  return `<section aria-labelledby="season-geocoding">
      <h2 id="season-geocoding">Geocode this season</h2>
      ${options.geoConfigured ? '<p class="help">Venues are processed one at a time to respect the provider policy.</p>' : '<p class="help">Geocoding is not configured. Set <code>GEO_PROVIDER</code> to enable it.</p>'}
      <form class="signup-form" method="post" action="/seasons/${options.season.id}/coordinates/geocode">
        <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.geocode)}">
        <button class="secondary-action" type="submit"${disabled}>Geocode this season</button>
      </form>
    </section>`;
}

function renderPublicationSection(options: {
  readonly season: Season;
  readonly csrf: { readonly publish: string; readonly unpublish: string };
}): string {
  const { season } = options;
  const published = season.mapPublishedAt;
  const status = published ? published.toISOString() : "Not published";
  const controls =
    season.state !== "locked"
      ? '<p class="help">Publication controls appear only while the season is locked.</p>'
      : `<p><a href="/map">Public map</a> · <a href="/map/data.json">Public map data</a></p>
        <form class="signup-form" method="post" action="/seasons/${season.id}/map/${published ? "unpublish" : "publish"}">
          <input type="hidden" name="_csrf" value="${escapeHtml(published ? options.csrf.unpublish : options.csrf.publish)}">
          <input type="hidden" name="version" value="${season.version}">
          ${
            published
              ? ""
              : `<label>Event city <input name="event_city" required value="${escapeHtml(season.eventCity)}"></label>
          <label>Event state or region <input name="event_state" required value="${escapeHtml(season.eventState)}"></label>`
          }
          <button class="${published ? "secondary-action" : "primary-action"}" type="submit">${published ? "Unpublish map" : "Publish map"}</button>
        </form>`;
  return `<section aria-labelledby="map-publication">
      <h2 id="map-publication">Public map</h2>
      <dl class="submission-list"><div class="submission-row"><dt>Published at</dt><dd>${escapeHtml(status)}</dd></div></dl>
      ${controls}
    </section>`;
}

function renderRows(options: {
  readonly season: Season;
  readonly rows: readonly VenueCoordinateReview[];
  readonly csrf: { readonly verify: string };
}): string {
  if (options.rows.length === 0) {
    return '<p class="help">No stored coordinates need review.</p>';
  }
  return `<div class="table-scroll"><table>
        <thead><tr><th>Venue</th><th>Address</th><th>Status</th><th>Reason</th><th>Candidate</th><th>Verify pin</th></tr></thead>
        <tbody>${options.rows.map((row) => renderRow(options, row)).join("")}</tbody>
      </table></div>`;
}

function renderRow(
  options: {
    readonly season: Season;
    readonly csrf: { readonly verify: string };
  },
  row: VenueCoordinateReview,
): string {
  const reason = row.rejectionCode
    ? COORDINATE_REJECTION_MEANINGS[row.rejectionCode]
    : "No rejection code was recorded.";
  const latitude = row.coordinate.latitude?.toString() ?? "";
  const longitude = row.coordinate.longitude?.toString() ?? "";
  const candidate =
    latitude && longitude ? `${latitude}, ${longitude}` : "No candidate point";
  const verification = row.address?.trim()
    ? `<form method="post" action="/seasons/${options.season.id}/coordinates/${row.venueId}/verify">
            <input type="hidden" name="_csrf" value="${escapeHtml(options.csrf.verify)}">
            <input type="hidden" name="version" value="${row.venueVersion}">
            <label>Latitude <input name="latitude" inputmode="decimal" required value="${escapeHtml(latitude)}"></label>
            <label>Longitude <input name="longitude" inputmode="decimal" required value="${escapeHtml(longitude)}"></label>
            <button class="secondary-action" type="submit">Verify pin</button>
          </form>`
    : '<p class="help">Add an address before verifying this pin.</p>';
  return `<tr>
          <td>${escapeHtml(row.title)}</td>
          <td>${escapeHtml(row.address ?? "No address")}</td>
          <td>${escapeHtml(row.status)}</td>
          <td>${escapeHtml(reason)}</td>
          <td>${escapeHtml(candidate)}</td>
          <td>${verification}</td>
        </tr>`;
}

function completeBounds(season: Season) {
  const { boundsNorth, boundsSouth, boundsEast, boundsWest } = season;
  if (
    boundsNorth === null ||
    boundsSouth === null ||
    boundsEast === null ||
    boundsWest === null
  ) {
    return null;
  }
  return {
    north: boundsNorth,
    south: boundsSouth,
    east: boundsEast,
    west: boundsWest,
  };
}
