import type { GeoPort, LocateOutcome, LocateRequest } from "@porchfest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
  type PorchfestTestingRuntime,
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

class FakeGeoPort implements GeoPort {
  readonly name = "synthetic-geo";
  readonly configured = true;
  readonly requests: LocateRequest[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly outcomes: Readonly<Record<string, LocateOutcome>>,
  ) {}

  async locate(request: LocateRequest): Promise<LocateOutcome> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    return (
      this.outcomes[request.address] ?? {
        kind: "unavailable",
        reason: "No synthetic outcome was configured.",
      }
    );
  }

  async geocode(request: LocateRequest) {
    const outcome = await this.locate(request);
    return outcome.kind === "located" ? outcome.candidate : null;
  }
}

async function boot(geo?: GeoPort) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-coordinates-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "coordinate-route-test-secret",
    },
    adapterOverrides: geo ? { geo } : undefined,
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);
  const bootstrapToken =
    announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const signInPage = await runtime.request(
    `${PUBLIC_BASE_URL}/admin/sign-in?token=${bootstrapToken}`,
  );
  const signInCsrf = tokenFrom(await signInPage.text());
  const signedIn = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
    method: "POST",
    headers: formHeaders(),
    body: new URLSearchParams({
      _csrf: signInCsrf,
      token: bootstrapToken,
      display_name: "Synthetic Organizer",
      email: "organizer@example.invalid",
    }),
  });
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
  const season = runtime.core.setup.createSeason({
    year: 2037,
    displayName: "Synthetic Coordinate Season",
    timezone: "UTC",
    eventDate: "2037-09-12",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [{ startsAt: "18:00", endsAt: "19:00" }],
    localityName: "Example Borough",
    bounds: { north: 11, south: 10, east: 21, west: 20 },
    openSignups: true,
  }).season;
  return { runtime, cookie, season };
}

