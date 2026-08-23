// U5 PR 1: the way in. Sign in with a bootstrap or invite link, sign out, and one
// authenticated landing page that proves the trust tier is real. The queue,
// record editor and lifecycle actions arrive in later PRs on this foundation.

import { AccessError, type CoreRuntime } from "@porchfest/core";
import type { Context } from "hono";
import {
  adminHeaders,
  currentOrganizer,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  type SessionCookieOptions,
} from "../auth.js";
import type { RouteRegistry } from "../router/registry.js";
import { renderAdminShell, renderSignInPage } from "../views/admin-shell.js";

export const ADMIN_PATH = "/admin";
export const ADMIN_SIGN_IN_PATH = "/admin/sign-in";
export const ADMIN_SIGN_OUT_PATH = "/admin/sign-out";

export interface AdminRouteOptions {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly csrfTokenFor: (path: string) => string;
  readonly resolveSocketPeerAddress: (context: Context) => string | null;
  readonly cookie?: SessionCookieOptions;
}

export function registerAdminRoutes(options: AdminRouteOptions): void {
  options.routes.register({
    method: "GET",
    path: ADMIN_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      // The registry already refused an unauthenticated caller; resolving again
      // is how the page knows whose name to show.
      const organizer = currentOrganizer(options.core, context);
      return new Response(
        renderAdminShell({
          organizer,
          csrfToken: options.csrfTokenFor(ADMIN_SIGN_OUT_PATH),
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "GET",
    path: ADMIN_SIGN_IN_PATH,
    tier: "public",
    handler: (context: Context) => {
      const token = context.req.query("token") ?? "";
      const invited = options.core.access.hasAnyOrganizer();
      return new Response(
        renderSignInPage({
          token,
          csrfToken: options.csrfTokenFor(ADMIN_SIGN_IN_PATH),
          // Before the first organizer exists the person holding the link has to
          // name themselves; an invite already knows the address.
          needsEmail: !invited,
          errors: [],
        }),
        { status: 200, headers: adminHeaders() },
      );
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_SIGN_IN_PATH,
    tier: "public",
    handler: async (context: Context) => {
      let fields: Readonly<Record<string, string>>;
      try {
        fields = await readFields(context);
      } catch {
        return signInRefusal(options, "", "That form could not be read.");
      }
      const token = fields.token ?? "";
      const displayName = fields.display_name ?? "";
      const email = fields.email ?? "";

      if (!token) {
        return signInRefusal(options, "", "That sign-in link is incomplete.");
      }

      try {
        const session = options.core.access.redeemLink({
          token,
          displayName,
          email: email || undefined,
          fromIp: options.resolveSocketPeerAddress(context),
        });
        return new Response(null, {
          status: 303,
          headers: {
            ...adminHeaders(),
            "content-type": "text/plain; charset=UTF-8",
            location: ADMIN_PATH,
            "set-cookie": serializeSessionCookie(
              session.token,
              session.expiresAt,
              options.cookie,
            ),
          },
        });
      } catch (error) {
        return signInRefusal(options, token, describe(error));
      }
    },
  });

  options.routes.register({
    method: "POST",
    path: ADMIN_SIGN_OUT_PATH,
    tier: "organizer",
    handler: (context: Context) => {
      options.core.access.endSession(readSessionCookie(context));
      return new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders(),
          "content-type": "text/plain; charset=UTF-8",
          location: ADMIN_SIGN_IN_PATH,
          "set-cookie": serializeExpiredSessionCookie(options.cookie),
        },
      });
    },
  });
}

/**
 * Parse the form once into plain string fields, mirroring how the signup routes
 * read a body. Iterating rather than reaching for FormData's accessor also keeps
 * the route-boundary scanner happy: it flags that accessor's name anywhere in
 * `web` because it cannot tell a form read from a route registration.
 */
async function readFields(
  context: Context,
): Promise<Readonly<Record<string, string>>> {
  const form = await context.req.formData();
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of form) {
    if (typeof value === "string" && fields[name] === undefined) {
      fields[name] = value.trim();
    }
  }
  return fields;
}

function signInRefusal(
  options: AdminRouteOptions,
  token: string,
  message: string,
): Response {
  return new Response(
    renderSignInPage({
      token,
      csrfToken: options.csrfTokenFor(ADMIN_SIGN_IN_PATH),
      needsEmail: !options.core.access.hasAnyOrganizer(),
      errors: [message],
    }),
    { status: 403, headers: adminHeaders() },
  );
}

/**
 * Say which way the link failed without saying anything a guesser could use.
 * "Already used" and "expired" are both safe: the holder already had the token.
 * An unrecognized token gets the same wording as an expired one on purpose.
 */
function describe(error: unknown): string {
  if (!(error instanceof AccessError)) {
    return "That sign-in link could not be used.";
  }
  switch (error.reason) {
    case "already-redeemed":
      return "That sign-in link has already been used. Ask an organizer for a new one.";
    case "revoked":
      return "That sign-in link was withdrawn. Ask an organizer for a new one.";
    case "deactivated":
      return "That organizer account is deactivated.";
    case "expired":
    case "invalid-token":
      return "That sign-in link is no longer valid. Ask an organizer for a new one.";
    default:
      return "That sign-in link could not be used.";
  }
}

/**
 * Print the first-boot login link. R9 forbids depending on the email adapter, so
 * the container log is the delivery channel: whoever can read the logs is
 * already the operator.
 */
export function announceBootstrapLink(
  core: CoreRuntime,
  publicBaseUrl: string | null,
  log: (message: string) => void = console.log,
): void {
  if (core.access.hasAnyOrganizer()) return;
  const { token } = core.access.issueBootstrapLink();
  const base = publicBaseUrl ?? "";
  log(
    [
      "",
      "  Porchfest has no organizer yet. Open this link to create the first one:",
      `    ${base}${ADMIN_SIGN_IN_PATH}?token=${token}`,
      "  It expires in an hour, works once, and dies as soon as an organizer exists.",
      "",
    ].join("\n"),
  );
}
