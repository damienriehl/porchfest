import type { SeasonSignupUrls } from "../routes/signup-paths.js";
import { escapeHtml } from "./signup-view.js";

export function renderPublicSeasonLinks(
  signupUrls: SeasonSignupUrls | null,
  publicMapUrl: string | null,
): string {
  return `<section aria-labelledby="public-season-links">
      <h2 id="public-season-links">Share this season</h2>
      ${
        signupUrls
          ? `<dl class="submission-list">
        <div class="submission-row"><dt>Host signup</dt><dd><a href="${escapeHtml(signupUrls.host)}">${escapeHtml(signupUrls.host)}</a></dd></div>
        <div class="submission-row"><dt>Performer signup</dt><dd><a href="${escapeHtml(signupUrls.performer)}">${escapeHtml(signupUrls.performer)}</a></dd></div>
      </dl>`
          : '<p class="help">Shareable signup URLs are unavailable because PUBLIC_BASE_URL is not configured.</p>'
      }
      ${publicMapUrl ? `<p>Public map: <a href="${escapeHtml(publicMapUrl)}">${escapeHtml(publicMapUrl)}</a></p>` : '<p class="help">No public map URL is configured for this season.</p>'}
    </section>`;
}
