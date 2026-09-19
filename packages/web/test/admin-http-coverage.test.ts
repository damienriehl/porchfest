import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  findSeason,
  notFound,
  positiveInteger,
  readFields,
  redirect,
  unauthorized,
} from "../src/routes/admin-http.js";
import { createTestingRuntime } from "../src/composition.js";

describe("shared admin HTTP boundaries", () => {
  it.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "Infinity",
    "NaN",
    "9007199254740992",
    "twelve",
  ])("rejects invalid positive identifier %s", (raw) => {
    expect(positiveInteger(raw)).toBeNull();
  });
  it.each(["1", " 42 ", "9007199254740991"])(
    "accepts safe positive identifier %s",
    (raw) => {
      expect(positiveInteger(raw)).toBe(Number(raw));
    },
  );
  it("parses a real multipart HTTP request without trimming or prototype inheritance", async () => {
    const app = new Hono();
    app.post("/fields", async (context) => {
      const fields = await readFields(context);
      expect(Object.getPrototypeOf(fields)).toBeNull();
      return context.json(fields);
    });
    const form = new FormData();
    form.append("notes", "  original wording  ");
    form.append("notes", "second value");
    form.append("attachment", new File(["ignored"], "synthetic.txt"));
    form.append("attachment", "first text after file");
    form.append("__proto__", "literal data");
    form.append("constructor", "literal constructor");
    form.append("empty", "");
    const response = await app.request("http://localhost/fields", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const fields = await response.json();
    expect(fields).toEqual(
      JSON.parse(
        '{"notes":"  original wording  ","attachment":"first text after file","__proto__":"literal data","constructor":"literal constructor","empty":""}',
      ),
    );
  });
  it("parses an empty urlencoded form as an empty record", async () => {
    const app = new Hono();
    app.post("/fields", async (context) =>
      context.json(await readFields(context)),
    );
    const response = await app.request("http://localhost/fields", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(await response.json()).toEqual({});
  });
  it("marks redirects noncacheable and prevents POST replay on refresh", async () => {
    const response = redirect("/admin/records?season=4");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/records?season=4");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(await response.text()).toBe("");
  });
  it("returns distinct unauthorized JSON and domain-specific not-found text", async () => {
    const denied = unauthorized();
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-type")).toBe("application/json");
    expect(denied.headers.get("cache-control")).toContain("no-store");
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    const missing = notFound("No such participant.");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toContain("no-store");
    expect(await missing.text()).toBe("No such participant.");
    expect(await notFound().text()).toBe("No such season.");
  });
  it("resolves a persisted season through the real core repository and handles missing IDs", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-admin-http-"),
    );
    const runtime = await createTestingRuntime({
      dataDirectory,
      env: { PORCHFEST_SESSION_SECRET: "synthetic-admin-http-test-secret" },
      announce: () => undefined,
    });
    try {
      const { season } = runtime.core.setup.createSeason({
        year: 2031,
        displayName: "Synthetic season",
        timezone: "UTC",
        eventDate: "2031-06-01",
        eventCity: "Exampleton",
        eventState: "WI",
        timeSlots: [],
        openSignups: true,
      });
      expect(findSeason(runtime.core, String(season.id))).toEqual(season);
      expect(findSeason(runtime.core, "99999")).toBeNull();
      expect(findSeason(runtime.core, "-1")).toBeNull();
      expect(findSeason(runtime.core, undefined)).toBeNull();
    } finally {
      runtime.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
