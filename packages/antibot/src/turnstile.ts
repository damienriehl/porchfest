import { createHash, randomUUID } from "node:crypto";
import type {
  AntibotClientChallenge,
  AntibotPort,
  AntibotRequest,
  AntibotResult,
} from "@porchfest/core";

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
export const DEFAULT_TURNSTILE_TIMEOUT_MS = 5_000;
export const DEFAULT_TURNSTILE_REPLAY_TTL_MS = 5 * 60_000;

export interface SingleUseTokenStore {
  claim(tokenHash: string, expiresAt: number): Promise<boolean>;
}

export class InMemorySingleUseTokenStore implements SingleUseTokenStore {
  readonly #claims = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async claim(tokenHash: string, expiresAt: number): Promise<boolean> {
    const now = this.#now();
    for (const [storedHash, storedExpiry] of this.#claims) {
      if (storedExpiry <= now) this.#claims.delete(storedHash);
    }

    if ((this.#claims.get(tokenHash) ?? 0) > now) return false;
    this.#claims.set(tokenHash, expiresAt);
    return true;
  }
}

export interface TurnstileAntibotAdapterOptions {
  readonly secretKey: string;
  /**
   * The public site key. It is rendered into the page by design; the secret key
   * never is. Required, because a Turnstile widget cannot mount without it and a
   * deployment that configured only the secret would render an unusable form.
   */
  readonly siteKey: string;
  readonly timeoutMs?: number;
  readonly replayTtlMs?: number;
  readonly replayStore?: SingleUseTokenStore;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly createId?: () => string;
}

type SiteverifyOutcome =
  | { readonly kind: "response"; readonly body: unknown }
  | { readonly kind: "http-error" }
  | { readonly kind: "malformed" }
  | { readonly kind: "timeout" };

export class TurnstileAntibotAdapter implements AntibotPort {
  readonly name = "turnstile";
  readonly configured = true;
  readonly clientChallenge: AntibotClientChallenge;
  readonly #secretKey: string;
  readonly #timeoutMs: number;
  readonly #replayTtlMs: number;
  readonly #replayStore: SingleUseTokenStore;
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(options: TurnstileAntibotAdapterOptions) {
    if (options.secretKey.trim().length === 0) {
      throw new TypeError("Turnstile secretKey must not be empty.");
    }
    if (options.siteKey.trim().length === 0) {
      throw new TypeError("Turnstile siteKey must not be empty.");
    }

    this.#secretKey = options.secretKey;
    this.clientChallenge = Object.freeze({
      scriptUrl: TURNSTILE_SCRIPT_URL,
      mountTag: "div",
      mountAttributes: Object.freeze({
        class: "cf-turnstile",
        "data-sitekey": options.siteKey.trim(),
        "data-response-field-name": "antibot_token",
      }),
      responseFieldName: "antibot_token",
      label: "Verification",
      contentSecurityPolicy: Object.freeze({
        scriptSrc: Object.freeze([TURNSTILE_ORIGIN]),
        frameSrc: Object.freeze([TURNSTILE_ORIGIN]),
        connectSrc: Object.freeze([TURNSTILE_ORIGIN]),
      }),
    }) as AntibotClientChallenge;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TURNSTILE_TIMEOUT_MS;
    this.#replayTtlMs = options.replayTtlMs ?? DEFAULT_TURNSTILE_REPLAY_TTL_MS;
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#replayStore =
      options.replayStore ?? new InMemorySingleUseTokenStore(this.#now);
    this.#createId = options.createId ?? randomUUID;

    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("Turnstile timeoutMs must be a positive number.");
    }
    if (!Number.isFinite(this.#replayTtlMs) || this.#replayTtlMs <= 0) {
      throw new RangeError("Turnstile replayTtlMs must be a positive number.");
    }
  }

  async verify(request: AntibotRequest): Promise<AntibotResult> {
    if (request.token === null || request.token.trim().length === 0) {
      return {
        status: "failed",
        reason: "A Turnstile challenge token is required.",
      };
    }

    const tokenHash = createHash("sha256")
      .update(request.token, "utf8")
      .digest("hex");
    const claimed = await this.#replayStore.claim(
      tokenHash,
      this.#now() + this.#replayTtlMs,
    );
    if (!claimed) {
      return {
        status: "failed",
        reason: "This Turnstile challenge token has already been used.",
      };
    }

    const form = new URLSearchParams({
      secret: this.#secretKey,
      response: request.token,
      remoteip: request.ipAddress,
      idempotency_key: this.#createId(),
    });
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const operation = this.#requestSiteverify(form, abortController.signal);
    const timeout = new Promise<SiteverifyOutcome>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({ kind: "timeout" });
        abortController.abort();
      }, this.#timeoutMs);
    });

    let outcome: SiteverifyOutcome;
    try {
      outcome = await Promise.race([operation, timeout]);
    } catch {
      return {
        status: "unavailable",
        reason: "Turnstile verification could not be reached.",
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    if (outcome.kind === "timeout") {
      return {
        status: "unavailable",
        reason: "Turnstile verification timed out.",
      };
    }
    if (outcome.kind === "http-error") {
      return {
        status: "unavailable",
        reason: "Turnstile verification returned a non-success response.",
      };
    }
    if (outcome.kind === "malformed") {
      return {
        status: "unavailable",
        reason: "Turnstile verification returned a malformed response.",
      };
    }

    return parseSiteverifyBody(outcome.body);
  }

  async #requestSiteverify(
    form: URLSearchParams,
    signal: AbortSignal,
  ): Promise<SiteverifyOutcome> {
    const response = await this.#fetcher(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal,
    });
    if (!response.ok) return { kind: "http-error" };

    try {
      return { kind: "response", body: await response.json() };
    } catch {
      return { kind: "malformed" };
    }
  }
}

function parseSiteverifyBody(body: unknown): AntibotResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      status: "unavailable",
      reason: "Turnstile verification returned a malformed response.",
    };
  }

  const success = Reflect.get(body, "success");
  const errorCodes = Reflect.get(body, "error-codes");
  if (
    typeof success !== "boolean" ||
    (errorCodes !== undefined &&
      (!Array.isArray(errorCodes) ||
        !errorCodes.every((code) => typeof code === "string")))
  ) {
    return {
      status: "unavailable",
      reason: "Turnstile verification returned a malformed response.",
    };
  }

  if (success) return { status: "passed" };

  const details =
    errorCodes === undefined || errorCodes.length === 0
      ? ""
      : `: ${errorCodes.join(", ")}`;
  return {
    status: "failed",
    reason: `Turnstile rejected the challenge${details}.`,
  };
}
