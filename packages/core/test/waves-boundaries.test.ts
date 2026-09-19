import { describe, expect, it } from "vitest";
import { renderEml, renderWave, textToHtml } from "../src/waves.js";

describe("wave export boundaries", () => {
  it.each(["", " \n\t\n", "\n\n\n"])(
    "renders no HTML for empty content %j",
    (text) => {
      expect(textToHtml(text)).toBe("");
    },
  );

  it("flushes adjacent paragraph and list runs without requiring blank lines", () => {
    expect(
      textToHtml("Intro\nsecond line\n  - First\n- Second\nClosing\n- Last"),
    ).toBe(
      "<p>Intro<br />\nsecond line</p>\n<ul>\n<li>First</li>\n<li>Second</li>\n</ul>\n<p>Closing</p>\n<ul>\n<li>Last</li>\n</ul>",
    );
  });

  it("links multiple URLs while preserving punctuation and escaping query strings", () => {
    expect(
      textToHtml(
        "Visit https://a.invalid/?x=1&y=2), then http://b.invalid/path!",
      ),
    ).toBe(
      '<p>Visit <a href="https://a.invalid/?x=1&amp;y=2">https://a.invalid/?x=1&amp;y=2</a>), then <a href="http://b.invalid/path">http://b.invalid/path</a>!</p>',
    );
  });

  it("keeps participant placeholder-like text literal through template, HTML, and MIME rendering", () => {
    const rendered = renderWave("post_event", {
      event_name: "Festival",
      event_date_display: "Saturday",
      greeting_names: "<Guest>",
      participation_line: "You played.",
      followup_lines: "- Bring {{organizer_phone}} & tea",
      map_url: "https://map.invalid/",
      organizer_signature: "Crew",
    });
    expect(rendered.text).toContain("{{organizer_phone}}");
    const html = textToHtml(rendered.text);
    expect(html).toContain("Hi &lt;Guest&gt;,");
    const eml = renderEml({
      from: "crew@example.invalid",
      to: ["guest@example.invalid"],
      ...rendered,
      html,
    });
    const boundary = /boundary="([^"]+)"/.exec(eml)![1]!;
    const parts = eml.split(`--${boundary}`);
    function decode(part: string) {
      const body = part
        .slice(part.indexOf("\r\n\r\n") + 4)
        .replace(/\r\n$/, "")
        .replaceAll("=\r\n", "");
      const bytes: number[] = [];
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "=") {
          bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(body.charCodeAt(i));
      }
      return Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
    }
    expect(
      decode(parts.find((part) => part.includes("Content-Type: text/plain"))!),
    ).toBe(rendered.text);
    expect(
      decode(parts.find((part) => part.includes("Content-Type: text/html"))!),
    ).toBe(html);
    expect(eml).not.toContain("Date:");
    expect(eml).not.toContain("Message-ID:");
  });

  it("identifies a missing value in a later body placeholder before any export is produced", () => {
    expect(() =>
      renderWave("post_event", {
        event_name: "Festival",
        event_date_display: "Saturday",
        greeting_names: "Guest",
        participation_line: "Played",
        followup_lines: "Thanks",
        map_url: "https://map.invalid",
      }),
    ).toThrow(/organizer_signature has no value/);
  });
});
