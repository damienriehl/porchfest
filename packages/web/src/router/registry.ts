import type { Context, Handler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { adminHeaders } from "../auth.js";
import { renderOrganizerSignInRequiredPage } from "../views/admin-shell.js";
import { renderParticipantAccessRequiredPage } from "../views/self-serve.js";

export const TRUST_TIERS = ["public", "participant", "organizer"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteDeclaration {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tier: TrustTier;
  /** Exempts infrastructure routes from the configured request-origin guard. */
  readonly requestOriginCheck?: "exempt";
  readonly handler: Handler;
}

export type TrustAuthorizer = (
  tier: Exclude<TrustTier, "public">,
  context: Context,
) => boolean | Promise<boolean>;

export interface MutationProtection {
  readonly allowedOrigin: string | null;
  readonly trustedProxyHops?: number;
  readonly validateCsrf: (
    token: string | null,
    route: RouteDeclaration,
    context: Context,
  ) => boolean | Promise<boolean>;
}

export interface RouteActivityHooks {
  readonly onOrganizerActivity?: () => void;
}

export interface OrganizerAccessOptions {
  readonly signInPath?: string;
}

export class RouteRegistrationError extends Error {
  override readonly name = "RouteRegistrationError";
}

function isTrustTier(value: unknown): value is TrustTier {
  return (
    typeof value === "string" &&
    (TRUST_TIERS as readonly string[]).includes(value)
  );
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return (
    typeof value === "string" &&
    (HTTP_METHODS as readonly string[]).includes(value)
  );
}

function validateRoute(input: unknown): RouteDeclaration {
  if (!input || typeof input !== "object") {
    throw new RouteRegistrationError(
      "Route declaration must be an object; registration refused.",
    );
  }

  const candidate = input as Record<string, unknown>;
  const method = candidate.method;
  const path = candidate.path;
  const tier = candidate.tier;
  const requestOriginCheck = candidate.requestOriginCheck;
  const handler = candidate.handler;

  if (!isHttpMethod(method)) {
    throw new RouteRegistrationError(
      `Route has an unknown HTTP method: ${String(method)}`,
    );
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new RouteRegistrationError(
      `Route has an invalid path: ${String(path)}`,
    );
  }
  if (!isTrustTier(tier)) {
    throw new RouteRegistrationError(
      `Route ${method} ${path} has a missing or unknown trust tier; registration refused.`,
    );
  }
  if (requestOriginCheck !== undefined && requestOriginCheck !== "exempt") {
    throw new RouteRegistrationError(
      `Route ${method} ${path} has an unknown origin-check policy; registration refused.`,
    );
  }
  if (typeof handler !== "function") {
    throw new RouteRegistrationError(`Route ${method} ${path} has no handler.`);
  }

  return Object.freeze({
    method,
    path,
    tier,
    ...(requestOriginCheck === "exempt" ? { requestOriginCheck } : {}),
    handler: handler as Handler,
  });
}

const denyProtectedRoutes: TrustAuthorizer = () => false;
const plainTextAdminHeaders = () =>
  adminHeaders({ "content-type": "text/plain; charset=UTF-8" });
const mutationBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (context) =>
    context.text("Mutation body is too large.", 413, plainTextAdminHeaders()),
});

export class RouteRegistry {
  readonly #app: Hono;
  readonly #authorize: TrustAuthorizer;
  readonly #mutationProtection: MutationProtection | undefined;
  readonly #activityHooks: RouteActivityHooks;
  readonly #organizerAccess: OrganizerAccessOptions;
  readonly #routes: RouteDeclaration[] = [];
  readonly #keys = new Set<string>();

  constructor(
    app: Hono,
    authorize: TrustAuthorizer = denyProtectedRoutes,
    mutationProtection?: MutationProtection,
    activityHooks: RouteActivityHooks = {},
    organizerAccess: OrganizerAccessOptions = {},
  ) {
    this.#app = app;
    this.#authorize = authorize;
    this.#mutationProtection = mutationProtection;
    this.#activityHooks = activityHooks;
    this.#organizerAccess = organizerAccess;
  }

