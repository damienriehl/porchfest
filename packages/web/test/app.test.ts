import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/composition.js";
import { SESSION_SECRET_PLACEHOLDER } from "../src/config/session-secret.js";

describe("application scaffold", () => {
  it("boots with an empty configuration and serves health", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-empty-config-"),
    );
    const runtime = await createRuntime({ env: {}, dataDirectory });

    const response = await runtime.request("/health");

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
      { method: "GET", path: "/admin", tier: "organizer" },
      { method: "GET", path: "/admin/sign-in", tier: "public" },
      { method: "POST", path: "/admin/sign-in", tier: "public" },
      { method: "GET", path: "/admin/setup", tier: "organizer" },
      { method: "POST", path: "/admin/setup", tier: "organizer" },
      { method: "GET", path: "/admin/seasons", tier: "organizer" },
      { method: "GET", path: "/admin/seasons/new", tier: "organizer" },
      { method: "POST", path: "/admin/seasons/new", tier: "organizer" },
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
