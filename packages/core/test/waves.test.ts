import { describe, expect, it } from "vitest";
import {
  renderEml,
  renderWave,
  textToHtml,
  waveTemplateKeys,
  waveTemplates,
  WaveTemplateError,
  type RenderContext,
  type WaveTemplateKey,
} from "../src/waves.js";

const fullContext: RenderContext = {
  event_name: "Maple Ward Porchfest",
  event_date_display: "Saturday, September 12, 2105",
  event_time_display: "6:00–8:00 PM",
  map_url: "https://porchfest.example.invalid/map",
  organizer_signature: "The Maple Ward Porchfest crew",
  organizer_name: "Robin Organizer",
  organizer_phone: "555-0100",
  address_display: "100 Maple Street",
  space_line: "Front porch with a wide step",
  electrical_line: "Yes",
  rain_line: "The host has a covered backup space.",
  notes_block: "NOTES FROM YOUR HOST\nPark on the north side.",
  status_note: "We are still looking for a match.",
  status_lines: "- You told us you prefer a shaded porch.",
  host_first_name: "Wren",
  performer_greeting_names: "Ash",
  greeting_names: "Wren and Ash",
  participation_line: "Your porch was one of the stages that made it happen.",
  band_name: "The Synthetic Notes",
  slot_lines: "- 6:00–7:00 PM — The Synthetic Notes",
  slot_summary: "6:00–7:00 PM",
  contact_lines: "- Wren Host — wren@example.invalid",
  logistics_lines: "- Host provides: PA, microphone",
  asks_lines: "- Reply-all to confirm.",
  followup_lines: "- Tell us how it went.",
};

describe("wave templates", () => {
  it("renders every wave with no placeholder left behind", () => {
    for (const key of waveTemplateKeys) {
      const rendered = renderWave(key, fullContext);
      expect(rendered.subject, key).not.toContain("{{");
      expect(rendered.text, key).not.toContain("{{");
      expect(rendered.subject.length, key).toBeGreaterThan(0);
      expect(rendered.text, key).toContain("Maple Ward Porchfest");
      expect(rendered.text.startsWith("Subject:"), key).toBe(false);
    }
  });

  it("carries the ported Goal-1 wording and the neighborhood-neutral name", () => {
    const match = renderWave("match", fullContext);
    expect(match.subject).toBe(
      "Maple Ward Porchfest Saturday, September 12, 2105: 100 Maple Street — you're matched!",
    );
    expect(match.text).toContain("Hi Wren and Ash,");
    expect(match.text).toContain(
      "THE MATCH\n- 6:00–7:00 PM — The Synthetic Notes",
    );
    expect(match.text).toContain("- Power: Yes");
    expect(match.text).toContain(
      "The event map at https://porchfest.example.invalid/map will show every porch",
    );
    expect(match.text.endsWith("The Maple Ward Porchfest crew")).toBe(true);
    for (const key of waveTemplateKeys) {
      expect(waveTemplates[key], key).not.toContain("SAP Porchfest");
    }
    expect(renderWave("day_of", fullContext).text).toContain(
      "text Robin Organizer at 555-0100",
    );
    expect(renderWave("post_event", fullContext).subject).toBe(
      "Thank you for being part of Maple Ward Porchfest — Saturday, September 12, 2105",
    );
    expect(renderWave("post_event", fullContext).text).toContain(
      "- Tell us how it went.",
    );
    expect(renderWave("floating_performer", fullContext).subject).toContain(
      "The Synthetic Notes",
    );
    expect(renderWave("thank_you_venue", fullContext).text).toContain(
      "We are still looking for a match.",
    );
  });

  it("throws rather than rendering an unknown or missing placeholder", () => {
    const missing = { ...fullContext };
    delete (missing as Record<string, string | undefined>).address_display;
    expect(() => renderWave("match", missing)).toThrow(WaveTemplateError);
    expect(() => renderWave("match", missing)).toThrow(/address_display/);
    expect(() =>
      renderWave("unknown_wave" as WaveTemplateKey, fullContext),
    ).toThrow(WaveTemplateError);
  });

  it("is deterministic and collapses the gap an empty block leaves", () => {
    const first = renderWave("match", fullContext);
    const second = renderWave("match", { ...fullContext });
    expect(second).toEqual(first);

    const withoutNotes = renderWave("match", {
      ...fullContext,
      notes_block: "",
    });
    expect(withoutNotes.text).not.toMatch(/\n{3}/);
    expect(withoutNotes.text).toContain("PLEASE DO THIS");
  });
});

