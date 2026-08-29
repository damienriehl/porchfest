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
import { NoneEmailAdapter, SmtpEmailAdapter } from "@porchfest/email";
import { NullGeoAdapter } from "@porchfest/geo";
import type { Hono } from "hono";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
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
    email: overrides.email ?? createEmailAdapter(env),
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

/** The default SMTP submission port. Implicit TLS lives on 465 instead. */
const DEFAULT_SMTP_PORT = 587;

/**
 * KD5/R12: email is hybrid per deployment. Configure a provider and the outbox
 * can send; configure none and it offers copy-paste/export (AE1).
 *
 * The refusal in the middle matters as much as either end. A deployment that
 * set a host but no from address, or a username with no password, believes it
 * turned sending on; booting it into copy-paste mode would look identical to
 * "nobody pressed send" and the wave would silently never go out.
 */
function createEmailAdapter(
  env: Readonly<Record<string, string | undefined>>,
): AdapterPorts["email"] {
  const host = env.PORCHFEST_SMTP_HOST?.trim() ?? "";
  const from = env.PORCHFEST_SMTP_FROM?.trim() ?? "";
  const port = env.PORCHFEST_SMTP_PORT?.trim() ?? "";
  const username = env.PORCHFEST_SMTP_USERNAME?.trim() ?? "";
  const password = env.PORCHFEST_SMTP_PASSWORD ?? "";
  const passwordFile = env.PORCHFEST_SMTP_PASSWORD_FILE?.trim() ?? "";

  const anySmtpVariable = [
    host,
    port,
    username,
    password.trim(),
    passwordFile,
    from,
  ].some((value) => value.length > 0);
  if (!anySmtpVariable) return new NoneEmailAdapter();

  const missing: string[] = [];
  if (host.length === 0) missing.push("PORCHFEST_SMTP_HOST");
  if (from.length === 0) missing.push("PORCHFEST_SMTP_FROM");
  if (missing.length > 0) {
    throw new TypeError(
      `SMTP needs ${missing.join(" and ")}. Set PORCHFEST_SMTP_HOST and PORCHFEST_SMTP_FROM together, or none of the PORCHFEST_SMTP_* variables to run the outbox in copy-paste mode.`,
    );
  }

  const hasSecret = password.length > 0 || passwordFile.length > 0;
  const hasUsername = username.length > 0;
  if (hasUsername !== hasSecret) {
    throw new TypeError(
      "SMTP credentials need PORCHFEST_SMTP_USERNAME alongside PORCHFEST_SMTP_PASSWORD or PORCHFEST_SMTP_PASSWORD_FILE. Set both, or neither to submit unauthenticated.",
    );
  }

  return new SmtpEmailAdapter({
    host,
    port: parseSmtpPort(port),
    secure: parseSmtpFlag(env.PORCHFEST_SMTP_SECURE, "PORCHFEST_SMTP_SECURE"),
    starttls: parseSmtpFlag(
      env.PORCHFEST_SMTP_STARTTLS,
      "PORCHFEST_SMTP_STARTTLS",
      true,
    ),
    username: hasUsername ? username : undefined,
    password: hasUsername
      ? readSmtpPassword(password, passwordFile)
      : undefined,
    from: requirePlausibleFrom(from),
  });
}

function parseSmtpPort(value: string): number {
  if (value.length === 0) return DEFAULT_SMTP_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(
      "PORCHFEST_SMTP_PORT must be a TCP port number between 1 and 65535.",
    );
  }
  return port;
}

function parseSmtpFlag(
  value: string | undefined,
  name: string,
  fallback = false,
): boolean {
  const configured = value?.trim().toLowerCase() ?? "";
  if (configured.length === 0) return fallback;
  if (configured === "true" || configured === "1") return true;
  if (configured === "false" || configured === "0") return false;
  throw new TypeError(`${name} must be true or false.`);
}

/**
 * KTD15: the password comes from the environment or a mounted file, is read
 * once at boot, and never reaches a log line — including the failure paths,
 * which name the variable rather than quoting what was found.
 */
function readSmtpPassword(password: string, passwordFile: string): string {
  if (passwordFile.length === 0) return password;

  let contents: string;
  try {
    contents = readFileSync(passwordFile, "utf8");
  } catch {
    throw new TypeError(
      "PORCHFEST_SMTP_PASSWORD_FILE could not be read. Mount the credential file, or set PORCHFEST_SMTP_PASSWORD instead.",
    );
  }
  // A mounted secret usually ends in a newline the file editor added.
  const secret = contents.trimEnd();
  if (secret.length === 0) {
    throw new TypeError("PORCHFEST_SMTP_PASSWORD_FILE names an empty file.");
  }
  return secret;
}

function requirePlausibleFrom(value: string): string {
  // The whole value is interpolated into a From header, so the display-name
  // half needs checking too: a CR or LF there adds a header - a Bcc, say - to
  // every message the deployment sends. Only the address inside <…> used to be
  // validated, which left that half entirely unchecked.
  const hasControlCharacter = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlCharacter) {
    throw new TypeError(
      "PORCHFEST_SMTP_FROM must not contain control characters, including a line break.",
    );
  }
  const open = value.lastIndexOf("<");
  const close = value.lastIndexOf(">");
  const address =
    open !== -1 && close > open ? value.slice(open + 1, close).trim() : value;
  const at = address.indexOf("@");
  const plausible =
    at > 0 &&
    at === address.lastIndexOf("@") &&
    at < address.length - 1 &&
    !address.includes(" ");
  if (!plausible) {
    throw new TypeError(
      'PORCHFEST_SMTP_FROM must be an email address, either "organizers@example.org" or "Name <organizers@example.org>".',
    );
  }
  return value;
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

export function parsePublicBaseUrl(value: string | undefined): string | null {
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
