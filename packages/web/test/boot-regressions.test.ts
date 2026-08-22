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