  register(input: unknown): RouteDeclaration {
    const route = validateRoute(input);
    const key = `${route.method} ${route.path}`;
    if (this.#keys.has(key)) {
      throw new RouteRegistrationError(
        `Duplicate route ${key}; registration refused.`,
      );
    }

    this.#keys.add(key);
    this.#routes.push(route);
    this.#app.on(route.method, route.path, async (context, next) => {
      if (
        route.requestOriginCheck !== "exempt" &&
        this.#mutationProtection?.allowedOrigin !== null
      ) {
        const expectedOrigin = this.#mutationProtection?.allowedOrigin;
        if (
          expectedOrigin !== undefined &&
          effectiveRequestOrigin(
            context,
            this.#mutationProtection?.trustedProxyHops,
          ) !== expectedOrigin
        ) {
          return context.text(
            "Unrecognized request host.",
            421,
            plainTextAdminHeaders(),
          );
        }
      }
      if (
        route.tier !== "public" &&
        !(await this.#authorize(route.tier, context))
      ) {
        const organizerSignInPath = this.#organizerAccess.signInPath;
        // Redirect only page navigations: redirecting a refused mutation would
        // discard its body, participant auth has no sign-in destination yet,
        // and redirecting the destination itself would trap the browser in a loop.
        if (
          route.method === "GET" &&
          route.tier === "organizer" &&
          organizerSignInPath &&
          route.path !== organizerSignInPath &&
          acceptsHtml(context)
        ) {
          return this.organizerGetRefusal(context);
        }
        if (
          route.method !== "GET" &&
          route.tier === "organizer" &&
          organizerSignInPath &&
          acceptsHtml(context)
        ) {
          // A fresh one-use link reaches the organizer out of band, so this
          // page cannot carry the refused request's destination through sign-in.
          return new Response(
            renderOrganizerSignInRequiredPage({
              organizerSignInPath,
            }),
            { status: 401, headers: adminHeaders() },
          );
        }
        if (route.tier === "participant" && acceptsHtml(context)) {
          return new Response(renderParticipantAccessRequiredPage(), {
            status: 401,
            headers: adminHeaders(),
          });
        }
        return context.json(
          { error: "unauthorized" },
          401,
          adminHeaders({ "content-type": "application/json" }),
        );
      }
      if (route.tier === "organizer") {
        try {
          // R35: only admitted organizer activity wakes retention enforcement.
          // The observer is never allowed to turn a background concern into an
          // admin outage, including if queuing the deferred sweep itself fails.
          this.#activityHooks.onOrganizerActivity?.();
        } catch {
          // The observer owns its failure log and must not affect this request.
        }
      }
      if (route.method !== "GET") {
        const originRejection = rejectMutationOrigin(
          context,
          this.#mutationProtection,
        );
        if (originRejection) return originRejection;

        let handled: Response | void = undefined;
        const limitResponse = await mutationBodyLimit(context, async () => {
          const rejection = await rejectUnsafeMutation(
            route,
            context,
            this.#mutationProtection,
          );
          handled = rejection ?? (await route.handler(context, next));
        });
        return (
          limitResponse ??
          handled ??
          (context.finalized ? context.res : undefined) ??
          context.text(
            "Mutation handler returned no response.",
            500,
            plainTextAdminHeaders(),
          )
        );
      }
      return route.handler(context, next);
    });
    return route;
  }

  /** Keep defensive handler checks aligned with the registry's HTML redirect. */
  organizerGetRefusal(context: Context): Response {
    const organizerSignInPath = this.#organizerAccess.signInPath;
    const requestPath = new URL(context.req.url).pathname;
    if (
      organizerSignInPath &&
      requestPath !== organizerSignInPath &&
      acceptsHtml(context)
    ) {
      // Fresh sign-in links arrive out of band and cannot preserve this URL,
      // so the browser can only continue to the generic sign-in page.
      return new Response(null, {
        status: 303,
        headers: adminHeaders({
          location: organizerSignInPath,
        }),
      });
    }
    return context.json(
      { error: "unauthorized" },
      401,
      adminHeaders({ "content-type": "application/json" }),
    );
  }

  list(): readonly RouteDeclaration[] {
    return [...this.#routes];
  }
}

function effectiveRequestOrigin(
  context: Context,
  trustedProxyHops: number | undefined,
): string {
  const requestUrl = new URL(context.req.url);
  if (trustedProxyHops === undefined || trustedProxyHops < 1) {
    return requestUrl.origin;
  }

  const protocol = context.req
    .header("x-forwarded-proto")
    ?.trim()
    .toLowerCase();
  if (protocol !== "http" && protocol !== "https") {
    return requestUrl.origin;
  }

  const requestAuthority =
    context.req.header("host")?.trim() ?? requestUrl.host;
  try {
    const externalUrl = new URL(`${protocol}://${requestAuthority}`);
    if (
      externalUrl.username ||
      externalUrl.password ||
      externalUrl.pathname !== "/" ||
      externalUrl.search ||
      externalUrl.hash
    ) {
      return requestUrl.origin;
    }
    return externalUrl.origin;
  } catch {
    return requestUrl.origin;
  }
}

function acceptsHtml(context: Context): boolean {
  return (context.req.header("accept") ?? "").split(",").some((range) => {
    const [rawMediaType, ...parameters] = range.split(";");
    const mediaType = rawMediaType?.trim().toLowerCase();
    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));
    return (
      (mediaType === "text/html" || mediaType === "application/xhtml+xml") &&
      (quality === undefined || Number(quality.slice(2)) > 0)
    );
  });
}

function rejectMutationOrigin(
  context: Context,
  protection: MutationProtection | undefined,
): Response | null {
  if (!protection || protection.allowedOrigin === null) {
    return context.text(
      "Mutation protection is not configured.",
      503,
      plainTextAdminHeaders(),
    );
  }
  if (context.req.header("origin") !== protection.allowedOrigin) {
    return context.text(
      "Request origin was refused.",
      403,
      plainTextAdminHeaders(),
    );
  }
  return null;
}

async function rejectUnsafeMutation(
  route: RouteDeclaration,
  context: Context,
  protection: MutationProtection | undefined,
): Promise<Response | null> {
  if (!protection)
    return context.text(
      "Mutation protection is not configured.",
      503,
      plainTextAdminHeaders(),
    );

  const mediaType = (context.req.header("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const isForm =
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "multipart/form-data";
  if (!isForm && mediaType !== "application/json") {
    return context.text("Unsupported mutation content type.", 415);
  }

  let token = context.req.header("x-csrf-token") ?? null;
  if (token === null && isForm) {
    try {
      const form = await context.req.formData();
      const candidate = form.get("_csrf");
      token = typeof candidate === "string" ? candidate : null;
    } catch {
      return context.text("Malformed mutation body.", 400);
    }
  }
  if (!(await protection.validateCsrf(token, route, context))) {
    return context.text("CSRF token was refused.", 403);
  }
  return null;
}
