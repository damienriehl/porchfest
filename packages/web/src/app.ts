import { getConnInfo } from "@hono/node-server/conninfo";
import type { CoreRuntime } from "@porchfest/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { RouteRegistry, type TrustAuthorizer } from "./router/registry.js";
import {
  ADMIN_SIGN_IN_PATH,
  announceBootstrapLink,
  registerAdminRoutes,
} from "./routes/admin.js";
import { registerAdminRecordRoutes } from "./routes/admin-records.js";
import { registerAdminRetentionRoutes } from "./routes/admin-retention.js";
import {
  registerSignupRoutes,
  type SignupRouteOptions,
} from "./routes/signup.js";
import { createTrustAuthorizer, type SessionCookieOptions } from "./auth.js";

export interface AppOptions {
  readonly core: CoreRuntime;
  readonly authorize?: TrustAuthorizer;
  readonly sessionCookie?: SessionCookieOptions;
  readonly csrfSecret?: string;
  readonly publicBaseUrl?: string | null;
  readonly resolveSocketPeerAddress?: SignupRouteOptions["resolveSocketPeerAddress"];
  readonly signupGuardOptions?: SignupRouteOptions["guardOptions"];
  readonly trustedProxyHops?: number;
  readonly onOrganizerActivity?: () => void;
}

export interface PorchfestApp {
  readonly fetch: Hono["fetch"];
  readonly request: Hono["request"];
  readonly routes: RouteRegistry;
}

export function createApp(options: AppOptions): PorchfestApp {
  const app = new Hono();
  const allowedOrigin = options.publicBaseUrl
    ? new URL(options.publicBaseUrl).origin
    : null;
  const csrfSecret = options.csrfSecret ?? "";
  const csrfTokenFor = (path: string) =>
    createHmac("sha256", csrfSecret)
      .update(`POST ${path}`, "utf8")
      .digest("base64url");
  // Without an explicit override the registry now gets real organizer auth
  // instead of the deny-everything default the scaffold shipped with.
  const authorize = options.authorize ?? createTrustAuthorizer(options.core);
  const routes = new RouteRegistry(
    app,
    authorize,
    {
      allowedOrigin,
      organizerSignInPath: ADMIN_SIGN_IN_PATH,
      validateCsrf: (token, route) => {
        if (!token || !csrfSecret) return false;
        const expected = Buffer.from(csrfTokenFor(route.path));
        const submitted = Buffer.from(token);
        return (
          expected.length === submitted.length &&
          timingSafeEqual(expected, submitted)
        );
      },
    },
    { onOrganizerActivity: options.onOrganizerActivity },
  );

  // The health endpoint is deliberately the first member of the canonical route
  // registry, so even the scaffold proves that reachability requires a trust tier.
  routes.register({
    method: "GET",
    path: "/health",
    tier: "public",
    handler: (context: Context) =>
      context.json({ ok: true, service: "porchfest" } as const),
  });

  registerSignupRoutes({
    core: options.core,
    routes,
    csrfTokenFor,
    resolveSocketPeerAddress:
      options.resolveSocketPeerAddress ?? defaultSocketPeerAddress,
    trustedProxyHops: options.trustedProxyHops,
    guardOptions: options.signupGuardOptions,
  });

  registerAdminRoutes({
    core: options.core,
    routes,
    csrfTokenFor,
    resolveSocketPeerAddress:
      options.resolveSocketPeerAddress ?? defaultSocketPeerAddress,
    cookie: options.sessionCookie,
  });

  registerAdminRetentionRoutes({ core: options.core, routes, csrfTokenFor });

  registerAdminRecordRoutes({ core: options.core, routes, csrfTokenFor });

  return {
    fetch: app.fetch.bind(app),
    request: app.request.bind(app),
    routes,
  };
}

function defaultSocketPeerAddress(context: Context): string | null {
  try {
    return getConnInfo(context).remote.address ?? null;
  } catch {
    return null;
  }
}
