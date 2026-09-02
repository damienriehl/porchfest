import type { CoreRuntime } from "@porchfest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import { SESSION_SECRET_PLACEHOLDER } from "../src/config/session-secret.js";

const PROXY_PUBLIC_BASE_URL = "https://app.sapporchfest.org";
const proxyTestRoots: string[] = [];
const proxyTestRuntimes: PorchfestRuntime[] = [];

afterEach(async () => {
  for (const runtime of proxyTestRuntimes.splice(0)) runtime.close();
  await Promise.all(
    proxyTestRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createProxyTestRuntime(
  trustedProxyHops: string,
  publicBaseUrl = PROXY_PUBLIC_BASE_URL,
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-proxy-"));
  proxyTestRoots.push(dataDirectory);
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL: publicBaseUrl,
      PORCHFEST_SESSION_SECRET: "proxy-test-session-secret",
      PORCHFEST_TRUSTED_PROXY_HOPS: trustedProxyHops,
    },
    announce: () => undefined,
  });
  proxyTestRuntimes.push(runtime);
  return runtime;
}

describe("application scaffold", () => {
  it("boots with an empty configuration and serves health", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-empty-config-"),
    );
    const runtime = await createRuntime({ env: {}, dataDirectory });

    const landing = await runtime.request("/");
    const response = await runtime.request("/health");

    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('href="/signup/host"');
    expect(landingHtml).toContain('href="/signup/performer"');
    expect(landingHtml).toContain('href="/admin"');
    expect(landingHtml).toContain("Organizer access");
    expect(landingHtml).not.toContain("/admin/sign-in");
    expect(response.status).toBe(200);
    expect("app" in runtime).toBe(false);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "porchfest",
    });
    expect(
      runtime.routes
        .list()
        .map(({ method, path, tier }) => ({ method, path, tier })),
    ).toEqual([
      { method: "GET", path: "/health", tier: "public" },
      { method: "GET", path: "/", tier: "public" },
      {
        method: "GET",
        path: "/signup/assets/signup.css",
        tier: "public",
      },
      {
        method: "GET",
        path: "/signup/assets/signup-preview.js",
        tier: "public",
      },
      { method: "GET", path: "/signup/host", tier: "public" },
      { method: "POST", path: "/signup/host", tier: "public" },
      { method: "GET", path: "/signup/performer", tier: "public" },
      { method: "POST", path: "/signup/performer", tier: "public" },
      { method: "GET", path: "/map", tier: "public" },
      { method: "GET", path: "/map/data.json", tier: "public" },
      {
        method: "GET",
        path: "/map/assets/porchfest-map.js",
        tier: "public",
      },
      {
        method: "GET",
        path: "/map/assets/porchfest-map.css",
        tier: "public",
      },
      { method: "GET", path: "/favicon.ico", tier: "public" },
      { method: "GET", path: "/admin", tier: "organizer" },
      { method: "GET", path: "/admin/organizers", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/organizers/invite",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/sign-in", tier: "public" },
      { method: "POST", path: "/admin/sign-in", tier: "public" },
      { method: "GET", path: "/admin/setup", tier: "organizer" },
      { method: "POST", path: "/admin/setup", tier: "organizer" },
      { method: "GET", path: "/admin/seasons", tier: "organizer" },
      { method: "GET", path: "/admin/seasons/new", tier: "organizer" },
      { method: "POST", path: "/admin/seasons/new", tier: "organizer" },
      { method: "GET", path: "/admin/seasons/:id/edit", tier: "organizer" },
      { method: "POST", path: "/admin/seasons/:id/edit", tier: "organizer" },
      { method: "POST", path: "/admin/sign-out", tier: "organizer" },
      { method: "GET", path: "/admin/retention", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/retention/:id/anonymize",
        tier: "organizer",
      },
      { method: "POST", path: "/admin/queue/dismiss", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/change-requests/:id/apply",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/admin/change-requests/:id/reject",
        tier: "organizer",
      },
      {
        method: "GET",
        path: "/admin/placeholders/:recordType/new",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/admin/placeholders/:recordType",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/records/act/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/records/act/:id/status",
        tier: "organizer",
      },
      { method: "POST", path: "/admin/records/act/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/records/act/:id/promote",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/admin/records/act/:id/supersede",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/records/venue/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/records/venue/:id/status",
        tier: "organizer",
      },
      { method: "POST", path: "/admin/records/venue/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/records/venue/:id/promote",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/admin/records/venue/:id/supersede",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/records/contact/:id", tier: "organizer" },
      { method: "POST", path: "/admin/records/contact/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/records/contact/:id/supersede",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/seasons/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/seasons/:id/transition",
        tier: "organizer",
      },
      { method: "GET", path: "/seasons/:id/coordinates", tier: "organizer" },
      {
        method: "POST",
        path: "/seasons/:id/coordinates/:venueId/verify",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/seasons/:id/coordinates/geocode",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/seasons/:id/map/publish",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/seasons/:id/map/unpublish",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/venues/:id/assign", tier: "organizer" },
      { method: "GET", path: "/admin/acts/:id/assign", tier: "organizer" },
      { method: "POST", path: "/admin/slots/:id/assign", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/assignments/:id/unassign",
        tier: "organizer",
      },
      { method: "POST", path: "/admin/slots/:id/hold", tier: "organizer" },
      { method: "POST", path: "/admin/slots/:id/release", tier: "organizer" },
      { method: "POST", path: "/admin/acts/:id/links", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/act-links/:id/unlink",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/assets/admin.js", tier: "public" },
      { method: "GET", path: "/admin/seasons/:id/outbox", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/seasons/:id/outbox/generate",
        tier: "organizer",
      },
      {
        method: "POST",
        path: "/admin/seasons/:id/outbox/ad-hoc",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/outbox/waves/:id", tier: "organizer" },
      {
        method: "POST",
        path: "/admin/outbox/waves/:id/send",
        tier: "organizer",
      },
      {
        method: "GET",
        path: "/admin/outbox/messages/:id{[0-9]+\\.eml}",
        tier: "organizer",
      },
      { method: "GET", path: "/admin/outbox/messages/:id", tier: "organizer" },
      { method: "POST", path: "/admin/outbox/messages/:id", tier: "organizer" },
    ]);
  });

  it("treats Compose empty-string interpolation as unconfigured", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-empty-compose-env-"),
    );
    const runtime = await createRuntime({
      env: { PORCHFEST_SESSION_SECRET: "" },
      dataDirectory,
    });

    expect(runtime.sessionSecret.length).toBeGreaterThan(0);
    expect((await runtime.request("/health")).status).toBe(200);
  });

  it("returns a minimal 503 page for an unexpected route error", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-route-error-"),
    );
    const runtime = await createRuntime({
      env: {},
      dataDirectory,
      announce: () => undefined,
    });
    const failure = new Error("private route failure marker");
    const throwingCore = {
      ...runtime.core,
      setup: {
        ...runtime.core.setup,
        listSeasons() {
          throw failure;
        },
      },
    } as CoreRuntime;
    const reported: unknown[] = [];
    const app = createApp({
      core: throwingCore,
      onUnexpectedError: (error) => reported.push(error),
    });

    const response = await app.request("/signup/host");
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Service temporarily unavailable");
    expect(html).not.toContain(failure.message);
    expect(html).not.toContain("Error:");
    expect(reported).toEqual([failure]);
    runtime.close();
  });

  it("refuses to boot with the public placeholder configured", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-placeholder-boot-"),
    );

    await expect(
      createRuntime({
        env: { PORCHFEST_SESSION_SECRET: SESSION_SECRET_PLACEHOLDER },
        dataDirectory,
      }),
    ).rejects.toThrow(/placeholder/i);
  });
});

