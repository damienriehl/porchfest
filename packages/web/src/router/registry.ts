import type { Context, Handler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

export const TRUST_TIERS = ["public", "participant", "organizer"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteDeclaration {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tier: TrustTier;
  readonly handler: Handler;
}

export type TrustAuthorizer = (
  tier: Exclude<TrustTier, "public">,
  context: Context,
) => boolean | Promise<boolean>;

export interface MutationProtection {
  readonly allowedOrigin: string | null;
  readonly validateCsrf: (
    token: string | null,
    route: RouteDeclaration,
    context: Context,
  ) => boolean | Promise<boolean>;
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
  if (typeof handler !== "function") {
    throw new RouteRegistrationError(`Route ${method} ${path} has no handler.`);
  }

  return Object.freeze({
    method,
    path,
    tier,
    handler: handler as Handler,
  });
}

const denyProtectedRoutes: TrustAuthorizer = () => false;
const mutationBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (context) => context.text("Mutation body is too large.", 413),
});

export class RouteRegistry {
  readonly #app: Hono;
  readonly #authorize: TrustAuthorizer;
  readonly #mutationProtection: MutationProtection | undefined;
  readonly #routes: RouteDeclaration[] = [];
  readonly #keys = new Set<string>();

  constructor(
    app: Hono,
    authorize: TrustAuthorizer = denyProtectedRoutes,
    mutationProtection?: MutationProtection,
  ) {
    this.#app = app;
    this.#authorize = authorize;
    this.#mutationProtection = mutationProtection;
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
      if (this.#mutationProtection?.allowedOrigin !== null) {
        const expectedOrigin = this.#mutationProtection?.allowedOrigin;
        if (
          expectedOrigin !== undefined &&
          new URL(context.req.url).origin !== expectedOrigin
        ) {
          return context.text("Unrecognized request host.", 421);
        }
      }
      if (
        route.tier !== "public" &&
        !(await this.#authorize(route.tier, context))
      ) {
        return context.json({ error: "unauthorized" }, 401);
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
          context.text("Mutation handler returned no response.", 500)
        );
      }
      return route.handler(context, next);
    });
    return route;
  }

  list(): readonly RouteDeclaration[] {
    return [...this.#routes];
  }
}

function rejectMutationOrigin(
  context: Context,
  protection: MutationProtection | undefined,
): Response | null {
  if (!protection || protection.allowedOrigin === null) {
    return context.text("Mutation protection is not configured.", 503);
  }
  if (context.req.header("origin") !== protection.allowedOrigin) {
    return context.text("Request origin was refused.", 403);
  }
  return null;
}

async function rejectUnsafeMutation(
  route: RouteDeclaration,
  context: Context,
  protection: MutationProtection | undefined,
): Promise<Response | null> {
  if (!protection)
    return context.text("Mutation protection is not configured.", 503);

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
