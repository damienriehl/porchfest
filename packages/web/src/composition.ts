import { NullAntibotAdapter } from "@porchfest/antibot";
import {
  CORE_DATABASE_FILENAME,
  createCore,
  openCoreDatabase,
  type AdapterPorts,
  type CoreRuntime,
} from "@porchfest/core";
import { NullEmailAdapter } from "@porchfest/email";
import { NullGeoAdapter } from "@porchfest/geo";
import type { Hono } from "hono";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadSessionSecret } from "./config/session-secret.js";
import type { RouteRegistry, TrustAuthorizer } from "./router/registry.js";

export interface RuntimeOptions {
  readonly adapterOverrides?: Partial<AdapterPorts>;
  readonly authorize?: TrustAuthorizer;
  readonly dataDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PorchfestRuntime {
  readonly adapters: AdapterPorts;
  readonly core: CoreRuntime;
  readonly close: () => void;
  readonly fetch: Hono["fetch"];
  readonly request: Hono["request"];
  readonly routes: RouteRegistry;
  readonly sessionSecret: string;
}

export function createAdapterSet(
  overrides: Partial<AdapterPorts> = {},
): AdapterPorts {
  return Object.freeze({
    email: overrides.email ?? new NullEmailAdapter(),
    antibot: overrides.antibot ?? new NullAntibotAdapter(),
    geo: overrides.geo ?? new NullGeoAdapter(),
  });
}

export async function createRuntime(
  options: RuntimeOptions = {},
): Promise<PorchfestRuntime> {
  const env = options.env ?? process.env;
  const dataDirectory =
    options.dataDirectory ?? env.PORCHFEST_DATA_DIR ?? "./data";
  const configuredSecret = env.PORCHFEST_SESSION_SECRET?.trim();
  const sessionSecret = await loadSessionSecret({
    dataDirectory,
    configuredSecret: configuredSecret || undefined,
  });
  const adapters = createAdapterSet(options.adapterOverrides);
  const databaseConnection = openCoreDatabase(
    join(dataDirectory, CORE_DATABASE_FILENAME),
  );

  try {
    const core = createCore(adapters, databaseConnection.database);
    const { fetch, request, routes } = createApp({
      core,
      authorize: options.authorize,
    });

    return {
      adapters,
      close: databaseConnection.close,
      core,
      fetch,
      request,
      routes,
      sessionSecret,
    };
  } catch (error) {
    databaseConnection.close();
    throw error;
  }
}
