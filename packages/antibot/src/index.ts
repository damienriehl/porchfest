export type {
  AntibotClientChallenge,
  AntibotPort,
  AntibotRequest,
  AntibotResult,
} from "@porchfest/core";
export {
  DEFAULT_RATE_LIMIT,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  PerIpRateLimiter,
  UnconfiguredAntibotGuard,
  UNKNOWN_CLIENT_IP,
  resolveClientIp,
  type ClientIpSource,
  type PerIpRateLimiterOptions,
  type RateLimitDecision,
  type UnconfiguredAntibotGuardOptions,
  type UnconfiguredAntibotRequest,
  type UnconfiguredAntibotResult,
} from "./ratelimit.js";
export {
  DEFAULT_TURNSTILE_REPLAY_TTL_MS,
  DEFAULT_TURNSTILE_TIMEOUT_MS,
  InMemorySingleUseTokenStore,
  TURNSTILE_ORIGIN,
  TURNSTILE_SCRIPT_URL,
  TURNSTILE_SITEVERIFY_URL,
  TurnstileAntibotAdapter,
  type SingleUseTokenStore,
  type TurnstileAntibotAdapterOptions,
} from "./turnstile.js";

import type { AntibotPort, AntibotRequest } from "@porchfest/core";

export class NullAntibotAdapter implements AntibotPort {
  readonly name = "none";
  readonly configured = false;
  // Nothing for the browser to complete: this adapter's protection is the
  // server-side honeypot and per-IP cap.
  readonly clientChallenge = null;

  async verify(_request: AntibotRequest) {
    return {
      status: "not-configured" as const,
      reason: "No external challenge provider is configured.",
    };
  }
}
