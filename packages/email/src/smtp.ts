import { createHash, randomUUID } from "node:crypto";
import { connect as connectPlain, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as connectSecure, type TLSSocket } from "node:tls";
import {
  CRLF,
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatRfc5322Date,
  isPrintableAscii,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailPort,
} from "@porchfest/core";

export { encodeQuotedPrintable };

export const DEFAULT_SMTP_TIMEOUT_MS = 20_000;

const NUL = String.fromCharCode(0);

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
  /**
   * Upgrade after EHLO. The provider must advertise STARTTLS; one that does
   * not is a failure, not a quiet fallback to cleartext.
   */
  readonly starttls: boolean;
  /**
   * Permit AUTH on a connection that is neither implicit TLS nor upgraded.
   * Off by default - base64 is not encryption, and an on-path attacker who
   * strips the STARTTLS advertisement would otherwise be handed the password.
   * Only a deployment that has deliberately pointed the platform at a
   * plaintext relay it trusts should turn this on.
   */
  readonly allowUnencryptedAuth?: boolean;
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
  readonly #allowUnencryptedAuth: boolean;
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
    this.#allowUnencryptedAuth = options.allowUnencryptedAuth ?? false;
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
    // Every address is checked before the socket exists, so a value that would
    // have injected an SMTP command or rerouted the envelope never reaches the
    // wire at all. The reasons name the field, never the offending bytes: they
    // are recorded against the recipient row, which already holds its address,
    // and echoing a CRLF-bearing string is how a log line becomes forgeable.
    const envelopeFrom = envelopeAddress(this.#from);
    if (!isPlainAddress(envelopeFrom)) {
      return {
        status: "failed",
        reason:
          "The configured SMTP from address is not a single plain email address.",
      };
    }
    if (!recipients.every(isPlainAddress)) {
      return {
        status: "failed",
        reason:
          "A recipient address is not a single plain email address; correct it before sending.",
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

      let encrypted = this.#secure;
      if (this.#starttls && !this.#secure) {
        // An on-path attacker only has to delete one line from the EHLO reply
        // to keep the session in cleartext. Treating a missing advertisement
        // as "no TLS today" is what makes that free, so it fails instead.
        if (!advertises(greeting, "STARTTLS")) {
          throw new SmtpFailure(
            "The SMTP provider did not offer STARTTLS; refusing to continue in the clear.",
          );
        }
        requireCode(await session.command("STARTTLS"), 220);
        await session.upgrade(this.#host);
        greeting = requireCode(
          await session.command(`EHLO ${this.#clientName}`),
          250,
        );
        encrypted = true;
      }

      if (this.#username !== undefined && this.#password !== undefined) {
        // KTD15: base64 is not encryption. AUTH on a connection that is
        // neither implicit TLS nor upgraded hands the password to anyone on
        // the path, so it takes a deliberate deployment opt-in.
        if (!encrypted && !this.#allowUnencryptedAuth) {
          throw new SmtpFailure(
            "Refusing to send SMTP credentials over an unencrypted connection.",
          );
        }
        await authenticate(session, greeting, this.#username, this.#password);
      }

      requireCode(await session.command(`MAIL FROM:<${envelopeFrom}>`), 250);
      for (const recipient of recipients) {
        const reply = await session.command(`RCPT TO:<${recipient}>`);
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
    // Every header value goes through the RFC 2047 encoder, not just the
    // subject: a CR or LF anywhere in a name or an address would otherwise
    // start a header of the sender's choosing - a Bcc, most usefully.
    `From: ${encodeHeaderValue(input.from)}`,
    `To: ${input.to.map((address) => encodeHeaderValue(address)).join(", ")}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${formatRfc5322Date(input.date)}`,
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

/**
 * The address inside a configured `Name <addr>` value.
 *
 * Only ever applied to the deployment's own `from`: taking the last angle pair
 * out of a *recipient* would let `a<b@evil.invalid>` - a string the signup
 * form's one-@-no-whitespace check accepts - reroute the envelope while the
 * outbox recorded the address it thought it sent to.
 */
function envelopeAddress(value: string): string {
  const trimmed = value.trim();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  if (open !== -1 && close > open) return trimmed.slice(open + 1, close).trim();
  return trimmed;
}

/**
 * A single plain addr-spec, safe to place between the angle brackets of a
 * MAIL FROM or RCPT TO without ending the command.
 *
 * Rejects CR, LF, NUL and every other control character (SMTP command
 * injection), angle brackets (a second address hiding inside the first),
 * whitespace and the RFC 5322 specials that only appear in a display name.
 */
function isPlainAddress(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  // Printable US-ASCII only: that rules out CR, LF, NUL and every other
  // control character in one check, and this adapter never negotiates
  // SMTPUTF8, so a non-ASCII envelope address could not be delivered anyway.
  if (!isPrintableAscii(value)) return false;
  if (/[\s<>,;:"\\()[\]]/.test(value)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
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

  // Chosen from what the server said it supports. Falling through to AUTH
  // PLAIN when nothing was advertised sent the credentials to a server that
  // never claimed to want them.
  if (mechanisms.includes("PLAIN")) {
    const token = base64(`${NUL}${username}${NUL}${password}`);
    requireCode(await session.command(`AUTH PLAIN ${token}`), 235);
    return;
  }
  if (mechanisms.includes("LOGIN")) {
    requireCode(await session.command("AUTH LOGIN"), 334);
    requireCode(await session.command(base64(username)), 334);
    requireCode(await session.command(base64(password)), 235);
    return;
  }
  throw new SmtpFailure(
    "The SMTP provider advertised no AUTH mechanism this adapter supports.",
  );
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
    // Attached before the await, and the socket adopted before it too.
    // `waitForEvent` removes its own error listener when it settles, so a
    // handshake that fails after that - a rejected certificate, or an RST once
    // the plain socket is torn down underneath - would emit `error` on a socket
    // with no listener, which Node escalates into an uncaught exception that
    // takes the whole web process with it. `open` already guards this shape.
    const guard = (error: Error) => this.#abort(error);
    secure.on("error", guard);
    this.#socket = secure;
    try {
      await waitForEvent(secure, "secureConnect", this.#timeoutMs);
    } catch (error) {
      secure.destroy();
      throw error;
    }
    secure.removeListener("error", guard);
    // Anything buffered before the upgrade belongs to the cleartext session and
    // must never be trusted as part of the protected conversation.
    this.#buffer = "";
    this.#failure = null;
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
