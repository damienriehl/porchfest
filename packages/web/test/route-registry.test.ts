import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RouteRegistry } from '../src/router/registry.js';

describe('central route registry', () => {
  it('refuses a route with no trust tier and leaves it unreachable', async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);

    expect(() =>
      routes.register({
        method: 'GET',
        path: '/missing-tier',
        handler: () => new Response('should never run'),
      }),
    ).toThrow(/missing or unknown trust tier/i);

    expect((await app.request('/missing-tier')).status).toBe(404);
  });

  it('refuses an unknown trust tier and leaves it unreachable', async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);

    expect(() =>
      routes.register({
        method: 'GET',
        path: '/unknown-tier',
        tier: 'trusted-somehow',
        handler: () => new Response('should never run'),
      }),
    ).toThrow(/missing or unknown trust tier/i);

    expect((await app.request('/unknown-tier')).status).toBe(404);
  });

  it('denies protected tiers until an authorizer grants access', async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);
    routes.register({
      method: 'GET',
      path: '/organizer',
      tier: 'organizer',
      handler: (context) => context.text('organizer'),
    });

    expect((await app.request('/organizer')).status).toBe(401);
  });
});
