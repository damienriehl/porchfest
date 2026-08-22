export const DEFAULT_RATE_LIMIT = 5;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const UNKNOWN_CLIENT_IP = "unknown";

export interface ClientIpSource {
  readonly socketPeerAddress: string | null | undefined;
  readonly forwardedFor?: string | readonly string[] | null;
  readonly trustedProxyHops?: number;
}

export function resolveClientIp({
  socketPeerAddress,
  forwardedFor,
  trustedProxyHops,
}: ClientIpSource): string {
  assertTrustedProxyHops(trustedProxyHops);

  const peerAddress = socketPeerAddress?.trim() || UNKNOWN_CLIENT_IP;
  if (
    peerAddress === UNKNOWN_CLIENT_IP ||
    trustedProxyHops === undefined ||
    trustedProxyHops === 0
  ) {
    return peerAddress;
  }

  const forwardedAddresses = parseForwardedFor(forwardedFor);
  if (forwardedAddresses.length < trustedProxyHops) {
    return peerAddress;
  }

  return (
    forwardedAddresses[forwardedAddresses.length - trustedProxyHops] ??
    peerAddress
  );
}

function parseForwardedFor(
  forwardedFor: string | readonly string[] | null | undefined,
): string[] {
  const values =
    typeof forwardedFor === "string" ? [forwardedFor] : (forwardedFor ?? []);

  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function assertTrustedProxyHops(trustedProxyHops: number | undefined): void {
  if (
    trustedProxyHops !== undefined &&
    (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0)
  ) {
    throw new RangeError("trustedProxyHops must be a non-negative integer.");
  }
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly remaining: number;
      readonly retryAfterMs: 0;
    }
  | {
      readonly allowed: false;
      readonly remaining: 0;
      readonly retryAfterMs: number;
    };

export interface PerIpRateLimiterOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export class PerIpRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #attempts = new Map<string, number[]>();

  constructor(options: PerIpRateLimiterOptions = {}) {
    this.#limit = options.limit ?? DEFAULT_RATE_LIMIT;
    this.#windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.#now = options.now ?? Date.now;

    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new RangeError("limit must be a positive integer.");
    }
    if (!Number.isFinite(this.#windowMs) || this.#windowMs <= 0) {
      throw new RangeError("windowMs must be a positive number.");
    }
  }

  consume(ipAddress: string): RateLimitDecision {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    const attempts = (this.#attempts.get(ipAddress) ?? []).filter(
      (attemptedAt) => attemptedAt > cutoff,
    );

    if (attempts.length >= this.#limit) {
      this.#attempts.set(ipAddress, attempts);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, (attempts[0] ?? now) + this.#windowMs - now),
      };
    }

    attempts.push(now);
    this.#attempts.set(ipAddress, attempts);
    return {
      allowed: true,
      remaining: this.#limit - attempts.length,
      retryAfterMs: 0,
    };
  }
}

export interface UnconfiguredAntibotRequest {
  readonly socketPeerAddress: string | null | undefined;
  readonly forwardedFor?: string | readonly string[] | null;
  readonly honeypot?: string | null;
}

export type UnconfiguredAntibotResult =
  | {
      readonly status: "passed";
      readonly ipAddress: string;
      readonly remaining: number;
      readonly retryAfterMs: 0;
    }
  | {
      readonly status: "failed";
      readonly code: "honeypot" | "rate-limited";
      readonly reason: string;
      readonly ipAddress: string;
      readonly remaining: number;
      readonly retryAfterMs: number;
    };

export interface UnconfiguredAntibotGuardOptions extends PerIpRateLimiterOptions {
  readonly trustedProxyHops?: number;
}

export class UnconfiguredAntibotGuard {
  readonly #trustedProxyHops: number | undefined;
  readonly #rateLimiter: PerIpRateLimiter;

  constructor(options: UnconfiguredAntibotGuardOptions = {}) {
    assertTrustedProxyHops(options.trustedProxyHops);
    this.#trustedProxyHops = options.trustedProxyHops;
    this.#rateLimiter = new PerIpRateLimiter(options);
  }

  check(request: UnconfiguredAntibotRequest): UnconfiguredAntibotResult {
    const ipAddress = resolveClientIp({
      socketPeerAddress: request.socketPeerAddress,
      forwardedFor: request.forwardedFor,
      trustedProxyHops: this.#trustedProxyHops,
    });
    const rateLimit = this.#rateLimiter.consume(ipAddress);

    if (!rateLimit.allowed) {
      return {
        status: "failed",
        code: "rate-limited",
        reason: "Too many submissions were received from this address.",
        ipAddress,
        remaining: rateLimit.remaining,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }

    if ((request.honeypot ?? "").trim().length > 0) {
      return {
        status: "failed",
        code: "honeypot",
        reason: "The anti-bot honeypot field was filled.",
        ipAddress,
        remaining: rateLimit.remaining,
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }

    return {
      status: "passed",
      ipAddress,
      remaining: rateLimit.remaining,
      retryAfterMs: rateLimit.retryAfterMs,
    };
  }
}
