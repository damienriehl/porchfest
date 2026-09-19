import { describe, expect, it } from "vitest";
import { SmtpEmailAdapter, buildMimeMessage } from "../src/smtp.js";

const options = {
  host: "smtp.example.invalid",
  port: 587,
  secure: false,
  starttls: true,
  from: "sender@example.invalid",
};
const message = {
  recipients: ["recipient@example.invalid"],
  subject: "Subject",
  text: "text",
  html: "<p>text</p>",
};

describe("SMTP preflight without opening sockets", () => {
  it.each([0, -1, 65536, 1.5, NaN, Infinity])(
    "rejects invalid port %s",
    (port) => {
      expect(() => new SmtpEmailAdapter({ ...options, port })).toThrow(
        RangeError,
      );
    },
  );
  it.each([0, -1, NaN, Infinity])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => new SmtpEmailAdapter({ ...options, timeoutMs })).toThrow(
      RangeError,
    );
  });
  it.each(["host", "from"] as const)("rejects blank %s", (field) => {
    expect(() => new SmtpEmailAdapter({ ...options, [field]: " \t" })).toThrow(
      TypeError,
    );
  });
  it("requires both halves of authentication configuration", () => {
    expect(
      () => new SmtpEmailAdapter({ ...options, username: "user" }),
    ).toThrow(/both/);
    expect(
      () => new SmtpEmailAdapter({ ...options, password: "synthetic" }),
    ).toThrow(/both/);
    const adapter = new SmtpEmailAdapter({
      ...options,
      host: " smtp.example.invalid ",
      username: "user",
      password: "synthetic",
    });
    expect(adapter.endpoint).toBe("smtp.example.invalid:587");
    expect(adapter.authenticated).toBe(true);
    expect(new SmtpEmailAdapter(options).authenticated).toBe(false);
  });
  it.each([{ recipients: [] }, { recipients: ["", " \t"] }])(
    "rejects empty recipients %j before creating MIME or transport",
    async ({ recipients }) => {
      const adapter = new SmtpEmailAdapter({
        ...options,
        createMessageId: () => {
          throw new Error("MIME must not be built");
        },
      });
      expect(await adapter.deliver({ ...message, recipients })).toEqual({
        status: "failed",
        reason: "No recipient address was supplied.",
      });
    },
  );
  it.each([
    "missing-at",
    "@domain.invalid",
    "local@",
    "a@b@c",
    "a b@example.invalid",
    "é@example.invalid",
    "a\0b@example.invalid",
    `${"a".repeat(255)}@example.invalid`,
  ])(
    "rejects invalid envelope recipient %j before MIME construction",
    async (recipient) => {
      const adapter = new SmtpEmailAdapter({
        ...options,
        createMessageId: () => {
          throw new Error("MIME must not be built");
        },
      });
      expect(
        await adapter.deliver({
          ...message,
          recipients: ["valid@example.invalid", recipient],
        }),
      ).toEqual({
        status: "failed",
        reason:
          "A recipient address is not a single plain email address; correct it before sending.",
      });
    },
  );
});

describe("MIME serialization integrates shared header and body encoders", () => {
  it("round-trips Unicode multipart bodies and encoded subjects using an independent decoder", () => {
    const text = "Hello 🎸\ntrailing \t\n=done";
    const html = "<p>Grüße 🎸</p>";
    const subject = "Concert 🎸";
    const input = {
      from: options.from,
      to: message.recipients,
      subject,
      text,
      html,
      date: new Date("2026-09-19T00:00:00Z"),
      messageId: "  fixture@example.invalid  ",
    };
    const payload = buildMimeMessage(input);
    const headers = payload.split("\r\n\r\n")[0]!;
    const boundary = /boundary="([^"]+)"/.exec(headers)![1]!;
    expect(headers).toContain("Message-ID: <fixture@example.invalid>");
    expect(headers).toContain("Date: Sat, 19 Sep 2026 00:00:00 +0000");
    const encodedSubject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/i.exec(
      headers,
    )![1]!;
    expect(Buffer.from(encodedSubject, "base64").toString("utf8")).toBe(
      subject,
    );
    const parts = payload.split(`--${boundary}`);
    expect(parts).toHaveLength(4);
    const decode = (part: string) => {
      const body = part
        .slice(part.indexOf("\r\n\r\n") + 4)
        .replace(/\r\n$/, "")
        .replace(/=\r\n/g, "");
      const bytes: number[] = [];
      for (let i = 0; i < body.length; i++) {
        if (body[i] === "=") {
          bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(body.charCodeAt(i));
      }
      return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
    };
    expect(decode(parts[1]!)).toBe(text);
    expect(decode(parts[2]!)).toBe(html);
    expect(parts[3]).toBe("--");
    expect(
      buildMimeMessage({ ...input, messageId: "<fixture@example.invalid>" }),
    ).toBe(payload);
  });
});
