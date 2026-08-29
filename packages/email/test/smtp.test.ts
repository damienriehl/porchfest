import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NoneEmailAdapter } from "../src/none.js";
import {
  SmtpEmailAdapter,
  buildMimeMessage,
  encodeQuotedPrintable,
} from "../src/smtp.js";
import { emailPortContract } from "./contract.js";

const FROM = "Porchfest Organizers <organizers@porchfest.example.invalid>";
const RECIPIENTS = [
  "avery@porchfest.example.invalid",
  "blair@porchfest.example.invalid",
];
const FIXED_DATE = new Date(Date.UTC(2026, 8, 12, 15, 4, 5));
const FIXED_MESSAGE_ID = "u7b-fixed-id@porchfest.example.invalid";
const CLIENT_NAME = "porchfest-test.example.invalid";
const USERNAME = "outbox-sender";
const PASSWORD = "s3cret-smtp-passphrase";

// A body line that begins with a period is the whole point of dot-stuffing:
// without it the wire line is indistinguishable from the DATA terminator.
const MESSAGE = {
  recipients: RECIPIENTS,
  subject: "Porchfest 2026 — thank you for hosting",
  text: ". A line that begins with a period.\r\nThank you for hosting.",
  html: "<p>Thank you for hosting.</p>",
};

interface CatcherOptions {
  readonly rcptReply?: string;
  readonly answerData?: boolean;
  readonly dropAfter?: string;
  /** Empty advertises no AUTH mechanism at all. */
  readonly authAdvertisement?: string;
  /** Advertise STARTTLS and answer 220 - then never speak TLS. */
  readonly offerStarttls?: boolean;
}

interface Catcher {
  port: number;
  /** Every byte the client sent, before any parsing. */
  raw: string;
  commands: string[];
  rcptTo: string[];
  mailFrom: string | null;
  authPlain: string | null;
  authLoginUsername: string | null;
  authLoginPassword: string | null;
  payload: string | null;
}

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

/**
 * The minimum SMTP server dialogue the adapter is specified against, in
 * process, so the test observes the exact bytes a real server would receive.
 */
async function startCatcher(options: CatcherOptions = {}): Promise<Catcher> {
  const catcher: Catcher = {
    port: 0,
    raw: "",
    commands: [],
    rcptTo: [],
    mailFrom: null,
    authPlain: null,
    authLoginUsername: null,
    authLoginPassword: null,
    payload: null,
  };
  const rcptReply = options.rcptReply ?? "250 2.1.5 Ok";
  const answerData = options.answerData ?? true;
  const authAdvertisement = options.authAdvertisement ?? "AUTH PLAIN LOGIN";
  const offerStarttls = options.offerStarttls ?? false;

  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    let mode: "command" | "data" | "login-username" | "login-password" =
      "command";
    let dataLines: string[] = [];

    const handle = (line: string): void => {
      if (mode === "data") {
        if (line === ".") {
          catcher.payload = dataLines.join("\r\n");
          mode = "command";
          socket.write("250 2.0.0 Ok: queued as catcher-1\r\n");
          return;
        }
        // Reverse the transparency dot the client is required to add.
        dataLines.push(line.startsWith(".") ? line.slice(1) : line);
        return;
      }
      if (mode === "login-username") {
        catcher.authLoginUsername = Buffer.from(line, "base64").toString(
          "utf8",
        );
        mode = "login-password";
        socket.write("334 UGFzc3dvcmQ6\r\n");
        return;
      }
      if (mode === "login-password") {
        catcher.authLoginPassword = Buffer.from(line, "base64").toString(
          "utf8",
        );
        mode = "command";
        socket.write("235 2.7.0 Authentication successful\r\n");
        return;
      }

      catcher.commands.push(line);
      const verb = (line.split(" ")[0] ?? "").toUpperCase();
      if (options.dropAfter === verb) {
        socket.destroy();
        return;
      }
      if (verb === "EHLO") {
        const extensions = [
          ...(offerStarttls ? ["STARTTLS"] : []),
          ...(authAdvertisement.length > 0 ? [authAdvertisement] : []),
        ];
        socket.write(
          [
            "250-catcher.example.invalid",
            ...extensions.map((line) => `250-${line}`),
            "250 SIZE 10485760",
            "",
          ].join("\r\n"),
        );
        return;
      }
      if (verb === "STARTTLS") {
        // Agrees to upgrade and then says nothing: the client's handshake can
        // only time out, which is the case that used to crash the process.
        socket.write("220 2.0.0 Ready to start TLS\r\n");
        return;
      }
      if (verb === "AUTH") {
        const parts = line.split(" ");
        if ((parts[1] ?? "").toUpperCase() === "PLAIN") {
          catcher.authPlain = parts[2] ?? "";
          socket.write("235 2.7.0 Authentication successful\r\n");
          return;
        }
        mode = "login-username";
        socket.write("334 VXNlcm5hbWU6\r\n");
        return;
      }
      if (verb === "MAIL") {
        catcher.mailFrom = line.slice("MAIL FROM:".length);
        socket.write("250 2.1.0 Ok\r\n");
        return;
      }
      if (verb === "RCPT") {
        catcher.rcptTo.push(line.slice("RCPT TO:".length));
        socket.write(`${rcptReply}\r\n`);
        return;
      }
      if (verb === "DATA") {
        if (!answerData) return;
        mode = "data";
        dataLines = [];
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        return;
      }
      if (verb === "QUIT") {
        socket.write("221 2.0.0 Bye\r\n");
        socket.end();
        return;
      }
      socket.write("500 5.5.2 Unrecognized command\r\n");
    };

    socket.on("error", () => {
      // A client that gives up mid-dialogue is a case under test, not a fault.
    });
    socket.write("220 catcher.example.invalid ESMTP ready\r\n");
    socket.on("data", (chunk: Buffer) => {
      catcher.raw += chunk.toString("utf8");
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        index = buffer.indexOf("\r\n");
      }
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The catcher server did not bind a TCP port.");
  }
  catcher.port = address.port;
  return catcher;
}

