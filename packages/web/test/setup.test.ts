// R34, end to end and for real: an empty database goes through first-run setup and
// comes out the other side as a season that accepts a public signup. That last
// clause is the requirement — a season row that exists but cannot take a signup
// would pass a weaker test and still be the failed install R34 describes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";

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

async function bootAndSignIn() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-setup-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "setup-test-session-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);

  const token = announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const signInPage = await runtime.request(
    `${PUBLIC_BASE_URL}/admin/sign-in?token=${token}`,
  );
  const csrf =
    (await signInPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  const signedIn = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
    method: "POST",
    headers: {
      origin: PUBLIC_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      _csrf: csrf,
      token,
      display_name: "Dana Organizer",
      email: "dana@example.invalid",
    }),
  });
  const cookie =
    (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  return { runtime, cookie };
}

async function setupCsrf(runtime: PorchfestRuntime, cookie: string) {
  const page = await runtime.request(`${PUBLIC_BASE_URL}/admin/setup`, {
    headers: { cookie },
  });
  return (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

function completeSetup(csrf: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    _csrf: csrf,
    display_name: "SAP Porchfest 2027",
    year: "2027",
    event_date: "2027-09-11",
    timezone: "America/Chicago",
    signup_opens_on: "2027-05-01",
    signup_closes_on: "2027-07-01",
    slot_start_1: "14:00",
    slot_end_1: "15:00",
    slot_start_2: "15:00",
    slot_end_2: "16:00",
    locality_name: "Saint Anthony Park",
    bounds_north: "44.99",
    bounds_south: "44.95",
    bounds_east: "-93.17",
    bounds_west: "-93.22",
    public_site_url: "https://sapporchfest.example",
    public_map_url: "https://sapporchfest.example/map",
    sender_name: "SAP Porchfest",
    sender_email: "organizers@example.invalid",
    retention_days: "540",
    open_signups: "yes",
    ...overrides,
  });
}

function submitSetup(
  runtime: PorchfestRuntime,
  cookie: string,
  body: URLSearchParams,
) {
  return runtime.request(`${PUBLIC_BASE_URL}/admin/setup`, {
    method: "POST",
    headers: {
      origin: PUBLIC_BASE_URL,
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("first-run setup", () => {
  it("sends an organizer with no season straight to setup", async () => {
    const { runtime, cookie } = await bootAndSignIn();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/setup");
  });

  it("takes an empty database to a season that accepts a public signup", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const created = await submitSetup(runtime, cookie, completeSetup(csrf));
    expect(created.status).toBe(303);

    // The requirement is not "a season row exists" — it is that a neighbour can
    // now sign up. Prove it through the public form.
    const form = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/host?season=1`,
    );
    expect(form.status).toBe(200);
    const signupCsrf =
      (await form.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

    const signup = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`, {
      method: "POST",
      headers: {
        origin: PUBLIC_BASE_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: signupCsrf,
        season_id: "1",
        contact_name: "Synthetic Host",
        contact_email: "host@example.invalid",
        venue_title: "The Test Porch",
        venue_address: "Synthetic Venue Address",
        space_description: "Front porch",
        has_power: "yes",
        rain_backup: "no",
        website: "",
      }),
    });

    expect(signup.status).toBe(201);
  });

  it("stores every R34 field the organizer entered", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(csrf));

    const season = runtime.core.seasons.getSeason(1);
    expect(season.displayName).toBe("SAP Porchfest 2027");
    expect(season.timezone).toBe("America/Chicago");
    expect(season.eventDate).toBe("2027-09-11");
    expect(season.localityName).toBe("Saint Anthony Park");
    expect(season.boundsNorth).toBeCloseTo(44.99);
    expect(season.publicMapUrl).toContain("sapporchfest.example/map");
    expect(season.senderEmail).toBe("organizers@example.invalid");
    expect(season.retentionDays).toBe(540);
    expect(runtime.core.setup.listTimeSlots(1)).toHaveLength(2);
  });

  it("reads the time slots in the season's own timezone", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(csrf));

    const [first] = runtime.core.setup.listTimeSlots(1);
    // 14:00 in Chicago on 2027-09-11 is 19:00Z. Reading it as UTC would put the
    // festival's first set five hours before it happens.
    expect(first?.startsAt.toISOString()).toBe("2027-09-11T19:00:00.000Z");
  });

  it("leaves the season closed when the organizer does not open signups", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { open_signups: "no" }),
    );

    expect(runtime.core.seasons.getSeason(1).state).toBe("setup");
    const form = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/host?season=1`,
    );
    expect(form.status).toBe(409);
  });
});

describe("setup refuses what it cannot honour", () => {
  it("refuses an invented timezone rather than defaulting to UTC", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { timezone: "Mars/Olympus" }),
    );

    // Defaulting here would silently shift every availability window a performer
    // later types — the exact U4 bug this column exists to prevent.
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("valid IANA timezone");
  });

  it("refuses a bounding box that is inside out", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { bounds_north: "44.90", bounds_south: "44.99" }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("north edge must be above");
  });

  it("refuses a partly-filled bounding box", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { bounds_east: "" }),
    );

    // Three quarters of a sanity check is not a sanity check.
    expect(response.status).toBe(422);
  });

  it("refuses a time slot that ends before it starts", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { slot_start_1: "16:00", slot_end_1: "14:00" }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("end after it starts");
  });

  it("refuses a signup window that closes before it opens", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, {
        signup_opens_on: "2027-07-01",
        signup_closes_on: "2027-05-01",
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("close after they open");
  });

  it("refuses a non-http public URL", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { public_site_url: "javascript:alert(1)" }),
    );

    expect(response.status).toBe(422);
  });

  it("keeps every answer on the page when it refuses one", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { timezone: "Mars/Olympus" }),
    );
    const html = await response.text();

    // This form is long. Losing it to one bad field is the failure the signup
    // forms already refuse to make.
    expect(html).toContain("SAP Porchfest 2027");
    expect(html).toContain("Saint Anthony Park");
    expect(html).toContain("44.99");
    expect(html).toContain("organizers@example.invalid");
  });

  it("refuses setup to someone who is not signed in", async () => {
    const { runtime } = await bootAndSignIn();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/setup`);

    expect(response.status).toBe(401);
  });
});