describe("textToHtml", () => {
  it("escapes markup, builds paragraphs, lists, and links", () => {
    const html = textToHtml(
      [
        "Hi <script>alert('x')</script> & friends,",
        "",
        "- First ask",
        "- Second ask",
        "",
        "The map is at https://porchfest.example.invalid/map today.",
      ].join("\n"),
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; friends");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>First ask</li>");
    expect(html).toContain("<li>Second ask</li>");
    expect(html).toContain(
      '<a href="https://porchfest.example.invalid/map">https://porchfest.example.invalid/map</a>',
    );
    expect(html.match(/<p>/g)?.length).toBe(2);
  });

  it("keeps a single-quote and an ampersand out of attribute position", () => {
    expect(textToHtml("Bread & Butter's porch")).toContain(
      "Bread &amp; Butter&#39;s porch",
    );
  });
});

function decodeQuotedPrintable(encoded: string): string {
  const unfolded = encoded.replaceAll("=\r\n", "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const character = unfolded[index]!;
    if (character === "=") {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(character.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

describe("renderEml", () => {
  const text = [
    "Hi Wren and Ash,",
    "",
    "Your slot is 6:00–7:00 PM — bring a long extension cord = the outlet is far away, and the porch is a very long way from the driveway which makes this line longer than seventy-six characters.",
  ].join("\n");
  const eml = renderEml({
    from: "organizers@example.invalid",
    to: ["wren@example.invalid", "ash@example.invalid"],
    subject: "Maple Ward Porchfest: 100 Maple Street — you're matched!",
    text,
    html: textToHtml(text),
    date: new Date("2105-09-05T12:00:00.000Z"),
    messageId: "outbox-1@porchfest.example.invalid",
  });

  it("writes CRLF headers, a multipart/alternative body, and 7-bit bytes", () => {
    const lines = eml.split("\r\n");
    expect(eml).not.toMatch(/(?<!\r)\n/);
    expect(lines).toContain("From: organizers@example.invalid");
    expect(lines).toContain("To: wren@example.invalid, ash@example.invalid");
    expect(lines.some((line) => line.startsWith("MIME-Version: 1.0"))).toBe(
      true,
    );
    expect(
      lines.some((line) =>
        line.startsWith("Content-Type: multipart/alternative; boundary="),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.startsWith("Content-Type: text/plain")),
    ).toBe(true);
    expect(
      lines.some((line) => line.startsWith("Content-Type: text/html")),
    ).toBe(true);
    expect(
      lines.every((line) => line.length <= 998),
      "no line may exceed the RFC 5322 limit",
    ).toBe(true);
    for (const codePoint of eml) {
      expect(codePoint.codePointAt(0)!).toBeLessThan(128);
    }
  });

  it("round-trips the plain-text part through quoted-printable", () => {
    const boundary = /boundary="([^"]+)"/.exec(eml)?.[1];
    expect(boundary).toBeTruthy();
    const parts = eml.split(`--${boundary}`);
    const plainPart = parts.find((part) =>
      part.includes("Content-Type: text/plain"),
    );
    expect(plainPart).toBeTruthy();
    const body = plainPart!.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    expect(decodeQuotedPrintable(body).replaceAll("\r\n", "\n").trim()).toBe(
      text,
    );
    expect(body).not.toMatch(/[^\r\n]{77,}/);
  });

  it("encodes a non-ASCII subject rather than emitting raw bytes", () => {
    const subjectLine = eml
      .split("\r\n")
      .find((line) => line.startsWith("Subject: "));
    expect(subjectLine).toBeTruthy();
    expect(subjectLine).toContain("=?UTF-8?");
    expect(subjectLine).not.toContain("—");
  });

  it("keeps every encoded word a whole number of characters", () => {
    // Long enough that the header folds, with a multi-byte character sitting
    // exactly where a fixed 45-byte cut would land mid-sequence.
    const subject = "Porchfest thank you for hosting on Maple  🎸 café";
    const folded = renderEml({
      from: "Maple Ward Porchfest ☕ <organizers@example.invalid>",
      to: ["wren@example.invalid"],
      subject,
      text: "Body",
      html: "<p>Body</p>",
    });
    // Unfold: RFC 5322 continuation lines begin with whitespace.
    const lines = folded.split("\r\n");
    const start = lines.findIndex((line) => line.startsWith("Subject: "));
    expect(start).toBeGreaterThanOrEqual(0);
    let header = lines[start]!;
    for (
      let index = start + 1;
      index < lines.length && /^[ \t]/.test(lines[index]!);
      index += 1
    ) {
      header += lines[index]!;
    }
    const words = [...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(
      (match) => match[1]!,
    );

    expect(words.length).toBeGreaterThan(1);
    // RFC 2047 section 5: each encoded word must decode on its own. A reader
    // that decodes word by word - which is what mail clients do - must not see
    // a replacement character where a UTF-8 sequence was cut in half.
    for (const word of words) {
      expect(Buffer.from(word, "base64").toString("utf8")).not.toContain("�");
    }
    expect(
      words
        .map((word) => Buffer.from(word, "base64").toString("utf8"))
        .join(""),
    ).toBe(subject);
  });
});
