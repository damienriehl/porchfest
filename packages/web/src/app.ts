import { Hono } from 'hono';
import type { CoreRuntime } from '@porchfest/core';
import { RouteRegistry, type TrustAuthorizer } from './router/registry.js';

export interface AppOptions {
  readonly core: CoreRuntime;
  readonly authorize?: TrustAuthorizer;
}

export interface PorchfestApp {
  readonly app: Hono;
  readonly routes: RouteRegistry;
}

export function createApp(options: AppOptions): PorchfestApp {
  // Retaining the core argument here makes the injection boundary explicit even
  // before a domain route consumes it.
  void options.core;

  const app = new Hono();
  const routes = new RouteRegistry(app, options.authorize);

  // The health endpoint is deliberately the first member of the canonical route
  // registry, so even the scaffold proves that reachability requires a trust tier.
  routes.register({
    method: 'GET',
    path: '/health',
    tier: 'public',
    handler: (context) => context.json({ ok: true, service: 'porchfest' } as const),
  });

  return { app, routes };
}
