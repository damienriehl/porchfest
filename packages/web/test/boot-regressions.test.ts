import { createSeasonRepository, type SeasonRepository } from "@porchfest/core";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createRuntime } from "../src/composition.js";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("boot regressions", () => {
  it("bootstraps with same-origin mutation protection when PUBLIC_BASE_URL is unset", async () => {
    const dataDirectory = await makeTemporaryRoot(
      "porchfest-unconfigured-origin-",
    );
    const announced: string[] = [];
    const runtime = await createRuntime({
      dataDirectory,
      env: {
        PORCHFEST_SESSION_SECRET: "unconfigured-origin-test-secret",
        PORCHFEST_TRUSTED_PROXY_HOPS: "1",
      },
      announce: (message) => announced.push(message),
    });

    try {
      const token =
        announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
      const signInPage = await runtime.request(
        `http://localhost/admin/sign-in?token=${token}`,
      );
      const signInHtml = await signInPage.text();
      const csrf = signInHtml.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
      const signedIn = await runtime.request("http://localhost/admin/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _csrf: csrf,
          token,
          display_name: "Local Organizer",
          email: "local@example.invalid",
        }),
      });

      expect(signedIn.status).toBe(303);
      expect(runtime.core.access.countActiveOrganizers()).toBe(1);

      const cookie =
        (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
      const organizersPage = await runtime.request(
        "http://localhost/admin/organizers",
        { headers: { cookie } },
      );
      const organizersHtml = await organizersPage.text();
      const inviteCsrf =
        organizersHtml.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
      const invite = await runtime.request(
        "http://localhost/admin/organizers/invite",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            host: "public.example:8443",
            origin: "https://public.example:8443",
            "sec-fetch-site": "same-origin",
            "x-forwarded-proto": "https",
          },
          body: new URLSearchParams({
            _csrf: inviteCsrf,
            email: "second-local@example.invalid",
          }),
        },
      );
      expect(await invite.text()).toContain(
        "https://public.example:8443/admin/sign-in?token=",
      );

      const setupPage = await runtime.request("http://localhost/admin/setup", {
        headers: { cookie },
      });
      const setupHtml = await setupPage.text();
      const setupCsrf =
        setupHtml.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
      const spoofedHost = await runtime.request(
        "http://localhost/admin/setup",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            host: "evil.example",
            origin: "http://evil.example",
            "sec-fetch-site": "cross-site",
          },
          body: new URLSearchParams({ _csrf: setupCsrf }),
        },
      );
      expect(spoofedHost.status).toBe(403);
      expect(runtime.core.setup.needsFirstRun()).toBe(true);
    } finally {
      runtime.close();
    }
  });

  it("boots with a configured secret when the data directory is absent", async () => {
    const root = await makeTemporaryRoot("porchfest-configured-secret-");
    const dataDirectory = join(root, "missing-data");

    const runtime = await createRuntime({
      dataDirectory,
      env: { PORCHFEST_SESSION_SECRET: "configured-test-secret" },
    });

    try {
      expect((await runtime.request("/health")).status).toBe(200);
    } finally {
      runtime.close();
    }
  });

  it("preserves the composition error when cleanup close also fails", async () => {
    const dataDirectory = await makeTemporaryRoot(
      "porchfest-close-error-preservation-",
    );
    const compositionError = new Error("composition failed");
    const closeError = new Error("close failed");
    const closeDatabase = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementationOnce(function (
      this: Database.Database,
    ) {
      closeDatabase.call(this);
      throw closeError;
    });

    await expect(
      createRuntime({
        dataDirectory,
        env: { PORCHFEST_SESSION_SECRET: "configured-test-secret" },
        get authorize(): never {
          throw compositionError;
        },
      }),
    ).rejects.toBe(compositionError);
  });

  it("exposes the gated season repository through the package entry point", async () => {
    const dataDirectory = await makeTemporaryRoot(
      "porchfest-season-repository-entry-",
    );
    const runtime = await createRuntime({ dataDirectory, env: {} });

    try {
      expect(createSeasonRepository).toBeTypeOf("function");
      expectTypeOf(runtime.core.seasons).toEqualTypeOf<SeasonRepository>();
      expect(runtime.core.seasons).toHaveProperty("getSeason");
      expect(runtime.core).not.toHaveProperty("database");
    } finally {
      runtime.close();
    }
  });
});