describe("configured request origin guard", () => {
  it("keeps the loopback healthcheck reachable", async () => {
    const runtime = await createProxyTestRuntime("1");

    const response = await runtime.request("http://127.0.0.1:9398/health", {
      headers: { host: "127.0.0.1:9398" },
    });

    expect(response.status).toBe(200);
  });

  it("accepts the external HTTPS origin reported by a trusted proxy", async () => {
    const runtime = await createProxyTestRuntime("1");

    const response = await runtime.request("http://app.sapporchfest.org/", {
      headers: {
        host: "app.sapporchfest.org",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(200);
  });

  it("uses one canonical protocol value for a multi-proxy deployment", async () => {
    const runtime = await createProxyTestRuntime("2");

    const response = await runtime.request("http://app.sapporchfest.org/", {
      headers: {
        host: "app.sapporchfest.org",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(200);
  });

  it("preserves an external port that the internal scheme would normalize away", async () => {
    const runtime = await createProxyTestRuntime(
      "1",
      "https://app.sapporchfest.org:80",
    );

    const response = await runtime.request("http://app.sapporchfest.org:80/", {
      headers: {
        host: "app.sapporchfest.org:80",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(200);
  });

  it("refuses an ambiguous forwarded protocol value", async () => {
    const runtime = await createProxyTestRuntime("1");

    const response = await runtime.request("http://app.sapporchfest.org/", {
      headers: {
        host: "app.sapporchfest.org",
        "x-forwarded-proto": "http, https",
      },
    });

    expect(response.status).toBe(421);
  });

  it("ignores a spoofed forwarded protocol when no proxy is trusted", async () => {
    const runtime = await createProxyTestRuntime("0");

    const response = await runtime.request("http://app.sapporchfest.org/", {
      headers: {
        host: "app.sapporchfest.org",
        "x-forwarded-proto": "https",
      },
    });

    expect(response.status).toBe(421);
  });
});
