import { NullAntibotAdapter } from '@porchfest/antibot';
import { createCore, type AdapterPorts, type CoreRuntime } from '@porchfest/core';
import { NullEmailAdapter } from '@porchfest/email';
import { NullGeoAdapter } from '@porchfest/geo';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { loadSessionSecret } from './config/session-secret.js';
import type { RouteRegistry, TrustAuthorizer } from './router/registry.js';

export interface RuntimeOptions {
  readonly adapterOverrides?: Partial<AdapterPorts>;
  readonly authorize?: TrustAuthorizer;
  readonly dataDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PorchfestRuntime {
  readonly adapters: AdapterPorts;
  readonly app: Hono;
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
  readonly sessionSecret: string;
}

export function createAdapterSet(overrides: Partial<AdapterPorts> = {}): AdapterPorts {
  return Object.freeze({
    email: overrides.email ?? new NullEmailAdapter(),
    antibot: overrides.antibot ?? new NullAntibotAdapter(),
    geo: overrides.geo ?? new NullGeoAdapter(),
  });
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<PorchfestRuntime> {
  const env = options.env ?? process.env;
  const dataDirectory = options.dataDirectory ?? env.PORCHFEST_DATA_DIR ?? './data';
  const configuredSecret = env.PORCHFEST_SESSION_SECRET?.trim();
  const sessionSecret = await loadSessionSecret({
    dataDirectory,
    configuredSecret: configuredSecret || undefined,
  });
  const adapters = createAdapterSet(options.adapterOverrides);
  const core = createCore(adapters);
  const { app, routes } = createApp({ core, authorize: options.authorize });

  return { adapters, app, core, routes, sessionSecret };
}
