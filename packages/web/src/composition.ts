import {
  NullAntibotAdapter,
  TurnstileAntibotAdapter,
} from "@porchfest/antibot";
import type { UnconfiguredAntibotGuardOptions } from "@porchfest/antibot";
import {
  CORE_DATABASE_FILENAME,
  createCore,
  DEFAULT_RETENTION_MONTHS,
  normalizeRetentionMonths,
  openCoreDatabase,
  type AdapterPorts,
  type CoreRuntime,
} from "@porchfest/core";
import {
  createCoreTestingRepository,
  type CoreTestingRepository,
} from "@porchfest/core/testing";
import { NullEmailAdapter } from "@porchfest/email";
import { NullGeoAdapter } from "@porchfest/geo";
import type { Hono } from "hono";
import type { Context } from "hono";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.js";
import type { SessionCookieOptions } from "./auth.js";
import { createRetentionSweep } from "./retention-sweep.js";
import { announceBootstrapLink } from "./routes/admin.js";
import { loadSessionSecret } from "./config/session-secret.js";
import type { RouteRegistry, TrustAuthorizer } from "./router/registry.js";

export interface RuntimeOptions {
  readonly adapterOverrides?: Partial<AdapterPorts>;
  readonly authorize?: TrustAuthorizer;
  readonly dataDirectory?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly resolveSocketPeerAddress?: (context: Context) => string | null;
  readonly signupGuardOptions?: UnconfiguredAntibotGuardOptions;
  readonly sessionCookie?: SessionCookieOptions;
  /** Where the first-boot organizer link is announced. Defaults to the log. */
  readonly announce?: (message: string) => void;
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

export interface PorchfestTestingRuntime extends PorchfestRuntime {
  readonly coreTesting: CoreTestingRepository;
}

export function createAdapterSet(
  overrides: Partial<AdapterPorts> = {},
  env: Readonly<Record<string, string | undefined>> = {},
): AdapterPorts {
  return Object.freeze({
    email: overrides.email ?? new NullEmailAdapter(),
    antibot: overrides.antibot ?? createAntibotAdapter(env),
    geo: overrides.geo ?? new NullGeoAdapter(),
  });
}

/**
 * Select the anti-bot adapter a deployment actually configured.
 *
 * Until this existed the adapter could only be reached by a test injecting it,
 * so R3's "fails closed when configured" branch was unreachable in production
 * and every real deployment silently ran the no-provider default.
 *
 * Both values are required together on purpose: the site key mounts the widget
 * and the other verifies it, so configuring one alone yields a form nobody can
 * submit. That is a startup refusal, not a silent downgrade — a deployment that
 * believes it turned on protection must not quietly be running without it.
 */
function createAntibotAdapter(
  env: Readonly<Record<string, string | undefined>>,
): AdapterPorts["antibot"] {
  const siteKey = env.PORCHFEST_TURNSTILE_SITE_KEY?.trim();
  const secret = env.PORCHFEST_TURNSTILE_SECRET_KEY?.trim();
  if (!siteKey && !secret) return new NullAntibotAdapter();
  if (!siteKey || !secret) {
    throw new TypeError(
      "Turnstile needs both PORCHFEST_TURNSTILE_SITE_KEY and PORCHFEST_TURNSTILE_SECRET_KEY. Set both, or neither to run with the built-in rate limit and honeypot.",
    );
  }
  return new TurnstileAntibotAdapter({ siteKey, secretKey: secret });
}

export async function createRuntime(
  options: RuntimeOptions = {},
): Promise<PorchfestRuntime> {
  return createRuntimeWithTesting(options, false);
}

/**
 * Boots the normal application plus KTD2's narrow, read-only core test seam.
 * Production callers use createRuntime and cannot reach these storage readers.
 */
export async function createTestingRuntime(
  options: RuntimeOptions = {},
): Promise<PorchfestTestingRuntime> {
  return createRuntimeWithTesting(options, true);
}

async function createRuntimeWithTesting(
  options: RuntimeOptions,
  includeTesting: false,
): Promise<PorchfestRuntime>;
async function createRuntimeWithTesting(
  options: RuntimeOptions,
  includeTesting: true,
): Promise<PorchfestTestingRuntime>;
async function createRuntimeWithTesting(
  options: RuntimeOptions,
  includeTesting: boolean,
): Promise<PorchfestRuntime | PorchfestTestingRuntime> {
  const env = options.env ?? process.env;
  const dataDirectory =
    options.dataDirectory ?? env.PORCHFEST_DATA_DIR ?? "./data";
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const configuredSecret = env.PORCHFEST_SESSION_SECRET?.trim();
  const sessionSecret = await loadSessionSecret({
    dataDirectory,
    configuredSecret: configuredSecret || undefined,
  });
  const adapters = createAdapterSet(options.adapterOverrides, env);
  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL);
  const trustedProxyHops = parseTrustedProxyHops(
    env.PORCHFEST_TRUSTED_PROXY_HOPS,
  );
  const retentionMonths = parseRetentionMonths(env.PORCHFEST_RETENTION_MONTHS);
  const databaseConnection = openCoreDatabase(
    join(dataDirectory, CORE_DATABASE_FILENAME),
  );

  try {
    const core = createCore(adapters, databaseConnection.database, {
      retention: { retentionMonths },
    });
    const retentionSweep = createRetentionSweep(core);
    // R35: boot is one of only two opportunities to enforce retention. Failure
    // is logged inside the trigger and cannot prevent the container from booting.
    retentionSweep.onBoot();
    const { fetch, request, routes } = createApp({
      core,
      authorize: options.authorize,
      csrfSecret: sessionSecret,
      publicBaseUrl,
      resolveSocketPeerAddress: options.resolveSocketPeerAddress,
      signupGuardOptions: options.signupGuardOptions,
      trustedProxyHops,
      sessionCookie: options.sessionCookie,
      onOrganizerActivity: retentionSweep.onOrganizerActivity,
    });

    // R9: with no organizer yet, the container log is the delivery channel for
    // the first login. It must not depend on the email adapter being configured.
    announceBootstrapLink(core, publicBaseUrl, options.announce);

    const runtime = {
      adapters,
      close: databaseConnection.close,
      core,
      fetch,
      request,
      routes,
      sessionSecret,
    };
    return includeTesting
      ? {
          ...runtime,
          coreTesting: createCoreTestingRepository(databaseConnection.database),
        }
      : runtime;
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

function parseRetentionMonths(value: string | undefined): number {
  const configured = value?.trim();
  if (!configured) return DEFAULT_RETENTION_MONTHS;
  // R35 defaults closed to a meaningful window. Invalid deployment input must
  // never become zero or NaN and immediately anonymize the whole database.
  return normalizeRetentionMonths(Number(configured));
}
