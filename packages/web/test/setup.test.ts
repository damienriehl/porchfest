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

async function csrfFor(
  runtime: PorchfestRuntime,
  cookie: string,
  path = "/admin/setup",
) {
  const page = await runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    headers: { cookie },
  });
  return (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

async function setupCsrf(runtime: PorchfestRuntime, cookie: string) {
  return csrfFor(runtime, cookie);
}

function completeSetup(csrf: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    _csrf: csrf,
    display_name: "SAP Porchfest 2027",
    year: "2027",
    event_date: "2027-09-11",
    event_city: "Exampleton",
    event_state: "WI",
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

function submitSeason(
  runtime: PorchfestRuntime,
  cookie: string,
  path: string,
  body: URLSearchParams,
  origin = PUBLIC_BASE_URL,
) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      origin,
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

  it("does not offer a per-season retention window", async () => {
    const { runtime, cookie } = await bootAndSignIn();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/setup`, {
      headers: { cookie },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain('name="retention_days"');
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

  it("redirects setup to the seasons page after the first season exists", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(csrf));

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/setup`, {
      headers: { cookie },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/seasons");
  });

  it("refuses a repeated stale first-run submission without adding a season", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);
    const body = completeSetup(csrf);

    const first = await submitSetup(runtime, cookie, body);
    const stale = await submitSetup(runtime, cookie, completeSetup(csrf));

    expect(first.status).toBe(303);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain(
      "first season has already been created",
    );
    expect(runtime.core.setup.seasonCount()).toBe(1);
  });

  it("allows only one of two first-run tabs to create a season", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const responses = await Promise.all([
      submitSetup(runtime, cookie, completeSetup(csrf)),
      submitSetup(
        runtime,
        cookie,
        completeSetup(csrf, { display_name: "Other tab", year: "2028" }),
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      303, 409,
    ]);
    expect(runtime.core.setup.seasonCount()).toBe(1);
  });

  it("lists seasons and opens another through a distinct creation route", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const firstCsrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(firstCsrf));

    const seasons = await runtime.request(`${PUBLIC_BASE_URL}/admin/seasons`, {
      headers: { cookie },
    });
    const seasonsHtml = await seasons.text();
    expect(seasons.status).toBe(200);
    expect(seasonsHtml).toContain("SAP Porchfest 2027");
    expect(seasonsHtml).toContain("Accepting signups (signups_open)");
    expect(seasonsHtml).toContain('href="/admin/seasons/new"');
    expect(seasonsHtml).toContain("Open another season");

    const newSeason = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/seasons/new`,
      { headers: { cookie } },
    );
    const newSeasonHtml = await newSeason.text();
    expect(newSeason.status).toBe(200);
    expect(newSeasonHtml).toContain("Open another season");
    expect(newSeasonHtml).toContain('action="/admin/seasons/new"');
    const csrf = newSeasonHtml.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

    const created = await submitSeason(
      runtime,
      cookie,
      "/admin/seasons/new",
      completeSetup(csrf, {
        display_name: "SAP Porchfest 2028",
        year: "2028",
        event_date: "2028-09-09",
      }),
    );

    expect(created.status).toBe(303);
    expect(runtime.core.setup.seasonCount()).toBe(2);
    expect(runtime.core.seasons.getSeason(2).displayName).toBe(
      "SAP Porchfest 2028",
    );
  });

  it("requires confirmation before opening another season in an existing year", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const firstCsrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(firstCsrf));
    const csrf = await csrfFor(runtime, cookie, "/admin/seasons/new");

    const refused = await submitSeason(
      runtime,
      cookie,
      "/admin/seasons/new",
      completeSetup(csrf, { display_name: "Second 2027 season" }),
    );
    const refusedHtml = await refused.text();
    expect(refused.status).toBe(422);
    expect(refusedHtml).toContain("Confirm that you want another 2027 season");
    expect(refusedHtml).toContain('name="confirm_duplicate_year"');
    expect(runtime.core.setup.seasonCount()).toBe(1);

    const confirmed = await submitSeason(
      runtime,
      cookie,
      "/admin/seasons/new",
      completeSetup(csrf, {
        display_name: "Second 2027 season",
        confirm_duplicate_year: "yes",
      }),
    );

    expect(confirmed.status).toBe(303);
    expect(runtime.core.setup.seasonCount()).toBe(2);
  });

  it("protects both season-creation mutations with sign-in, Origin, and CSRF", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const setupToken = await setupCsrf(runtime, cookie);

    const signedOut = await submitSeason(
      runtime,
      "",
      "/admin/setup",
      completeSetup(setupToken),
    );
    expect(signedOut.status).toBe(401);

    const wrongOrigin = await submitSeason(
      runtime,
      cookie,
      "/admin/setup",
      completeSetup(setupToken),
      "https://unrelated.example",
    );
    expect(wrongOrigin.status).toBe(403);

    const missingCsrf = await submitSeason(
      runtime,
      cookie,
      "/admin/setup",
      completeSetup(""),
    );
    expect(missingCsrf.status).toBe(403);
    expect(runtime.core.setup.seasonCount()).toBe(0);

    await submitSetup(runtime, cookie, completeSetup(setupToken));
    const additionalToken = await csrfFor(
      runtime,
      cookie,
      "/admin/seasons/new",
    );
    const additionalWrongOrigin = await submitSeason(
      runtime,
      cookie,
      "/admin/seasons/new",
      completeSetup(additionalToken, { year: "2028" }),
      "https://unrelated.example",
    );
    const additionalMissingCsrf = await submitSeason(
      runtime,
      cookie,
      "/admin/seasons/new",
      completeSetup("", { year: "2028" }),
    );
    const additionalSignedOut = await submitSeason(
      runtime,
      "",
      "/admin/seasons/new",
      completeSetup(additionalToken, { year: "2028" }),
    );

    expect(additionalWrongOrigin.status).toBe(403);
    expect(additionalMissingCsrf.status).toBe(403);
    expect(additionalSignedOut.status).toBe(401);
    expect(runtime.core.setup.seasonCount()).toBe(1);
  });

  it("stores every R34 field the organizer entered", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);
    await submitSetup(runtime, cookie, completeSetup(csrf));

    const season = runtime.core.seasons.getSeason(1);
    expect(season.displayName).toBe("SAP Porchfest 2027");
    expect(season.timezone).toBe("America/Chicago");
    expect(season.eventDate).toBe("2027-09-11");
    expect(season.eventCity).toBe("Exampleton");
    expect(season.eventState).toBe("WI");
    expect(season.localityName).toBe("Saint Anthony Park");
    expect(season.boundsNorth).toBeCloseTo(44.99);
    expect(season.publicMapUrl).toContain("sapporchfest.example/map");
    expect(season.senderEmail).toBe("organizers@example.invalid");
    expect(season.retentionDays).toBeNull();
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

  it.each([
    ["event_city", "event city"],
    ["event_state", "event state"],
  ])("refuses blank required map metadata in %s", async (field, message) => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { [field]: "   " }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain(message);
    expect(runtime.core.setup.seasonCount()).toBe(0);
  });

  it("refuses locality text without a word or number", async () => {
    const { runtime, cookie } = await bootAndSignIn();
    const csrf = await setupCsrf(runtime, cookie);

    const response = await submitSetup(
      runtime,
      cookie,
      completeSetup(csrf, { locality_name: "---" }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("word or number");
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
