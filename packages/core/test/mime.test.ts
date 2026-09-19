import { describe, expect, it } from "vitest";
import {
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatRfc5322Date,
  isPrintableAscii,
} from "../src/mime.js";
import { renderEml, textToHtml } from "../src/waves.js";

// A decoder deliberately independent of the encoder: remove transport wrapping,
// then decode bytes, rather than comparing one production helper to another.
function decodeQuotedPrintable(encoded: string): string {
  const bytes: number[] = [];
  const joined = encoded.replace(/=\r\n/g, "");
  for (let index = 0; index < joined.length; index += 1) {
    if (joined[index] === "=") {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(joined.charCodeAt(index));
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeWords(value: string): string[] {
  return value.split("\r\n ").map((word) => {
    expect(word.length).toBeLessThanOrEqual(75);
    expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    return Buffer.from(word.slice(10, -2), "base64").toString("utf8");
  });
}

describe("MIME encoding transport boundaries", () => {
  it.each([
    "",
    "plain ASCII !~",
    "a=b\u0000\u007f",
    "café 🎺\t",
    "one\rtwo\nthree\r\nfour",
    "trailing \t \nlast\t",
    "x".repeat(74) + " ",
    "x".repeat(75) + "é",
    "é🎺".repeat(80),
  ])("round trips quoted-printable bytes for %j", (text) => {
    const encoded = encodeQuotedPrintable(text);
    expect(decodeQuotedPrintable(encoded)).toBe(
      text.replace(/\r\n|\r|\n/g, "\r\n"),
    );
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
      expect(line).not.toMatch(/[ \t]$/);
      expect(line).not.toMatch(/=[A-F0-9]$/u);
    }
  });

  it("wraps an encoded trailing space onto a separate transport line at the limit", () => {
    expect(encodeQuotedPrintable("x".repeat(74) + " ")).toBe(
      "x".repeat(74) + "=\r\n=20",
    );
    expect(encodeQuotedPrintable("x".repeat(74) + "\t")).toBe(
      "x".repeat(74) + "=\r\n=09",
    );
  });

  it.each(["", "Printable ~ ASCII", "x".repeat(100)])(
    "leaves printable header text unchanged (%j)",
    (text) => {
      expect(isPrintableAscii(text)).toBe(true);
      expect(encodeHeaderValue(text)).toBe(text);
    },
  );

  it.each([
    "é".repeat(50),
    "🎺".repeat(50),
    "a".repeat(44) + "é",
    "a".repeat(43) + "🎺",
    "a\r\nBcc: injected@example.invalid",
    "\t",
    "\u007f",
  ])("encodes complete Unicode characters and control bytes (%j)", (text) => {
    expect(isPrintableAscii(text)).toBe(false);
    const decoded = decodeWords(encodeHeaderValue(text));
    expect(decoded.join("")).toBe(text);
    expect(decoded.join("")).not.toContain("\ufffd");
  });

  it("formats UTC dates independently of the input offset and pads every clock field", () => {
    expect(formatRfc5322Date(new Date("2024-02-29T23:04:05-06:00"))).toBe(
      "Fri, 01 Mar 2024 05:04:05 +0000",
    );
    expect(formatRfc5322Date(new Date("2023-12-31T23:59:59Z"))).toBe(
      "Sun, 31 Dec 2023 23:59:59 +0000",
    );
  });

  it("renders a complete multipart message whose two encoded bodies decode to their source", () => {
    const text = "A café concert 🎺\nBring a chair. " + "é".repeat(80);
    const html = textToHtml(text);
    const subject = "🎺".repeat(40);
    const eml = renderEml({
      from: "sender@example.invalid",
      to: ["one@example.invalid", "two@example.invalid"],
      subject,
      text,
      html,
      date: new Date("2024-02-29T00:00:00Z"),
      messageId: "fixture@example.invalid",
    });
    const boundary = /boundary="([^"]+)"/.exec(eml)?.[1];
    expect(boundary).toBeDefined();
    const [headers, plainPart, htmlPart, closing] = eml.split(`--${boundary}`);
    expect(headers).toContain("Date: Thu, 29 Feb 2024 00:00:00 +0000\r\n");
    expect(headers).toContain("Message-ID: <fixture@example.invalid>\r\n");
    expect(headers).toContain(
      "To: one@example.invalid, two@example.invalid\r\n",
    );
    const encodedSubject = headers!
      .split("Subject: ")[1]!
      .split("\r\nDate:")[0]!;
    expect(decodeWords(encodedSubject).join("")).toBe(subject);
    expect(
      decodeQuotedPrintable(plainPart!.split("\r\n\r\n")[1]!.slice(0, -2)),
    ).toBe(text.replace(/\n/g, "\r\n"));
    expect(
      decodeQuotedPrintable(htmlPart!.split("\r\n\r\n")[1]!.slice(0, -2)),
    ).toBe(html.replace(/\n/g, "\r\n"));
    expect(closing).toBe("--\r\n");
    expect(eml).not.toMatch(/(?<!\r)\n/);
  });
});
