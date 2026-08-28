import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
} from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function boot() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-lifecycle-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "season-lifecycle-test-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);

  const bootstrapToken =
    announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const signInPage = await runtime.request(
    `${PUBLIC_BASE_URL}/admin/sign-in?token=${bootstrapToken}`,
  );
  const signInCsrf =
    (await signInPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  const signedIn = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
    method: "POST",
    headers: {
      origin: PUBLIC_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      _csrf: signInCsrf,
      token: bootstrapToken,
      display_name: "Synthetic Organizer",
      email: "organizer@example.invalid",
    }),
  });
  const cookie =
    (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const { season } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "UTC",
    eventDate: "2031-09-13",
    timeSlots: [],
    openSignups: true,
  });
  const signup = runtime.core.seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "Synthetic Host", email: "host@example.invalid" },
    venue: {
      title: "Synthetic Porch",
      address: "1 Fixture Way",
      spaceDescription: "Front porch",
      hasPower: true,
      rainBackup: false,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
  return { runtime, cookie, season, signup };
}

async function get(runtime: PorchfestRuntime, path: string, cookie = "") {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

async function transition(
  runtime: PorchfestRuntime,
  cookie: string,
  seasonId: number,
  version: number,
  targetState: string,
  confirmation?: string,
) {
  const page = await get(runtime, `/admin/seasons/${seasonId}`, cookie);
  const csrf =
    (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  const body = new URLSearchParams({
    _csrf: csrf,
    version: String(version),
    target_state: targetState,
  });
  if (confirmation !== undefined) body.set("confirmation", confirmation);
  return runtime.request(
    `${PUBLIC_BASE_URL}/admin/seasons/${seasonId}/transition`,
    {
      method: "POST",
      headers: {
        origin: PUBLIC_BASE_URL,
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );
}

describe("organizer season lifecycle", () => {
  it("refuses unauthenticated GET and POST requests", async () => {
    const { runtime, season } = await boot();
    expect((await get(runtime, `/admin/seasons/${season.id}`)).status).toBe(
      401,
    );
    expect(
      (
        await runtime.request(
          `${PUBLIC_BASE_URL}/admin/seasons/${season.id}/transition`,
          {
            method: "POST",
            headers: {
              origin: PUBLIC_BASE_URL,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              version: String(season.version),
              target_state: "signups_closed",
            }),
          },
        )
      ).status,
    ).toBe(401);
  });

  it("shows derived stopped actions and moves through every remaining state", async () => {
    const { runtime, cookie, season } = await boot();
    const queue = await get(runtime, `/admin?season=${season.id}`, cookie);
    expect(await queue.text()).toContain(`/admin/seasons/${season.id}`);
    let page = await get(runtime, `/admin/seasons/${season.id}`, cookie);
    let html = await page.text();
    expect(html).toContain("Season settings &amp; state");
    expect(html).toMatch(
      /Moving to signups_closed stops allowing:[\s\S]*public signups/,
    );

    for (const target of [
      "signups_closed",
      "assigning",
      "locked",
      "archived",
    ] as const) {
      const current = runtime.core.seasons.getSeason(season.id);
      const response = await transition(
        runtime,
        cookie,
        season.id,
        current.version,
        target,
        target === "locked" || target === "archived" ? "confirmed" : undefined,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        `/admin/seasons/${season.id}?transitioned=1`,
      );
      page = await get(runtime, response.headers.get("location") ?? "", cookie);
      html = await page.text();
      expect(html).toContain(`Current state</dt><dd>${target}</dd>`);
      expect(html).toContain(`Season moved to ${target}.`);
      if (target === "assigning") {
        expect(html).toMatch(
          /Moving to locked stops allowing:[\s\S]*assigning acts to slots/,
        );
      }
    }
  });

  it("names backwards, stale, missing-confirmation, and unknown-state refusals", async () => {
    const { runtime, cookie, season } = await boot();

    let response = await transition(
      runtime,
      cookie,
      season.id,
      season.version,
      "assigning",
    );
    expect(response.status).toBe(303);
    let current = runtime.core.seasons.getSeason(season.id);

    response = await transition(
      runtime,
      cookie,
      season.id,
      current.version,
      "signups_open",
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain(
      "A season in state assigning cannot go back to signups_open",
    );

    const staleVersion = current.version;
    runtime.core.seasons.transitionSeason(season.id, current.version, "locked");
    response = await transition(
      runtime,
      cookie,
      season.id,
      staleVersion,
      "archived",
      "confirmed",
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/someone else changed the season/i);
    expect(runtime.core.seasons.getSeason(season.id).state).toBe("locked");

    current = runtime.core.seasons.getSeason(season.id);
    response = await transition(
      runtime,
      cookie,
      season.id,
      current.version,
      "archived",
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/confirm.*archived/i);
    expect(runtime.core.seasons.getSeason(season.id).state).toBe("locked");

    response = await transition(
      runtime,
      cookie,
      season.id,
      current.version,
      "future_state",
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Unknown season state &quot;future_state&quot;",
    );
  });

  it("requires confirmation for locking and makes archived records read-only", async () => {
    const { runtime, cookie, season, signup } = await boot();

    let current = runtime.core.seasons.getSeason(season.id);
    let response = await transition(
      runtime,
      cookie,
      season.id,
      current.version,
      "locked",
    );
    expect(response.status).toBe(400);
    expect(runtime.core.seasons.getSeason(season.id).state).toBe(
      "signups_open",
    );

    current = runtime.core.seasons.getSeason(season.id);
    response = await transition(
      runtime,
      cookie,
      season.id,
      current.version,
      "archived",
      "confirmed",
    );
    expect(response.status).toBe(303);

    const record = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      cookie,
    );
    const html = await record.text();
    expect(record.status).toBe(200);
    expect(html).toContain(
      "This season is archived. Records can no longer be changed.",
    );
    expect(html).not.toContain(
      `action="/admin/records/venue/${signup.venue.id}"`,
    );
  });

  it("refuses a CSRF-less mutation", async () => {
    const { runtime, cookie, season } = await boot();
    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/seasons/${season.id}/transition`,
      {
        method: "POST",
        headers: {
          origin: PUBLIC_BASE_URL,
          cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          version: String(season.version),
          target_state: "signups_closed",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(runtime.core.seasons.getSeason(season.id).state).toBe(
      "signups_open",
    );
  });
});