/**
 * The catcher speaks cleartext, so the adapters these tests drive declare
 * exactly that: `starttls: false` with authentication explicitly permitted in
 * the clear. A deployment that leaves STARTTLS on - the default - gets the
 * enforcement exercised in its own tests below.
 */
function createAdapter(
  port: number,
  overrides: Partial<{
    username: string | undefined;
    password: string | undefined;
    timeoutMs: number;
    starttls: boolean;
    allowUnencryptedAuth: boolean;
  }> = {},
): SmtpEmailAdapter {
  return new SmtpEmailAdapter({
    host: "127.0.0.1",
    port,
    secure: false,
    starttls: overrides.starttls ?? false,
    allowUnencryptedAuth: overrides.allowUnencryptedAuth ?? true,
    username: "username" in overrides ? overrides.username : USERNAME,
    password: "password" in overrides ? overrides.password : PASSWORD,
    from: FROM,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    clientName: CLIENT_NAME,
    now: () => FIXED_DATE,
    createMessageId: () => FIXED_MESSAGE_ID,
  });
}

/** Deliberately independent of the implementation: RFC 2045 section 6.7. */
function decodeQuotedPrintable(encoded: string): string {
  const joined = encoded.replaceAll("=\r\n", "");
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index] ?? "";
    if (character === "=") {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (character === "\r") continue;
    if (character === "\n") {
      bytes.push(0x0a);
      continue;
    }
    bytes.push(character.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

describe("SmtpEmailAdapter", () => {
  it("reports sent with the generated Message-ID after a full dialogue", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port).deliver(MESSAGE);

    expect(result).toEqual({
      status: "sent",
      providerMessageId: `<${FIXED_MESSAGE_ID}>`,
    });
    expect(catcher.mailFrom).toBe("<organizers@porchfest.example.invalid>");
    expect(catcher.rcptTo).toEqual([
      "<avery@porchfest.example.invalid>",
      "<blair@porchfest.example.invalid>",
    ]);
    expect(catcher.commands).toContain(`EHLO ${CLIENT_NAME}`);
    expect(catcher.commands).toContain("QUIT");
  });

  it("transmits byte for byte what buildMimeMessage produced, dot-stuffed", async () => {
    const catcher = await startCatcher();
    await createAdapter(catcher.port).deliver(MESSAGE);

    const expected = buildMimeMessage({
      from: FROM,
      to: RECIPIENTS,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
      date: FIXED_DATE,
      messageId: FIXED_MESSAGE_ID,
    });

    // The server strips one leading dot per line; equality therefore proves the
    // client added one, and that nothing else on the wire drifted.
    expect(catcher.payload).toBe(expected);
    expect(expected).toContain("\r\n. A line that begins with a period.");
    expect(expected.split("\r\n")).toContain("MIME-Version: 1.0");
  });

  it("sends AUTH PLAIN credentials base64-encoded, never in the clear", async () => {
    const catcher = await startCatcher();
    await createAdapter(catcher.port).deliver(MESSAGE);

    expect(catcher.authPlain).toBe(
      Buffer.from(`\0${USERNAME}\0${PASSWORD}`, "utf8").toString("base64"),
    );
    // Every byte the client sent, not just the parsed command words: a leak
    // into a header, the body, or a stray line would be invisible otherwise.
    expect(catcher.raw).toContain(catcher.authPlain!);
    expect(catcher.raw).not.toContain(PASSWORD);
  });

  it("falls back to AUTH LOGIN when the server does not advertise PLAIN", async () => {
    const catcher = await startCatcher({ authAdvertisement: "AUTH LOGIN" });
    const result = await createAdapter(catcher.port).deliver(MESSAGE);

    expect(result.status).toBe("sent");
    expect(catcher.authPlain).toBeNull();
    expect(catcher.authLoginUsername).toBe(USERNAME);
    expect(catcher.authLoginPassword).toBe(PASSWORD);
  });

  it("skips authentication entirely when no credentials are configured", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port, {
      username: undefined,
      password: undefined,
    }).deliver(MESSAGE);

    expect(result.status).toBe("sent");
    expect(catcher.commands.some((line) => line.startsWith("AUTH"))).toBe(
      false,
    );
  });

  it("fails with the server code and sends no message when a recipient is rejected", async () => {
    const catcher = await startCatcher({
      rcptReply: "550 5.1.1 No such recipient here",
    });
    const result = await createAdapter(catcher.port).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("550");
    expect(catcher.payload).toBeNull();
    expect(catcher.commands.some((line) => line.startsWith("DATA"))).toBe(
      false,
    );
  });

  it("fails with a timeout reason when the server never answers DATA", async () => {
    const catcher = await startCatcher({ answerData: false });
    const result = await createAdapter(catcher.port, {
      timeoutMs: 150,
    }).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("timeout");
    expect(catcher.payload).toBeNull();
  });

  it("fails instead of throwing when the socket drops mid-dialogue", async () => {
    const catcher = await startCatcher({ dropAfter: "MAIL" });
    const result = await createAdapter(catcher.port).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
    expect(result.reason).not.toContain(PASSWORD);
  });

  it("fails when the provider refuses the connection outright", async () => {
    const catcher = await startCatcher();
    const port = catcher.port;
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );

    const result = await createAdapter(port, { timeoutMs: 500 }).deliver(
      MESSAGE,
    );
    expect(result.status).toBe("failed");
  });

  it("passes the shared email port contract alongside the null adapter", async () => {
    const catcher = await startCatcher();
    await emailPortContract(() => createAdapter(catcher.port), "sent");
    await emailPortContract(() => new NoneEmailAdapter(), "skipped");
  });
});

