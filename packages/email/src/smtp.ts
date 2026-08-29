import { createHash, randomUUID } from "node:crypto";
import { connect as connectPlain, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as connectSecure, type TLSSocket } from "node:tls";
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
} from "@porchfest/core";

export const DEFAULT_SMTP_TIMEOUT_MS = 20_000;

const CRLF = "\r\n";
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const MAX_QP_LINE_LENGTH = 76;
/** =?UTF-8?B?…?= must stay inside 75 characters; 45 bytes of base64 fits. */
const MAX_ENCODED_WORD_BYTES = 45;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export interface MimeMessageInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly date: Date;
  readonly messageId: string;
}

export interface SmtpEmailAdapterOptions {
  readonly host: string;
  readonly port: number;
  /** Implicit TLS: wrap the socket in TLS before the greeting (port 465). */
  readonly secure: boolean;
  /** Opportunistic upgrade after EHLO when the server advertises STARTTLS. */
  readonly starttls: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly from: string;
  readonly timeoutMs?: number;
  readonly clientName?: string;
  readonly now?: () => Date;
  readonly createMessageId?: () => string;
}

/**
 * KTD4: SMTP is the first real provider, spoken directly over a socket so the
 * platform gains no dependency for it.
 *
 * The adapter is deliberately stateless about delivery: it never stamps a send,
 * never retries, and never throws. It reports one outcome per call and the
 * outbox (KTD6) owns what that means for a recipient — a thrown error would
 * lose the distinction between "the server refused" and "we never asked".
 */
export class SmtpEmailAdapter implements EmailPort {
  readonly name = "smtp";
  readonly configured = true;
  /** host:port, for operator-facing "what is configured" output. No secrets. */
  readonly endpoint: string;
  /** Whether credentials were supplied. Never the credentials themselves. */
  readonly authenticated: boolean;
  readonly #host: string;
  readonly #port: number;
  readonly #secure: boolean;
  readonly #starttls: boolean;
  readonly #username: string | undefined;
  readonly #password: string | undefined;
  readonly #from: string;
  readonly #timeoutMs: number;
  readonly #clientName: string;
  readonly #now: () => Date;
  readonly #createMessageId: () => string;

  constructor(options: SmtpEmailAdapterOptions) {
    const host = options.host.trim();
    const from = options.from.trim();
    if (host.length === 0) {
      throw new TypeError("SMTP host must not be empty.");
    }
    if (from.length === 0) {
      throw new TypeError("SMTP from must not be empty.");
    }
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535
    ) {
      throw new RangeError("SMTP port must be a TCP port number.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("SMTP timeoutMs must be a positive number.");
    }
    // Half-credentials authenticate as nobody; refuse at construction rather
    // than send unauthenticated mail a deployment believed was authenticated.
    if ((options.username === undefined) !== (options.password === undefined)) {
      throw new TypeError(
        "SMTP credentials need both a username and a password, or neither.",
      );
    }

    this.endpoint = `${host}:${options.port}`;
    this.authenticated = options.username !== undefined;
    this.#host = host;
    this.#port = options.port;
    this.#secure = options.secure;
    this.#starttls = options.starttls;
    this.#username = options.username;
    this.#password = options.password;
    this.#from = from;
    this.#timeoutMs = timeoutMs;
    this.#clientName = options.clientName?.trim() || hostname();
    this.#now = options.now ?? (() => new Date());
    this.#createMessageId =
      options.createMessageId ??
      (() => `${randomUUID()}@${addressDomain(from)}`);
  }

