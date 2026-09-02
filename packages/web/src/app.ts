import { getConnInfo } from "@hono/node-server/conninfo";
import type { CoreRuntime } from "@porchfest/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { RouteRegistry, type TrustAuthorizer } from "./router/registry.js";
import {
  ADMIN_PATH,
  ADMIN_SIGN_IN_PATH,
  registerAdminRoutes,
} from "./routes/admin.js";
import { registerAdminRecordRoutes } from "./routes/admin-records.js";
import { registerAdminRetentionRoutes } from "./routes/admin-retention.js";
import { registerSeasonLifecycleRoutes } from "./routes/season-lifecycle.js";
import { registerAssignmentRoutes } from "./routes/assign.js";
import { registerCoordinateRoutes } from "./routes/coordinates.js";
import { registerOutboxRoutes } from "./routes/outbox.js";
import { registerMapRoutes } from "./routes/map.js";
import {
  registerSignupRoutes,
  type SignupRouteOptions,
} from "./routes/signup.js";
import { registerSelfServeRoutes } from "./routes/self-serve.js";
import { createTrustAuthorizer, type SessionCookieOptions } from "./auth.js";
import { renderPublicLandingPage } from "./views/signup-view.js";

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
  readonly onUnexpectedError?: (error: unknown) => void;
}

export interface PorchfestApp {
  readonly fetch: Hono["fetch"];
  readonly request: Hono["request"];
  readonly routes: RouteRegistry;
}

export function createApp(options: AppOptions): PorchfestApp {
  const app = new Hono();
  if (options.core.ports.email.configured && !options.publicBaseUrl) {
    throw new TypeError(
      "PUBLIC_BASE_URL is required when email and participant self-serve are enabled.",
    );
  }
  app.onError((error) => {
    (options.onUnexpectedError ?? console.error)(error);
    return new Response(
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Service unavailable</title></head>
<body><main><h1>Service temporarily unavailable</h1><p>Please try again.</p></main></body>
</html>`,
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=UTF-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  });
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
      trustedProxyHops: options.trustedProxyHops,
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
    { signInPath: ADMIN_SIGN_IN_PATH },
  );

  // The health endpoint is deliberately the first member of the canonical route
  // registry, so even the scaffold proves that reachability requires a trust tier.
  routes.register({
    method: "GET",
    path: "/health",
    tier: "public",
    requestOriginCheck: "exempt",
    handler: (context: Context) =>
      context.json({ ok: true, service: "porchfest" } as const),
  });

  routes.register({
    method: "GET",
    path: "/",
    tier: "public",
    handler: () =>
      new Response(renderPublicLandingPage({ organizerPath: ADMIN_PATH }), {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
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

  if (options.core.ports.email.configured && options.publicBaseUrl) {
    registerSelfServeRoutes({
      core: options.core,
      routes,
      csrfTokenFor,
      publicBaseUrl: options.publicBaseUrl,
      resolveSocketPeerAddress:
        options.resolveSocketPeerAddress ?? defaultSocketPeerAddress,
      trustedProxyHops: options.trustedProxyHops,
      guardOptions: options.signupGuardOptions,
      cookie: options.sessionCookie,
    });
  }

  registerMapRoutes({ core: options.core, routes });

  registerAdminRoutes({
    core: options.core,
    routes,
    csrfTokenFor,
    publicBaseUrl: options.publicBaseUrl ?? null,
    resolveSocketPeerAddress:
      options.resolveSocketPeerAddress ?? defaultSocketPeerAddress,
    cookie: options.sessionCookie,
  });

  registerAdminRetentionRoutes({ core: options.core, routes, csrfTokenFor });

  registerAdminRecordRoutes({ core: options.core, routes, csrfTokenFor });

  registerSeasonLifecycleRoutes({
    core: options.core,
    routes,
    csrfTokenFor,
    publicBaseUrl: options.publicBaseUrl ?? null,
  });

  registerCoordinateRoutes({ core: options.core, routes, csrfTokenFor });

  registerAssignmentRoutes({ core: options.core, routes, csrfTokenFor });

  registerOutboxRoutes({ core: options.core, routes, csrfTokenFor });

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
