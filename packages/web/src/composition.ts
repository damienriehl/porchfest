import { NullAntibotAdapter } from "@porchfest/antibot";
import type { UnconfiguredAntibotGuardOptions } from "@porchfest/antibot";
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
import type { Context } from "hono";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadSessionSecret } from "./config/session-secret.js";
import type { RouteRegistry, TrustAuthorizer } from "./router/registry.js";

export interface RuntimeOptions {
  readonly adapterOverrides?: Partial<AdapterPorts>;
  readonly authorize?: TrustAuthorizer;
  readonly dataDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveSocketPeerAddress?: (context: Context) => string | null;
  readonly signupGuardOptions?: UnconfiguredAntibotGuardOptions;
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
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const configuredSecret = env.PORCHFEST_SESSION_SECRET?.trim();
  const sessionSecret = await loadSessionSecret({
    dataDirectory,
    configuredSecret: configuredSecret || undefined,
  });
  const adapters = createAdapterSet(options.adapterOverrides);
  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  const trustedProxyHops = parseTrustedProxyHops(
    env.PORCHFEST_TRUSTED_PROXY_HOPS,
  );
  const databaseConnection = openCoreDatabase(
    join(dataDirectory, CORE_DATABASE_FILENAME),
  );

  try {
    const core = createCore(adapters, databaseConnection.database);
    const { fetch, request, routes } = createApp({
      core,
      authorize: options.authorize,
      csrfSecret: sessionSecret,
      publicBaseUrl,
      resolveSocketPeerAddress: options.resolveSocketPeerAddress,
      signupGuardOptions: options.signupGuardOptions,
      trustedProxyHops,
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
    try {
      databaseConnection.close();
    } catch {
      // Preserve the composition error that made boot fail.
    }
    throw error;
  }
}

function parsePublicBaseUrl(value: string | undefined): string | null {
  const configured = value?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new TypeError("PUBLIC_BASE_URL must be an absolute http(s) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "PUBLIC_BASE_URL must contain only an http(s) origin, with no credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}

function parseTrustedProxyHops(value: string | undefined): number | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;
  const hops = Number(configured);
  if (!Number.isSafeInteger(hops) || hops < 0) {
    throw new TypeError(
      "PORCHFEST_TRUSTED_PROXY_HOPS must be a non-negative integer.",
    );
  }
  return hops;
}