describe("SmtpEmailAdapter address handling", () => {
  it("refuses a recipient carrying a second address in angle brackets", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port).deliver({
      ...MESSAGE,
      // Passes the signup form's only email check, which allows one "@" and
      // no whitespace. The envelope must not be taken from the inner pair.
      recipients: ["a<b@evil.example.invalid>"],
    });

    expect(result.status).toBe("failed");
    expect(catcher.rcptTo).toEqual([]);
    expect(catcher.payload).toBeNull();
    expect(catcher.raw).not.toContain("evil.example.invalid");
  });

  it("refuses a recipient carrying CRLF before the socket is opened", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port).deliver({
      ...MESSAGE,
      recipients: [
        "victim@porchfest.example.invalid\r\nRCPT TO:<attacker@evil.example.invalid>",
      ],
    });

    expect(result.status).toBe("failed");
    expect(catcher.commands).toEqual([]);
    expect(catcher.raw).toBe("");
  });

  it("refuses to send at all when the configured from is not one address", async () => {
    const catcher = await startCatcher();
    const adapter = new SmtpEmailAdapter({
      host: "127.0.0.1",
      port: catcher.port,
      secure: false,
      starttls: false,
      // No angle pair to unwrap, so the whole string is the envelope address -
      // and it would end MAIL FROM early and start a command of its own.
      from: "organizers@porchfest.example.invalid, attacker@evil.example.invalid",
      timeoutMs: 2_000,
      clientName: CLIENT_NAME,
      now: () => FIXED_DATE,
      createMessageId: () => FIXED_MESSAGE_ID,
    });
    const result = await adapter.deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(catcher.mailFrom).toBeNull();
  });

  it("never lets a recipient become a header of its own", () => {
    const payload = buildMimeMessage({
      from: "Porchfest\r\nBcc: everyone@evil.example.invalid <a@b.invalid>",
      to: [
        "victim@porchfest.example.invalid\r\nBcc: attacker@evil.example.invalid",
      ],
      subject: "Subject",
      text: "Body",
      html: "<p>Body</p>",
      date: FIXED_DATE,
      messageId: FIXED_MESSAGE_ID,
    });

    const headers = payload.split(`${"\r\n"}${"\r\n"}`)[0]!.split("\r\n");
    expect(headers.some((line) => line.startsWith("Bcc:"))).toBe(false);
    expect(payload).not.toContain("\r\nBcc:");
  });
});