  async deliver(message: EmailMessage): Promise<EmailDeliveryResult> {
    const recipients = message.recipients
      .map((recipient) => recipient.trim())
      .filter((recipient) => recipient.length > 0);
    if (recipients.length === 0) {
      return {
        status: "failed",
        reason: "No recipient address was supplied.",
      };
    }

    const messageId = normalizeMessageId(this.#createMessageId());
    // KTD5: the payload is built once, before the socket exists, so what the
    // outbox stored is what goes on the wire — nothing is re-derived mid-send.
    const payload = buildMimeMessage({
      from: this.#from,
      to: recipients,
      subject: message.subject,
      text: message.text,
      html: message.html,
      date: this.#now(),
      messageId,
    });

    let session: SmtpSession | null = null;
    try {
      session = await SmtpSession.open({
        host: this.#host,
        port: this.#port,
        secure: this.#secure,
        timeoutMs: this.#timeoutMs,
      });

      requireCode(await session.read(), 220);
      let greeting = requireCode(
        await session.command(`EHLO ${this.#clientName}`),
        250,
      );

      if (this.#starttls && !this.#secure && advertises(greeting, "STARTTLS")) {
        requireCode(await session.command("STARTTLS"), 220);
        await session.upgrade(this.#host);
        greeting = requireCode(
          await session.command(`EHLO ${this.#clientName}`),
          250,
        );
      }

      if (this.#username !== undefined && this.#password !== undefined) {
        await authenticate(session, greeting, this.#username, this.#password);
      }

      requireCode(
        await session.command(`MAIL FROM:<${envelopeAddress(this.#from)}>`),
        250,
      );
      for (const recipient of recipients) {
        const reply = await session.command(
          `RCPT TO:<${envelopeAddress(recipient)}>`,
        );
        // A rejected recipient aborts before DATA: half-delivering a wave is
        // worse than delivering none, because the outbox would record a send.
        if (reply.code !== 250 && reply.code !== 251) throw failureFor(reply);
      }

      requireCode(await session.command("DATA"), 354);
      session.write(`${stuffLeadingDots(payload)}${CRLF}.${CRLF}`);
      requireCode(await session.read(), 250);

      try {
        await session.command("QUIT");
      } catch {
        // The server already accepted the message; a rude close after that is
        // not a delivery failure and must not be reported as one.
      }
      return { status: "sent", providerMessageId: messageId };
    } catch (error) {
      // KTD15: reasons carry the server's words, never the password or body.
      return { status: "failed", reason: describeFailure(error) };
    } finally {
      session?.destroy();
    }
  }
}

/** Deterministic from its inputs: same message, same bytes, every time. */
export function buildMimeMessage(input: MimeMessageInput): string {
  const messageId = normalizeMessageId(input.messageId);
  const boundary = deriveBoundary(messageId);
  return [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.html),
    `--${boundary}--`,
  ].join(CRLF);
}

/** RFC 2045 section 6.7. Lines stay within 76 characters including the "=". */
export function encodeQuotedPrintable(input: string): string {
  const normalized = input.split(CRLF).join("\n").split("\r").join("\n");
  const bytes = Buffer.from(normalized, "utf8");
  const lines: string[] = [];
  let line = "";

  for (const byte of bytes) {
    if (byte === 0x0a) {
      lines.push(...closeLine(line));
      line = "";
      continue;
    }
    const token = encodeByte(byte);
    if (line.length + token.length > MAX_QP_LINE_LENGTH - 1) {
      lines.push(`${line}=`);
      line = "";
    }
    line += token;
  }
  lines.push(...closeLine(line));
  return lines.join(CRLF);
}

function encodeByte(byte: number): string {
  if (byte === 0x3d) return "=3D";
  if (byte === 0x09 || byte === 0x20) return String.fromCharCode(byte);
  if (byte >= 0x21 && byte <= 0x7e) return String.fromCharCode(byte);
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Whitespace at end of line is stripped by many relays, which would silently
 * change the body. Encode the last one so the run survives transport.
 */
function closeLine(line: string): string[] {
  const last = line.slice(-1);
  if (last !== " " && last !== TAB) return [line];
  const encoded = last === " " ? "=20" : "=09";
  const head = line.slice(0, -1);
  if (head.length + encoded.length <= MAX_QP_LINE_LENGTH) {
    return [`${head}${encoded}`];
  }
  return [`${head}=`, encoded];
}

function encodeHeaderValue(value: string): string {
  if (isPrintableAscii(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + MAX_ENCODED_WORD_BYTES, bytes.length);
    // Never split a UTF-8 sequence across two encoded words.
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${bytes.subarray(start, end).toString("base64")}?=`);
    start = end;
  }
  return words.join(`${CRLF} `);
}

function isPrintableAscii(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "Sun";
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${weekday}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} +0000`;
}

function normalizeMessageId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

/** Derived from the Message-ID so the whole payload stays a pure function. */
function deriveBoundary(messageId: string): string {
  const digest = createHash("sha256").update(messageId, "utf8").digest("hex");
  return `=_porchfest_${digest.slice(0, 32)}`;
}

function addressDomain(from: string): string {
  const address = envelopeAddress(from);
  const at = address.lastIndexOf("@");
  return at === -1 ? "porchfest.invalid" : address.slice(at + 1);
}

function envelopeAddress(value: string): string {
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  if (open !== -1 && close > open) return trimmed.slice(open + 1, close).trim();
  return trimmed;
}

/** RFC 5321 transparency: a body line starting with "." gets a second one. */
function stuffLeadingDots(payload: string): string {
  return payload
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

class SmtpFailure extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "SmtpFailure";
    this.reason = reason;
  }
}

function failureFor(reply: SmtpReply): SmtpFailure {
  if (reply.code === 0) {
    return new SmtpFailure("The SMTP provider sent a malformed reply.");
  }
  return new SmtpFailure(`${reply.code} ${reply.lines.join(" ")}`.trim());
}

function requireCode(reply: SmtpReply, code: number): SmtpReply {
  if (reply.code !== code) throw failureFor(reply);
  return reply;
}

function advertises(greeting: SmtpReply, keyword: string): boolean {
  return greeting.lines.some(
    (line) => (line.split(" ")[0] ?? "").toUpperCase() === keyword,
  );
}

async function authenticate(
  session: SmtpSession,
  greeting: SmtpReply,
  username: string,
  password: string,
): Promise<void> {
  const mechanisms = greeting.lines
    .filter((line) => line.toUpperCase().startsWith("AUTH"))
    .flatMap((line) =>
      line
        .split(" ")
        .slice(1)
        .map((mechanism) => mechanism.toUpperCase()),
    );

  if (!mechanisms.includes("PLAIN") && mechanisms.includes("LOGIN")) {
    requireCode(await session.command("AUTH LOGIN"), 334);
    requireCode(await session.command(base64(username)), 334);
    requireCode(await session.command(base64(password)), 235);
    return;
  }

  const token = base64(`${NUL}${username}${NUL}${password}`);
  requireCode(await session.command(`AUTH PLAIN ${token}`), 235);
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function describeFailure(error: unknown): string {
  if (error instanceof SmtpFailure) return error.reason;
  if (error instanceof Error) return error.message.slice(0, 200);
  return "The SMTP provider could not be reached.";
}

/**
 * One SMTP conversation. Every read is bounded by the adapter timeout, because
 * a provider that accepts the connection and then stops answering would
 * otherwise hold an outbox send open forever.
 */
class SmtpSession {
  #socket: Socket;
  #buffer = "";
  #failure: Error | null = null;
  #waiter: {
    readonly resolve: (reply: SmtpReply) => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  readonly #timeoutMs: number;

  private constructor(socket: Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    this.#listen(socket);
  }

  static async open(options: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly timeoutMs: number;
  }): Promise<SmtpSession> {
    const socket: Socket = options.secure
      ? connectSecure({
          host: options.host,
          port: options.port,
          servername: options.host,
        })
      : connectPlain({ host: options.host, port: options.port });

    try {
      await waitForEvent(
        socket,
        options.secure ? "secureConnect" : "connect",
        options.timeoutMs,
      );
    } catch (error) {
      socket.on("error", () => {
        // The connection already failed; later noise must stay unhandled-safe.
      });
      socket.destroy();
      throw error;
    }
    return new SmtpSession(socket, options.timeoutMs);
  }

  read(): Promise<SmtpReply> {
    return new Promise<SmtpReply>((resolve, reject) => {
      const buffered = takeReply(this.#buffer);
      if (buffered !== null) {
        this.#buffer = buffered.rest;
        resolve(buffered.reply);
        return;
      }
      if (this.#failure !== null) {
        reject(this.#failure);
        return;
      }
      const timer = setTimeout(() => {
        this.#waiter = null;
        reject(new SmtpFailure("timeout"));
      }, this.#timeoutMs);
      timer.unref();
      this.#waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  write(payload: string): void {
    if (this.#failure !== null) throw this.#failure;
    this.#socket.write(payload, "utf8");
  }

  async command(line: string): Promise<SmtpReply> {
    this.write(`${line}${CRLF}`);
    return this.read();
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.#socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    const secure: TLSSocket = connectSecure({
      socket: plain,
      servername: host,
    });
    await waitForEvent(secure, "secureConnect", this.#timeoutMs);
    // Anything buffered before the upgrade belongs to the cleartext session and
    // must never be trusted as part of the protected conversation.
    this.#buffer = "";
    this.#failure = null;
    this.#socket = secure;
    this.#listen(secure);
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #listen(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.#buffer += chunk.toString("utf8");
      this.#deliverBuffered();
    });
    socket.on("error", (error: Error) => {
      this.#abort(error);
    });
    socket.on("close", () => {
      this.#abort(new SmtpFailure("The SMTP connection closed unexpectedly."));
    });
  }

  #deliverBuffered(): void {
    if (this.#waiter === null) return;
    const buffered = takeReply(this.#buffer);
    if (buffered === null) return;
    this.#buffer = buffered.rest;
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter.resolve(buffered.reply);
  }

  #abort(error: Error): void {
    this.#failure = error;
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(error);
  }
}

function waitForEvent(
  socket: Socket,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      socket.removeListener(event, onReady);
      socket.removeListener("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onReady = () => settle();
    const onError = (error: Error) => settle(error);
    const timer = setTimeout(
      () => settle(new SmtpFailure("timeout")),
      timeoutMs,
    );
    timer.unref();
    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

/** Multi-line replies continue while the fourth character is a hyphen. */
function takeReply(
  buffer: string,
): { readonly reply: SmtpReply; readonly rest: string } | null {
  const lines: string[] = [];
  let index = 0;
  for (;;) {
    const end = buffer.indexOf(CRLF, index);
    if (end === -1) return null;
    const line = buffer.slice(index, end);
    index = end + CRLF.length;
    lines.push(line);
    if (line.length < 4 || line.charAt(3) !== "-") break;
  }
  const last = lines[lines.length - 1] ?? "";
  const parsed = Number.parseInt(last.slice(0, 3), 10);
  return {
    reply: {
      code: Number.isNaN(parsed) ? 0 : parsed,
      lines: lines.map((line) => line.slice(4)),
    },
    rest: buffer.slice(index),
  };
}
