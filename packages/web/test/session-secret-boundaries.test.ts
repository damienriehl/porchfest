import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSessionSecret,
  SESSION_SECRET_FILENAME,
  SESSION_SECRET_PLACEHOLDER,
} from "../src/config/session-secret.js";
import { createRuntime } from "../src/composition.js";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "porchfest-secret-boundaries-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("session-secret persistence boundaries", () => {
  it("uses explicit configuration without creating a directory or reading an existing generated file", async () => {
    const directory = join(await root(), "absent");
    expect(
      await loadSessionSecret({
        dataDirectory: directory,
        configuredSecret: "synthetic-configured-value",
      }),
    ).toBe("synthetic-configured-value");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(directory);
    await writeFile(
      join(directory, SESSION_SECRET_FILENAME),
      SESSION_SECRET_PLACEHOLDER,
    );
    expect(
      await loadSessionSecret({
        dataDirectory: directory,
        configuredSecret: "override",
      }),
    ).toBe("override");
    expect(
      await readFile(join(directory, SESSION_SECRET_FILENAME), "utf8"),
    ).toBe(SESSION_SECRET_PLACEHOLDER);
  });

  it.each(["", " \n\t", SESSION_SECRET_PLACEHOLDER])(
    "refuses a corrupt generated secret (%#) without overwriting it",
    async (value) => {
      const directory = await root();
      const path = join(directory, SESSION_SECRET_FILENAME);
      await writeFile(path, value);
      await expect(
        loadSessionSecret({ dataDirectory: directory }),
      ).rejects.toThrow("Refusing to start");
      expect(await readFile(path, "utf8")).toBe(value);
    },
  );

  it("refuses an explicitly empty configured value before creating storage", async () => {
    const directory = join(await root(), "absent");
    await expect(
      loadSessionSecret({ dataDirectory: directory, configuredSecret: "" }),
    ).rejects.toThrow("PORCHFEST_SESSION_SECRET is empty");
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads surrounding whitespace from generated files without rewriting them", async () => {
    const directory = await root();
    const path = join(directory, SESSION_SECRET_FILENAME);
    await writeFile(path, " \n synthetic-secret \t\n");
    expect(await loadSessionSecret({ dataDirectory: directory })).toBe(
      "synthetic-secret",
    );
    expect(await readFile(path, "utf8")).toBe(" \n synthetic-secret \t\n");
  });

  it("creates nested private storage and persists a 32-byte random value", async () => {
    const directory = join(await root(), "new", "nested");
    const value = await loadSessionSecret({ dataDirectory: directory });
    expect(Buffer.from(value, "base64url")).toHaveLength(32);
    expect(
      await readFile(join(directory, SESSION_SECRET_FILENAME), "utf8"),
    ).toBe(value + "\n");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(directory, SESSION_SECRET_FILENAME))).mode & 0o777,
    ).toBe(0o600);
  });

  it("propagates a generated-secret path that is a directory without replacing it", async () => {
    const directory = await root();
    const path = join(directory, SESSION_SECRET_FILENAME);
    await mkdir(path);
    await expect(
      loadSessionSecret({ dataDirectory: directory }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it("reuses the generated secret across complete runtime close and restart", async () => {
    const directory = await root();
    const announced: string[] = [];
    let token = "";
    let csrf = "";
    const first = await createRuntime({
      dataDirectory: directory,
      env: { PUBLIC_BASE_URL: "https://porchfest.example" },
      announce: (message) => announced.push(message),
    });
    try {
      token = announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
      const page = await first.request(
        "https://porchfest.example/admin/sign-in?token=" + token,
      );
      csrf =
        (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
      expect(token).not.toBe("");
      expect(csrf).not.toBe("");
    } finally {
      first.close();
    }
    const original = await readFile(
      join(directory, SESSION_SECRET_FILENAME),
      "utf8",
    );
    const second = await createRuntime({
      dataDirectory: directory,
      env: { PUBLIC_BASE_URL: "https://porchfest.example" },
      announce: () => {},
    });
    try {
      const response = await second.request(
        "https://porchfest.example/admin/sign-in",
        {
          method: "POST",
          headers: {
            origin: "https://porchfest.example",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            _csrf: csrf,
            token,
            display_name: "Restart Organizer",
            email: "restart@example.invalid",
          }),
        },
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).toContain("porchfest");
      expect(second.core.access.countActiveOrganizers()).toBe(1);
      expect(
        await readFile(join(directory, SESSION_SECRET_FILENAME), "utf8"),
      ).toBe(original);
    } finally {
      second.close();
    }
  });
});