describe("SmtpEmailAdapter transport security", () => {
  it("fails rather than continuing in the clear when STARTTLS is not offered", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port, {
      starttls: true,
      allowUnencryptedAuth: true,
    }).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("STARTTLS");
    expect(catcher.authPlain).toBeNull();
    expect(catcher.payload).toBeNull();
    expect(catcher.raw).not.toContain(PASSWORD);
  });

  it("refuses to authenticate over a connection that was never encrypted", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port, {
      starttls: false,
      allowUnencryptedAuth: false,
    }).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("unencrypted");
    expect(catcher.authPlain).toBeNull();
    expect(catcher.authLoginUsername).toBeNull();
    expect(catcher.payload).toBeNull();
  });

  it("still sends unauthenticated over a cleartext relay it was told to use", async () => {
    const catcher = await startCatcher();
    const result = await createAdapter(catcher.port, {
      starttls: false,
      allowUnencryptedAuth: false,
      username: undefined,
      password: undefined,
    }).deliver(MESSAGE);

    expect(result.status).toBe("sent");
    expect(catcher.commands.some((line) => line.startsWith("AUTH"))).toBe(
      false,
    );
  });

  it("fails instead of guessing when no AUTH mechanism is advertised", async () => {
    const catcher = await startCatcher({ authAdvertisement: "" });
    const result = await createAdapter(catcher.port).deliver(MESSAGE);

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("AUTH");
    expect(catcher.authPlain).toBeNull();
    expect(catcher.raw).not.toContain(PASSWORD);
  });

  it("survives a STARTTLS upgrade that never completes", async () => {
    const uncaught: unknown[] = [];
    const capture = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", capture);
    try {
      const catcher = await startCatcher({ offerStarttls: true });
      const result = await createAdapter(catcher.port, {
        starttls: true,
        timeoutMs: 200,
      }).deliver(MESSAGE);

      expect(result.status).toBe("failed");
      expect(catcher.payload).toBeNull();
      // The TLS socket outlives the failed handshake; give its error a chance
      // to land before deciding nothing went unhandled.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", capture);
    }
  });
});

describe("quoted-printable encoding", () => {
  it("round-trips a UTF-8 body with long lines within the 76-column limit", () => {
    const body = [
      `Grüße from the porch — ${"a really rather long stretch of prose ".repeat(6)}`,
      "Ünïcödé: 🎸🎺 straße naïve café",
      "trailing whitespace here   ",
      ". a leading period",
    ].join("\n");

    const encoded = encodeQuotedPrintable(body);

    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(encoded).not.toContain("ü");
    expect(decodeQuotedPrintable(encoded)).toBe(body);
  });

  it("keeps a trailing space from being lost at end of line", () => {
    const encoded = encodeQuotedPrintable("value ");
    expect(encoded).toBe("value=20");
  });
});
