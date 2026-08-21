import type { Context, Handler } from 'hono';
import { Hono } from 'hono';

export const TRUST_TIERS = ['public', 'participant', 'organizer'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteDeclaration {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tier: TrustTier;
  readonly handler: Handler;
}

export type TrustAuthorizer = (
  tier: Exclude<TrustTier, 'public'>,
  context: Context,
) => boolean | Promise<boolean>;

export class RouteRegistrationError extends Error {
  override readonly name = 'RouteRegistrationError';
}

function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value);
}

function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value);
}

function validateRoute(input: unknown): RouteDeclaration {
  if (!input || typeof input !== 'object') {
    throw new RouteRegistrationError('Route declaration must be an object; registration refused.');
  }

  const candidate = input as Record<string, unknown>;
  const method = candidate.method;
  const path = candidate.path;
  const tier = candidate.tier;
  const handler = candidate.handler;

  if (!isHttpMethod(method)) {
    throw new RouteRegistrationError(`Route has an unknown HTTP method: ${String(method)}`);
  }
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new RouteRegistrationError(`Route has an invalid path: ${String(path)}`);
  }
  if (!isTrustTier(tier)) {
    throw new RouteRegistrationError(
      `Route ${method} ${path} has a missing or unknown trust tier; registration refused.`,
    );
  }
  if (typeof handler !== 'function') {
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

export class RouteRegistry {
  readonly #app: Hono;
  readonly #authorize: TrustAuthorizer;
  readonly #routes: RouteDeclaration[] = [];
  readonly #keys = new Set<string>();

  constructor(app: Hono, authorize: TrustAuthorizer = denyProtectedRoutes) {
    this.#app = app;
    this.#authorize = authorize;
  }

  register(input: unknown): RouteDeclaration {
    const route = validateRoute(input);
    const key = `${route.method} ${route.path}`;
    if (this.#keys.has(key)) {
      throw new RouteRegistrationError(`Duplicate route ${key}; registration refused.`);
    }

    this.#keys.add(key);
    this.#routes.push(route);
    this.#app.on(route.method, route.path, async (context, next) => {
      if (route.tier !== 'public' && !(await this.#authorize(route.tier, context))) {
        return context.json({ error: 'unauthorized' }, 401);
      }
      return route.handler(context, next);
    });
    return route;
  }

  list(): readonly RouteDeclaration[] {
    return [...this.#routes];
  }
}
