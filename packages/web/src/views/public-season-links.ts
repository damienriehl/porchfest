import { isSeasonActionLegal, type SeasonState } from "@porchfest/core";
import type { SeasonSignupUrls } from "../routes/signup-paths.js";
import { seasonStateLabel } from "./season-labels.js";
import { escapeHtml } from "./signup-view.js";

export function renderPublicSeasonLinks(
  signupUrls: SeasonSignupUrls | null,
  publicMapUrl: string | null,
  seasonState: SeasonState,
): string {
  return `<section aria-labelledby="public-season-links">
      <h2 id="public-season-links">Share this season</h2>
      ${
        signupUrls
          ? `<dl class="submission-list">
        ${renderSignupUrl("Host signup", signupUrls.host, seasonState)}
        ${renderSignupUrl("Performer signup", signupUrls.performer, seasonState)}
      </dl>`
          : '<p class="help">Shareable signup URLs are unavailable because PUBLIC_BASE_URL is not configured.</p>'
      }
      ${publicMapUrl ? `<p>Public map: <a href="${escapeHtml(publicMapUrl)}">${escapeHtml(publicMapUrl)}</a></p>` : '<p class="help">No public map URL is configured for this season.</p>'}
    </section>`;
}

function renderSignupUrl(
  label: string,
  url: string,
  seasonState: SeasonState,
): string {
  const escapedUrl = escapeHtml(url);
  return `<div class="submission-row"><dt>${escapeHtml(label)}</dt><dd>${
    isSeasonActionLegal(seasonState, "signup")
      ? `<a href="${escapedUrl}">${escapedUrl}</a>`
      : `<span>${escapedUrl}</span> <span class="help">Inactive — ${escapeHtml(seasonStateLabel(seasonState))} (${escapeHtml(seasonState)}).</span>`
  }</dd></div>`;
}
