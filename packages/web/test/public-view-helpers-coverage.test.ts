import { describe, expect, it } from "vitest";
import { seasonSignupUrls } from "../src/routes/signup-paths.js";
import { renderPublicSeasonLinks } from "../src/views/public-season-links.js";
import { seasonStateLabel } from "../src/views/season-labels.js";
import { renderParticipantSharedMemberPrompt } from "../src/views/shared-member-prompt.js";
import { renderOrganizerPage } from "../src/views/signup-view.js";

describe("public season links and lifecycle labels", () => {
  it("integrates URL construction, signup legality, and public view rendering", () => {
    const urls = seasonSignupUrls(
      "https://festival.example.invalid/nested/path?old=yes#fragment",
      42,
    );
    expect(urls).toEqual({
      host: "https://festival.example.invalid/signup/host?season=42",
      performer: "https://festival.example.invalid/signup/performer?season=42",
    });
    const html = renderPublicSeasonLinks(
      urls,
      "https://map.example.invalid/?season=42&view=all",
      "signups_open",
    );
    expect(html).toContain(
      'href="https://festival.example.invalid/signup/host?season=42"',
    );
    expect(html).toContain(
      'href="https://festival.example.invalid/signup/performer?season=42"',
    );
    expect(html).toContain(
      'href="https://map.example.invalid/?season=42&amp;view=all"',
    );
    expect(html).not.toContain("Inactive");
  });
  it.each([
    ["setup", "Preparing the season"],
    ["signups_closed", "Signups closed"],
    ["locked", "Schedule confirmed"],
    ["archived", "Season closed and archived"],
  ] as const)(
    "shows inactive text and the human label for %s",
    (state, label) => {
      const urls = seasonSignupUrls("https://festival.example.invalid", 9)!;
      const html = renderPublicSeasonLinks(urls, null, state);
      expect(seasonStateLabel(state)).toBe(label);
      expect(html).toContain(`Inactive — ${label} (${state}).`);
      expect(html).toContain(urls.host);
      expect(html).not.toContain(
        'href="https://festival.example.invalid/signup/',
      );
      expect(html).toContain("No public map URL is configured");
    },
  );
  it("keeps late signup links available while the schedule is being assigned", () => {
    const urls = seasonSignupUrls("https://festival.example.invalid", 9)!;
    expect(seasonStateLabel("assigning")).toBe("Building the schedule");
    expect(renderPublicSeasonLinks(urls, null, "assigning")).toContain(
      `href="${urls.host}"`,
    );
  });
  it("explains both missing destinations without generating invalid anchors", () => {
    expect(seasonSignupUrls(null, 9)).toBeNull();
    const html = renderPublicSeasonLinks(null, null, "signups_open");
    expect(html).toContain("PUBLIC_BASE_URL is not configured");
    expect(html).toContain("No public map URL is configured");
    expect(html).not.toContain("<a ");
    expect(seasonStateLabel("signups_open")).toBe("Accepting signups");
  });
  it("rejects a malformed public base rather than inventing links", () => {
    expect(() => seasonSignupUrls("not a URL", 1)).toThrow(TypeError);
  });
  it("escapes caller supplied link attributes and visible link text", () => {
    const html = renderPublicSeasonLinks(
      {
        host: 'https://example.invalid/?x="<host>',
        performer: 'https://example.invalid/?x="<performer>',
      },
      'https://example.invalid/?x="<map>',
      "signups_open",
    );
    expect(html).toContain("&quot;&lt;host&gt;");
    expect(html).toContain("&quot;&lt;performer&gt;");
    expect(html).toContain("&quot;&lt;map&gt;");
    expect(html).not.toContain("<host>");
  });
});

describe("participant shared-member prompts", () => {
  it.each([null, "", " \n\t "])("omits an empty note %s", (note) => {
    expect(
      renderParticipantSharedMemberPrompt({ note, linkHref: "/admin/assign" }),
    ).toBe("");
  });
  it("integrates the prompt into a real organizer page and escapes participant text", () => {
    const prompt = renderParticipantSharedMemberPrompt({
      note: '  We share <drums> & "vocals"  ',
      linkHref: "/admin/assign?act=1&season=2",
    });
    const html = renderOrganizerPage("Shared members", prompt);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(
      "<p>We share &lt;drums&gt; &amp; &quot;vocals&quot;</p>",
    );
    expect(html).toContain('href="/admin/assign?act=1&amp;season=2"');
    expect(html).toContain(
      "conflict check starts after an organizer records the link",
    );
    expect(html).not.toContain("<drums>");
  });
});