function createVenue(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  title: string,
  address: string,
) {
  return runtime.core.seasons.createHostSignup({
    seasonId,
    contact: {
      name: `${title} Host`,
      email: `${title.toLowerCase().replaceAll(" ", "-")}@example.invalid`,
    },
    venue: {
      title,
      address,
      spaceDescription: "Synthetic porch",
      hasPower: true,
      rainBackup: false,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  }).venue;
}

function formHeaders(cookie = "") {
  return {
    origin: PUBLIC_BASE_URL,
    ...(cookie ? { cookie } : {}),
    "content-type": "application/x-www-form-urlencoded",
  };
}

async function page(
  runtime: PorchfestRuntime,
  cookie: string,
  seasonId: number,
) {
  return runtime.request(`${PUBLIC_BASE_URL}/seasons/${seasonId}/coordinates`, {
    headers: { cookie },
  });
}

function tokenFrom(html: string, action?: string): string {
  const scope = action
    ? (html.match(
        new RegExp(
          `<form[^>]+action="${action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]*?</form>`,
        ),
      )?.[0] ?? "")
    : html;
  return scope.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

function located(
  latitude: number,
  longitude: number,
  precision: "parcel" | "house" | "street" = "parcel",
): LocateOutcome {
  return {
    kind: "located",
    candidate: {
      latitude,
      longitude,
      precision,
      interpolated: false,
      ref: "synthetic/provider-row",
    },
    crossCheck: precision === "house" ? { latitude, longitude } : null,
    reason: "Synthetic provider result.",
  };
}

describe("organizer coordinate review and map publication (U9)", () => {
  it("refuses unauthenticated coordinate GET and POST requests", async () => {
    const { runtime, season } = await boot();
    const getResponse = await runtime.request(
      `${PUBLIC_BASE_URL}/seasons/${season.id}/coordinates`,
    );
    const postResponse = await runtime.request(
      `${PUBLIC_BASE_URL}/seasons/${season.id}/coordinates/geocode`,
      { method: "POST", headers: formHeaders(), body: new URLSearchParams() },
    );

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
  });

  it("shows every non-verified row with candidate details and rejection meanings", async () => {
    const geo = new FakeGeoPort({
      "11 Review Row": located(10.4, 20.4, "street"),
      "12 Pending Row": { kind: "not-found", reason: "No result." },
    });
    const { runtime, cookie, season } = await boot(geo);
    const review = createVenue(
      runtime,
      season.id,
      "Review Porch",
      "11 Review Row",
    );
    const pending = createVenue(
      runtime,
      season.id,
      "Pending Porch",
      "12 Pending Row",
    );
    await runtime.core.geocoding.geocodeVenue(review.id, null);
    await runtime.core.geocoding.geocodeVenue(pending.id, null);

    const response = await page(runtime, cookie, season.id);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.match(/Example Borough: north 11/g)).toHaveLength(1);
    expect(html).toContain("Review Porch");
    expect(html).toContain("10.4, 20.4");
    expect(html).toContain("only precise to the street level");
    expect(html).toContain("Pending Porch");
    expect(html).toContain("could not locate the address");
  });

  it("verifies an inside-box pin so its row leaves the list", async () => {
    const geo = new FakeGeoPort({
      "21 Candidate Way": located(10.3, 20.3, "street"),
    });
    const { runtime, cookie, season } = await boot(geo);
    const venue = createVenue(
      runtime,
      season.id,
      "Candidate Porch",
      "21 Candidate Way",
    );
    await runtime.core.geocoding.geocodeVenue(venue.id, null);
    const before = await page(runtime, cookie, season.id);
    const html = await before.text();
    const action = `/seasons/${season.id}/coordinates/${venue.id}/verify`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        latitude: "10.6",
        longitude: "20.6",
        version: String(runtime.core.seasons.getVenue(venue.id).version),
      }),
    });
    expect(response.status).toBe(303);
    const after = await page(runtime, cookie, season.id);
    expect(await after.text()).not.toContain("Candidate Porch");
    expect(runtime.core.geocoding.publishableCoordinate(venue.id)).toEqual({
      latitude: 10.6,
      longitude: 20.6,
    });
  });

  it("refuses an outside-box pin and names the box", async () => {
    const geo = new FakeGeoPort({
      "31 Outside Way": located(10.3, 20.3, "street"),
    });
    const { runtime, cookie, season } = await boot(geo);
    const venue = createVenue(
      runtime,
      season.id,
      "Outside Porch",
      "31 Outside Way",
    );
    await runtime.core.geocoding.geocodeVenue(venue.id, null);
    const before = await page(runtime, cookie, season.id);
    const html = await before.text();
    const action = `/seasons/${season.id}/coordinates/${venue.id}/verify`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        latitude: "12",
        longitude: "22",
        version: String(runtime.core.seasons.getVenue(venue.id).version),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(
      /outside the Example Borough bounding box/i,
    );
    expect(runtime.core.geocoding.publishableCoordinate(venue.id)).toBeNull();
  });

  it("geocodes a season sequentially, reports every result kind, and skips verified venues", async () => {
    const geo = new FakeGeoPort({
      "41 Stored Way": located(10.2, 20.2),
      "42 Review Way": located(10.3, 20.3, "street"),
      "43 Unavailable Way": {
        kind: "unavailable",
        reason: "Synthetic provider outage.",
      },
    });
    const { runtime, cookie, season } = await boot(geo);
    const verified = createVenue(
      runtime,
      season.id,
      "Verified Porch",
      "40 Verified Way",
    );
    createVenue(runtime, season.id, "Stored Porch", "41 Stored Way");
    createVenue(runtime, season.id, "Review Porch", "42 Review Way");
    createVenue(runtime, season.id, "Unavailable Porch", "43 Unavailable Way");
    const preserved = createVenue(
      runtime,
      season.id,
      "Preserved Porch",
      "44 Preserved Way",
    );
    runtime.core.geocoding.verifyVenueCoordinate(
      verified.id,
      { latitude: 10.5, longitude: 20.5 },
      null,
      verified.version,
    );
    runtime.core.geocoding.verifyVenueCoordinate(
      preserved.id,
      { latitude: 10.6, longitude: 20.6 },
      null,
      preserved.version,
    );
    const preservedCurrent = runtime.core.seasons.getVenue(preserved.id);
    runtime.core.seasons.updateVenue(preserved.id, preservedCurrent.version, {
      address: "45 Preserved Edit Way",
    });

    const before = await page(runtime, cookie, season.id);
    const html = await before.text();
    const action = `/seasons/${season.id}/coordinates/geocode`;
    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });
    const resultHtml = await response.text();

    expect(response.status).toBe(200);
    expect(resultHtml).toContain(
      "stored 1; cached 0; preserved 1; needs review 1; unavailable 1",
    );
    expect(geo.maxActive).toBe(1);
    expect(geo.requests.map((request) => request.address)).toEqual([
      "41 Stored Way",
      "42 Review Way",
      "43 Unavailable Way",
    ]);
  });

  it("names GEO_PROVIDER and disables season geocoding when unconfigured", async () => {
    const { runtime, cookie, season } = await boot();
    const response = await page(runtime, cookie, season.id);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Geocoding is not configured");
    expect(html).toContain("GEO_PROVIDER");
    expect(html).toMatch(/<button[^>]+disabled[^>]*>Geocode this season/);
  });

  it("publishes and unpublishes from the locked coordinate screen only", async () => {
    const { runtime, cookie, season } = await boot();
    let response = await page(runtime, cookie, season.id);
    let html = await response.text();
    expect(html).not.toContain(`/seasons/${season.id}/map/publish`);
    expect(html).toContain("Publication controls appear only");

    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    response = await page(runtime, cookie, season.id);
    html = await response.text();
    expect(html).toContain("Not published");
    expect(html).toContain('href="/map"');
    expect(html).toContain('href="/map/data.json"');
    const publishAction = `/seasons/${season.id}/map/publish`;
    response = await runtime.request(`${PUBLIC_BASE_URL}${publishAction}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, publishAction),
        version: String(locked.version),
      }),
    });
    expect(response.status).toBe(303);
    expect(
      runtime.core.seasons.getSeason(season.id).mapPublishedAt,
    ).not.toBeNull();

    response = await page(runtime, cookie, season.id);
    html = await response.text();
    const unpublishAction = `/seasons/${season.id}/map/unpublish`;
    expect(html).toContain("Unpublish map");
    expect(html).toMatch(/Published at<\/dt><dd>\d{4}-\d{2}-\d{2}T/);
    response = await runtime.request(`${PUBLIC_BASE_URL}${unpublishAction}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, unpublishAction),
        version: String(runtime.core.seasons.getSeason(season.id).version),
      }),
    });
    expect(response.status).toBe(303);
    expect(runtime.core.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
  });
});
