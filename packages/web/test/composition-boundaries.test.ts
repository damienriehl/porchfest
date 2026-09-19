import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAdapterSet,
  createRuntime,
  parsePublicBaseUrl,
  type PorchfestRuntime,
} from "../src/composition.js";

const roots: string[] = [];
const runtimes: PorchfestRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(
    join(tmpdir(), "porchfest-composition-boundaries-"),
  );
  roots.push(root);
  return root;
}
const env = {
  PORCHFEST_SESSION_SECRET: "synthetic-composition-boundary-secret",
};

describe("composition deployment boundaries", () => {
  it.each([undefined, "", "   "])(
    "treats absent origin %s as unconfigured",
    (value) => {
      expect(parsePublicBaseUrl(value)).toBeNull();
    },
  );
  it("canonicalizes a valid configured origin", () => {
    expect(parsePublicBaseUrl("  HTTPS://EXAMPLE.INVALID:443/  ")).toBe(
      "https://example.invalid",
    );
  });
  it.each([
    "/relative",
    "not a URL",
    "ftp://example.invalid",
    "https://user:password@example.invalid",
    "https://example.invalid/path",
    "https://example.invalid/?q=1",
    "https://example.invalid/#fragment",
  ])("rejects unsafe public origin %s", (value) => {
    expect(() => parsePublicBaseUrl(value)).toThrow(TypeError);
  });
  it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "refuses invalid trusted proxy count %s during boot",
    async (value) => {
      await expect(
        createRuntime({
          dataDirectory: await directory(),
          env: { ...env, PORCHFEST_TRUSTED_PROXY_HOPS: value },
          announce: () => undefined,
        }),
      ).rejects.toThrow("PORCHFEST_TRUSTED_PROXY_HOPS");
    },
  );
  it.each(["GEO_NOMINATIM_TIMEOUT_MS", "GEO_OVERPASS_TIMEOUT_MS"])(
    "validates %s without attempting network access",
    (name) => {
      for (const value of [
        "0",
        "-1",
        "0.5",
        "NaN",
        "Infinity",
        "9007199254740992",
      ]) {
        expect(() =>
          createAdapterSet(
            {},
            {
              GEO_PROVIDER: "osm",
              GEO_USER_AGENT: "synthetic test",
              [name]: value,
            },
          ),
        ).toThrow(`${name} must be a positive integer`);
      }
    },
  );
  it("rejects an unknown geo provider instead of disabling geocoding", () => {
    expect(() => createAdapterSet({}, { GEO_PROVIDER: "unknown" })).toThrow(
      "GEO_PROVIDER must be",
    );
  });
  it.each(["PORCHFEST_TURNSTILE_SITE_KEY", "PORCHFEST_TURNSTILE_SECRET_KEY"])(
    "refuses a lone Turnstile setting %s",
    (name) => {
      expect(() => createAdapterSet({}, { [name]: "synthetic" })).toThrow(
        "Turnstile needs both",
      );
    },
  );
  it("preserves the announcement failure and can reboot the same migrated database", async () => {
    const root = await directory();
    const failure = new Error("synthetic announcement failure");
    await expect(
      createRuntime({
        dataDirectory: root,
        env,
        announce: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const announcements: string[] = [];
    const runtime = await createRuntime({
      dataDirectory: root,
      env,
      announce: (message) => announcements.push(message),
    });
    runtimes.push(runtime);
    expect(runtime.core.access.countActiveOrganizers()).toBe(0);
    expect(announcements.join("\n")).toContain("/admin/sign-in?token=");
    const response = await runtime.request("/admin/sign-in");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bootstrap sign-in link");
  });
});
