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
