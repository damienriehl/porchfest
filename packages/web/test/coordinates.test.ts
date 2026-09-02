import {
  CORE_DATABASE_FILENAME,
  type GeoPort,
  type LocateOutcome,
  type LocateRequest,
} from "@porchfest/core";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
  type PorchfestTestingRuntime,
} from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
    private readonly outcomes: Readonly<Record<string, LocateOutcome | Error>>,
  ) {}

  async locate(request: LocateRequest): Promise<LocateOutcome> {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    const configured = this.outcomes[request.address];
    if (configured instanceof Error) throw configured;
    return (
      configured ?? {
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

class BlockingGeoPort implements GeoPort {
  readonly name = "blocking-geo";
  readonly configured = true;
  private releaseLocate!: () => void;
  private signalStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.signalStarted = resolve;
  });

  async locate(_request: LocateRequest): Promise<LocateOutcome> {
    this.signalStarted();
    await new Promise<void>((resolve) => {
      this.releaseLocate = resolve;
    });
    return { kind: "unavailable", reason: "Synthetic release." };
  }

  release(): void {
    this.releaseLocate();
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
  return { runtime, cookie, season, dataDirectory };
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

function makePublishable(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  title = "Publishable Porch",
) {
  const venue = createVenue(runtime, seasonId, title, "51 Publishable Way");
  const performer = runtime.core.seasons.createPerformerSignup({
    seasonId,
    contact: {
      name: "Publishable Performer",
      email: "publishable-performer@example.invalid",
    },
    act: {
      name: "Publishable Act",
      genre: "Synthetic",
      description: "A publishable synthetic set.",
      links: "",
      durationMinutes: 45,
      requiresAmplification: false,
      housePreference: null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [],
  });
  const slot = runtime.core.seasons.ensureVenueSlots(venue.id)[0]!;
  runtime.core.seasons.assignSlot(slot.id, slot.version, performer.act.id);
  runtime.core.geocoding.verifyVenueCoordinate(
    venue.id,
    { latitude: 10.5, longitude: 20.5 },
    null,
    venue.version,
  );
  return venue;
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

  it("offers manual coordinate entry with no geocoder and verifies an inside-box pin", async () => {
    const { runtime, cookie, season } = await boot();
    const venue = createVenue(
      runtime,
      season.id,
      "Manual Coordinate Porch",
      "15 Manual Way",
    );
    const before = await page(runtime, cookie, season.id);
    const html = await before.text();
    const action = `/seasons/${season.id}/coordinates/${venue.id}/verify`;

    expect(html).toContain("Manual coordinate entry and review");
    expect(html).toContain("Manual Coordinate Porch");
    expect(html).toContain(`action="${action}"`);

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        latitude: "10.75",
        longitude: "20.75",
        version: String(venue.version),
      }),
    });

    expect(response.status).toBe(303);
    expect(runtime.core.geocoding.publishableCoordinate(venue.id)).toEqual({
      latitude: 10.75,
      longitude: 20.75,
    });
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
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Candidate Porch");
    expect(afterHtml.split("Coordinates needing review")[1]).not.toContain(
      "Candidate Porch",
    );
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
    const withdrawn = createVenue(
      runtime,
      season.id,
      "Withdrawn Porch",
      "46 Withdrawn Way",
    );
    const replacement = createVenue(
      runtime,
      season.id,
      "Replacement Porch",
      "47 Replacement Way",
    );
    const superseded = createVenue(
      runtime,
      season.id,
      "Superseded Porch",
      "48 Superseded Way",
    );
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
    runtime.core.seasons.setRecordStatus(
      "venue",
      withdrawn.id,
      withdrawn.version,
      "withdrawn",
    );
    runtime.core.seasons.supersedeVenue(
      superseded.id,
      superseded.version,
      replacement.id,
    );

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
      "stored 1; cached 0; preserved 1; needs review 1; unavailable 2",
    );
    expect(geo.maxActive).toBe(1);
    expect(geo.requests.map((request) => request.address)).toEqual([
      "41 Stored Way",
      "42 Review Way",
      "43 Unavailable Way",
      "47 Replacement Way",
    ]);
  });

  it("stops and reports a legacy invalid locality as a configuration fault", async () => {
    const geo = new FakeGeoPort({
      "49 Legacy Way": new TypeError(
        "localityName must contain a word or number.",
      ),
    });
    const { runtime, cookie, season } = await boot(geo);
    createVenue(runtime, season.id, "Legacy Locality Porch", "49 Legacy Way");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const before = await page(runtime, cookie, season.id);
    const html = await before.text();
    const action = `/seasons/${season.id}/coordinates/geocode`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("localityName must contain a word or number");
    expect(text).toContain("Season settings &amp; state");
    expect(text).toContain("stored 0; cached 0; preserved 0");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /season 1 geocoding configuration fault.*localityName/i,
      ),
    );
  });

  it("continues after the last completed venue when a later locality is invalid", async () => {
    const outcomes: Record<string, LocateOutcome | Error> = {
      "50 First Way": {
        kind: "unavailable",
        reason: "Synthetic transient outage.",
      },
      "51 Invalid Way": new TypeError(
        "localityName must contain a word or number.",
      ),
      "52 Last Way": located(10.2, 20.2),
    };
    const geo = new FakeGeoPort(outcomes);
    const { runtime, cookie, season } = await boot(geo);
    const firstVenue = createVenue(
      runtime,
      season.id,
      "First Porch",
      "50 First Way",
    );
    createVenue(runtime, season.id, "Invalid Porch", "51 Invalid Way");
    createVenue(runtime, season.id, "Last Porch", "52 Last Way");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const action = `/seasons/${season.id}/coordinates/geocode`;
    const html = await (await page(runtime, cookie, season.id)).text();

    const first = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });
    const firstHtml = await first.text();

    expect(first.status).toBe(409);
    expect(firstHtml).toContain(`name="after" value="${firstVenue.id}"`);
    outcomes["51 Invalid Way"] = located(10.3, 20.3);

    const second = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(firstHtml, action),
        after: String(firstVenue.id),
      }),
    });

    expect(second.status).toBe(200);
    expect(geo.requests.map((request) => request.address)).toEqual([
      "50 First Way",
      "51 Invalid Way",
      "51 Invalid Way",
      "52 Last Way",
    ]);
  });

  it("caps one season geocoding submission at 20 venues and reports the remainder", async () => {
    const outcomes: Record<string, LocateOutcome> = {};
    for (let index = 1; index <= 25; index += 1) {
      const address = `${index} Batch Way`;
      outcomes[address] =
        index <= 20
          ? { kind: "unavailable", reason: "Synthetic transient outage." }
          : located(10.2, 20.2);
    }
    const geo = new FakeGeoPort(outcomes);
    const { runtime, cookie, season } = await boot(geo);
    for (let index = 1; index <= 25; index += 1) {
      createVenue(
        runtime,
        season.id,
        `Batch Porch ${index}`,
        `${index} Batch Way`,
      );
    }
    const action = `/seasons/${season.id}/coordinates/geocode`;
    const html = await (await page(runtime, cookie, season.id)).text();

    const first = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });

    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("5 venues remain — run again");
    expect(geo.requests).toHaveLength(20);

    const second = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(firstHtml, action),
        after: firstHtml.match(/name="after" value="(\d+)"/)?.[1] ?? "",
      }),
    });
    expect(second.status).toBe(200);
    expect(geo.requests).toHaveLength(25);
    expect(geo.requests.slice(20).map((request) => request.address)).toEqual([
      "21 Batch Way",
      "22 Batch Way",
      "23 Batch Way",
      "24 Batch Way",
      "25 Batch Way",
    ]);
  });

  it("refuses a concurrent geocoding submission for the same season", async () => {
    const geo = new BlockingGeoPort();
    const { runtime, cookie, season } = await boot(geo);
    createVenue(runtime, season.id, "Blocking Porch", "50 Blocking Way");
    const action = `/seasons/${season.id}/coordinates/geocode`;
    const html = await (await page(runtime, cookie, season.id)).text();
    const body = new URLSearchParams({ _csrf: tokenFrom(html, action) });
    const first = runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body,
    });
    await geo.started;

    const second = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });

    expect(second.status).toBe(409);
    expect(await second.text()).toContain("Geocoding is already running");
    geo.release();
    expect((await first).status).toBe(200);
  });

  it("returns within the request budget while keeping the season guard", async () => {
    const geo = new BlockingGeoPort();
    const { runtime, cookie, season } = await boot(geo);
    createVenue(runtime, season.id, "Slow Porch", "53 Slow Way");
    const action = `/seasons/${season.id}/coordinates/geocode`;
    const html = await (await page(runtime, cookie, season.id)).text();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });
    await geo.started;
    await vi.advanceTimersByTimeAsync(45_000);

    const response = await first;
    expect(response.status).toBe(409);
    expect(await response.text()).toContain(
      "provider is still finishing the current venue",
    );
    const second = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({ _csrf: tokenFrom(html, action) }),
    });
    expect(second.status).toBe(409);
    expect(await second.text()).toContain("Geocoding is already running");
    geo.release();
  });

  it("requires an address before a review pin can be verified", async () => {
    const geo = new FakeGeoPort({
      "51 Candidate Way": located(10.3, 20.3, "street"),
    });
    const { runtime, cookie, season } = await boot(geo);
    const venue = createVenue(
      runtime,
      season.id,
      "Addressless Porch",
      "51 Candidate Way",
    );
    await runtime.core.geocoding.geocodeVenue(venue.id, null);
    const before = await page(runtime, cookie, season.id);
    const beforeHtml = await before.text();
    const action = `/seasons/${season.id}/coordinates/${venue.id}/verify`;
    const token = tokenFrom(beforeHtml, action);
    const current = runtime.core.seasons.getVenue(venue.id);
    runtime.core.seasons.updateVenue(current.id, current.version, {
      address: null,
    });

    const review = await page(runtime, cookie, season.id);
    const reviewHtml = await review.text();
    expect(reviewHtml).toContain("Add an address before verifying this pin");
    expect(tokenFrom(reviewHtml, action)).toBe("");

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: token,
        latitude: "10.4",
        longitude: "20.4",
        version: String(runtime.core.seasons.getVenue(venue.id).version),
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain(
      "Add an address before verifying its pin",
    );
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

    makePublishable(runtime, season.id);
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
        event_city: "Exampleton",
        event_state: "WI",
      }),
    });
    expect(response.status).toBe(303);
    expect(
      runtime.core.seasons.getSeason(season.id).mapPublishedAt,
    ).not.toBeNull();
    expect(
      (await runtime.request(`${PUBLIC_BASE_URL}/map/data.json`)).status,
    ).toBe(200);

    response = await page(runtime, cookie, season.id);
    html = await response.text();
    const unpublishAction = `/seasons/${season.id}/map/unpublish`;
    expect(html).toContain("Unpublish map");
    expect(html).toMatch(/Published at<\/dt><dd>\d{4}-\d{2}-\d{2}T/);
    expect(html).toContain(
      "Published; the public map will serve it from 1 January 2037 (UTC)",
    );
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

  it("renders migrated publication sentinels as empty fields and names the missing field", async () => {
    const { runtime, cookie, season, dataDirectory } = await boot();
    makePublishable(runtime, season.id);
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    const sqlite = new Database(join(dataDirectory, CORE_DATABASE_FILENAME));
    sqlite
      .prepare(
        "update seasons set event_city = 'Unconfigured', event_state = 'Unconfigured' where id = ?",
      )
      .run(season.id);
    sqlite.close();
    const action = `/seasons/${season.id}/map/publish`;
    const html = await (await page(runtime, cookie, season.id)).text();

    expect(html).toContain('name="event_city" required value=""');
    expect(html).toContain('name="event_state" required value=""');
    expect(html).not.toContain('value="Unconfigured"');

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        version: String(locked.version),
        event_city: "Exampleton",
        event_state: "",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Event state");
  });

  it("refuses publication when no venue has both an assigned act and verified coordinate", async () => {
    const { runtime, cookie, season } = await boot();
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    const html = await (await page(runtime, cookie, season.id)).text();
    const action = `/seasons/${season.id}/map/publish`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        version: String(locked.version),
        event_city: "Exampleton",
        event_state: "WI",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain(
      "No venue has a verified coordinate and an assigned act",
    );
    expect(runtime.core.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
  });

  it("names an empty-title venue when schema preflight refuses publication", async () => {
    const { runtime, cookie, season } = await boot();
    makePublishable(runtime, season.id, "");
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    const html = await (await page(runtime, cookie, season.id)).text();
    const action = `/seasons/${season.id}/map/publish`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        version: String(locked.version),
        event_city: "Exampleton",
        event_state: "WI",
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(text).toContain("Venue &quot;(empty title)&quot;");
    expect(text).toMatch(/title.*must NOT have fewer than 1 characters/i);
    expect(runtime.core.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
  });

  it("names a legacy null event date when preflight refuses publication", async () => {
    const { runtime, cookie, season, dataDirectory } = await boot();
    makePublishable(runtime, season.id);
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    const sqlite = new Database(join(dataDirectory, CORE_DATABASE_FILENAME));
    sqlite
      .prepare("update seasons set event_date = null where id = ?")
      .run(season.id);
    sqlite.close();
    const html = await (await page(runtime, cookie, season.id)).text();
    const action = `/seasons/${season.id}/map/publish`;

    const response = await runtime.request(`${PUBLIC_BASE_URL}${action}`, {
      method: "POST",
      headers: formHeaders(cookie),
      body: new URLSearchParams({
        _csrf: tokenFrom(html, action),
        version: String(locked.version),
        event_city: "Exampleton",
        event_state: "WI",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/event date.*format/i);
    expect(runtime.core.seasons.getSeason(season.id).mapPublishedAt).toBeNull();
  });
});
