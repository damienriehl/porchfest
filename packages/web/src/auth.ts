// The web half of R9. Core owns who an organizer is and whether a credential is
// still good; this file owns only the cookie that carries it and the trust
// decision the route registry asks for.

import type { CoreRuntime, Organizer } from "@porchfest/core";
import type { Context } from "hono";
import type { TrustTier } from "./router/registry.js";

export const SESSION_COOKIE = "porchfest_session";

export interface SessionCookieOptions {
  /**
   * KTD14 requires `Secure`. It is configurable only so a test harness driving
   * plain HTTP can exercise the flow; a deployment must never turn it off, and
   * nothing reads this from the environment.
   */
  readonly secure?: boolean;
}

/**
 * KTD14: `Secure; HttpOnly; SameSite=Lax`. SameSite is not the CSRF boundary
 * here — the marketing site and the app are same-site — so the registry's exact
 * `Origin` check and CSRF token carry that, and this cookie only has to stay out
 * of JavaScript and off plain HTTP.
 */
export function serializeSessionCookie(
  token: string,
  expiresAt: Date,
  options: SessionCookieOptions = {},
): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (options.secure ?? true) parts.splice(2, 0, "Secure");
  return parts.join("; ");
}

export function serializeExpiredSessionCookie(
  options: SessionCookieOptions = {},
): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (options.secure ?? true) parts.splice(2, 0, "Secure");
  return parts.join("; ");
}

export function readSessionCookie(context: Context): string | null {
  const header = context.req.header("cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function currentOrganizer(
  core: CoreRuntime,
  context: Context,
): Organizer | null {
  return core.access.resolveSession(readSessionCookie(context));
}

/**
 * The registry fails closed on any tier it cannot satisfy, so this only has to
 * answer for the tiers it understands. `participant` belongs to U8 and is
 * deliberately still refused here rather than quietly granted.
 */
export function createTrustAuthorizer(core: CoreRuntime) {
  return (tier: TrustTier, context: Context): boolean => {
    if (tier === "organizer") return currentOrganizer(core, context) !== null;
    return false;
  };
}

/** KTD8: admin responses echo the contact database and must never be cached. */
export function adminHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    "cache-control": "no-store, private",
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "content-type": "text/html; charset=UTF-8",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}
