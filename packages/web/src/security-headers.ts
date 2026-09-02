import type { AntibotClientChallenge } from "@porchfest/core";

/**
 * Self-only, widened by exactly what the configured challenge asks for and
 * nothing else. The adapter names its own origins, so web stays provider-agnostic.
 */
export function contentSecurityPolicy(
  challenge: AntibotClientChallenge | null,
): string {
  const join = (extra: readonly string[]): string =>
    ["'self'", ...extra].join(" ");
  const csp = challenge?.contentSecurityPolicy;
  return [
    `default-src 'self'`,
    `script-src ${join(csp?.scriptSrc ?? [])}`,
    `frame-src ${join(csp?.frameSrc ?? [])}`,
    `connect-src ${join(csp?.connectSrc ?? [])}`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join("; ");
}
