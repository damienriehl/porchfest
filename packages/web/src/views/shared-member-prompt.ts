import { escapeHtml } from "./signup-view.js";

export function renderParticipantSharedMemberPrompt(options: {
  readonly note: string | null;
  readonly linkHref: string;
}): string {
  const note = options.note?.trim();
  if (!note) return "";
  return `<aside class="confirmation-card" aria-label="Participant-reported shared member">
    <p><strong>Participant reported a shared member</strong></p>
    <p>${escapeHtml(note)}</p>
    <p><a href="${escapeHtml(options.linkHref)}">Review and link acts</a>. Free text is only a signal; the conflict check starts after an organizer records the link.</p>
  </aside>`;
}
