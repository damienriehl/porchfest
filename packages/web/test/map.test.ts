import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VENUES_MAP_SCHEMA_VERSION,
  validateVenuesMapDocument,
  type VenuesMapDocument,
} from "@porchfest/map";
import {
  createTestingRuntime,
  type PorchfestRuntime,
  type PorchfestTestingRuntime,
} from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function boot(): Promise<PorchfestTestingRuntime> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-map-route-"));
  temporaryRoots.push(dataDirectory);
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "map-route-test-secret",
    },
    announce: () => undefined,
  });
  runtimes.push(runtime);
  return runtime;
}

function createSeason(runtime: PorchfestTestingRuntime, openSignups = true) {
  return runtime.core.setup.createSeason({
    year: 2036,
    displayName: "Synthetic Map Season",
    timezone: "UTC",
    eventDate: "2036-09-13",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [
      { startsAt: "18:00", endsAt: "19:00" },
      { startsAt: "19:00", endsAt: "20:00" },
    ],
    localityName: "Example Borough",
    bounds: { north: 11, south: 10, east: 21, west: 20 },
    openSignups,
  }).season;
}

function createVenue(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  title: string,
  address: string,
  marker = "public-map",
) {
  return runtime.core.seasons.createHostSignup({
    seasonId,
    contact: {
      name: `${marker}-host-name`,
      email: `${marker}-host@example.invalid`,
      phone: `${marker}-phone`,
    },
    venue: {
      title,
      address,
      spaceDescription: "Synthetic porch",
      hasPower: true,
      requestedActNames: `${marker}-requested-act`,
      genrePreferences: "Folk",
      rainBackup: false,
      notes: `${marker}-venue-organizer-note`,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
}

function createAct(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  name = "Synthetic Map Act",
  marker = "public-map",
) {
  return runtime.core.seasons.createPerformerSignup({
    seasonId,
    contact: {
      name: `${marker}-act-contact`,
      email: `${marker}-act@example.invalid`,
      phone: `${marker}-act-phone`,
    },
    act: {
      name,
      genre: "Folk / Jazz",
      description: "A synthetic neighborhood set.",
      links:
        "https://artist.example.invalid/listen javascript:alert(1) ftp://artist.example.invalid/file http://artist.example.invalid/about",
      durationMinutes: 45,
      requiresAmplification: false,
      housePreference: `${marker}-house-preference`,
      sharedMemberNote: `${marker}-shared-member-note`,
      canLendGear: false,
      notes: `${marker}-act-organizer-note`,
    },
    availabilities: [],
  });
}

function assignedPublishedFixture(runtime: PorchfestTestingRuntime) {
  const season = createSeason(runtime);
  const signup = createVenue(
    runtime,
    season.id,
    "Aurora Porch",
    "101 Aurora Way",
  );
  const performer = createAct(runtime, season.id);
  const slot = runtime.core.seasons.ensureVenueSlots(signup.venue.id)[0]!;
  runtime.core.seasons.assignSlot(slot.id, slot.version, performer.act.id);
  runtime.core.geocoding.verifyVenueCoordinate(
    signup.venue.id,
    { latitude: 10.5, longitude: 20.5 },
    null,
    signup.venue.version,
  );
  const locked = runtime.core.seasons.transitionSeason(
    season.id,
    runtime.core.seasons.getSeason(season.id).version,
    "locked",
  );
  runtime.core.seasons.publishSeasonMap(locked.id, null, locked.version);
  return { seasonId: season.id, signup, performer, slot };
}

async function mapDocument(runtime: PorchfestRuntime) {
  const response = await runtime.request(`${PUBLIC_BASE_URL}/map/data.json`);
  const text = await response.text();
  return { response, text, document: JSON.parse(text) as VenuesMapDocument };
}

describe("public map page and data (U9)", () => {
  it("R16 serves a working honest map page for an unconfigured deployment", async () => {
    const runtime = await boot();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/map`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('class="porchfest-map-mount"');
    expect(html).toContain('class="porchfest-map-canvas"');
    expect(html).toMatch(/no map is published yet/i);
    expect(html).toContain('data-map-url="/map/data.json"');
    expect(html).toContain("leaflet@1.9.4");
    expect(html).toContain("integrity=");
    expect(response.headers.get("content-security-policy")).toContain(
      "https://unpkg.com",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "https://tile.openstreetmap.org",
    );
  });

  it("R16 emits a pinned-schema-valid empty document with public caching and no cookie", async () => {
    const runtime = await boot();

    const { response, document } = await mapDocument(runtime);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(document.schema_version).toBe(VENUES_MAP_SCHEMA_VERSION);
    expect(document.venues).toEqual([]);
    expect(validateVenuesMapDocument(document)).toMatchObject({ ok: true });
  });

  it.each([
    "setup",
    "signups_open",
    "signups_closed",
    "assigning",
    "archived",
  ] as const)(
    "R16/R28 serves no venue data while the current season is %s",
    async (targetState) => {
      const runtime = await boot();
      const season = createSeason(runtime, targetState !== "setup");
      let current = runtime.core.seasons.getSeason(season.id);
      if (targetState !== current.state) {
        current = runtime.core.seasons.transitionSeason(
          season.id,
          current.version,
          targetState,
        );
      }
      const { document } = await mapDocument(runtime);
      expect(document.venues).toEqual([]);
      expect(validateVenuesMapDocument(document).ok).toBe(true);
    },
  );

  it("R16/R28 serves no venue data for an unpublished locked season", async () => {
    const runtime = await boot();
    const season = createSeason(runtime);
    runtime.core.seasons.transitionSeason(season.id, season.version, "locked");

    const { document } = await mapDocument(runtime);

    expect(document.venues).toEqual([]);
    expect(validateVenuesMapDocument(document).ok).toBe(true);
  });

  it("R16 validates and emits only assigned acts at verified venues", async () => {
    const runtime = await boot();
    assignedPublishedFixture(runtime);

    const { response, document } = await mapDocument(runtime);

    expect(response.status).toBe(200);
    expect(validateVenuesMapDocument(document)).toMatchObject({ ok: true });
    expect(document).toMatchObject({
      schema_version: VENUES_MAP_SCHEMA_VERSION,
      season: 2036,
      generated_from: "packages/web/src/routes/map.ts",
      event: {
        date: "2036-09-13",
        time: "6:00–8:00 PM",
        city: "Exampleton",
        state: "WI",
      },
      venues: [
        {
          title: "Aurora Porch",
          address: "101 Aurora Way",
          lat: 10.5,
          lng: 20.5,
          schedule: "6:00–7:00 PM",
          acts: [
            {
              slot: "1",
              slot_label: "6:00–7:00 PM",
              slot_start: "18:00:00Z",
              slot_end: "19:00:00Z",
              name: "Synthetic Map Act",
              genre: "Folk / Jazz",
              description: "A synthetic neighborhood set.",
              links: [
                { url: "https://artist.example.invalid/listen" },
                { url: "http://artist.example.invalid/about" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("R22 serializes from the public allowlist and never emits participant PII", async () => {
    const runtime = await boot();
    assignedPublishedFixture(runtime);

    const { text, document } = await mapDocument(runtime);

    expect(Object.keys(document.venues[0] ?? {}).sort()).toEqual([
      "acts",
      "address",
      "lat",
      "lng",
      "schedule",
      "title",
    ]);
    expect(Object.keys(document.venues[0]?.acts[0] ?? {}).sort()).toEqual([
      "description",
      "genre",
      "links",
      "name",
      "slot",
      "slot_end",
      "slot_label",
      "slot_start",
    ]);
    for (const forbidden of [
      "public-map-host-name",
      "public-map-host@example.invalid",
      "public-map-phone",
      "public-map-venue-organizer-note",
      "public-map-requested-act",
      "public-map-act-contact",
      "public-map-act@example.invalid",
      "public-map-act-phone",
      "public-map-act-organizer-note",
      "public-map-house-preference",
      "public-map-shared-member-note",
      "javascript:alert(1)",
      "ftp://artist.example.invalid/file",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/contact|email|phone|organizer[_ -]?note/i);
  });

  it("R25 omits held slots and R16 omits venues with no assigned act", async () => {
    const runtime = await boot();
    const season = createSeason(runtime);
    const held = createVenue(
      runtime,
      season.id,
      "Held Stage",
      "201 Aurora Way",
      "held",
    );
    const empty = createVenue(
      runtime,
      season.id,
      "Empty Stage",
      "202 Aurora Way",
      "empty",
    );
    const heldSlot = runtime.core.seasons.ensureVenueSlots(held.venue.id)[0]!;
    runtime.core.seasons.holdSlot(heldSlot.id, heldSlot.version, {
      heldForName: "Unsigned Synthetic Act",
      decideBy: new Date("2036-09-01T00:00:00.000Z"),
    });
    for (const [venue, coordinate] of [
      [held.venue, { latitude: 10.4, longitude: 20.4 }],
      [empty.venue, { latitude: 10.6, longitude: 20.6 }],
    ] as const) {
      runtime.core.geocoding.verifyVenueCoordinate(
        venue.id,
        coordinate,
        null,
        venue.version,
      );
    }
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    runtime.core.seasons.publishSeasonMap(locked.id, null, locked.version);

    const { document, text } = await mapDocument(runtime);

    expect(document.venues).toEqual([]);
    expect(text).not.toContain("Unsigned Synthetic Act");
    expect(text).not.toContain("201 Aurora Way");
    expect(text).not.toContain("202 Aurora Way");
  });

  it("R16/AE2 removes a withdrawn act and its now-empty venue", async () => {
    const runtime = await boot();
    const fixture = assignedPublishedFixture(runtime);
    const act = runtime.core.seasons.getAct(fixture.performer.act.id);

    runtime.core.seasons.setRecordStatus(
      "act",
      act.id,
      act.version,
      "withdrawn",
    );
    const { document, text } = await mapDocument(runtime);

    expect(document.venues).toEqual([]);
    expect(text).not.toContain("101 Aurora Way");
  });

  it("R29/AE10 hides a needs-review coordinate until it is verified again", async () => {
    const runtime = await boot();
    const fixture = assignedPublishedFixture(runtime);
    let venue = runtime.core.seasons.getVenue(fixture.signup.venue.id);

    runtime.core.seasons.updateVenue(venue.id, venue.version, {
      address: "102 Aurora Way",
    });
    expect((await mapDocument(runtime)).document.venues).toEqual([]);

    venue = runtime.core.seasons.getVenue(venue.id);
    runtime.core.geocoding.verifyVenueCoordinate(
      venue.id,
      { latitude: 10.55, longitude: 20.55 },
      null,
      venue.version,
    );
    const { document } = await mapDocument(runtime);
    expect(document.venues).toMatchObject([
      { address: "102 Aurora Way", lat: 10.55, lng: 20.55 },
    ]);
  });

  it("returns 500, logs schema reasons, and serves no partial document on validation failure", async () => {
    const runtime = await boot();
    const season = createSeason(runtime);
    const signup = createVenue(runtime, season.id, "", "301 Aurora Way");
    const performer = createAct(runtime, season.id, "Invalid Fixture Act");
    const slot = runtime.core.seasons.ensureVenueSlots(signup.venue.id)[0]!;
    runtime.core.seasons.assignSlot(slot.id, slot.version, performer.act.id);
    runtime.core.geocoding.verifyVenueCoordinate(
      signup.venue.id,
      { latitude: 10.5, longitude: 20.5 },
      null,
      signup.venue.version,
    );
    const locked = runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "locked",
    );
    runtime.core.seasons.publishSeasonMap(locked.id, null, locked.version);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await runtime.request(`${PUBLIC_BASE_URL}/map/data.json`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe("Map data is temporarily unavailable.");
    expect(text).not.toContain("301 Aurora Way");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/venues-map validation failed.*title/i),
    );
  });

  it("serves the platform map assets and keeps the data URL configurable", async () => {
    const runtime = await boot();

    const script = await runtime.request(
      `${PUBLIC_BASE_URL}/map/assets/porchfest-map.js`,
    );
    const stylesheet = await runtime.request(
      `${PUBLIC_BASE_URL}/map/assets/porchfest-map.css`,
    );
    const source = await script.text();

    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(source).toContain("data-map-url");
    expect(source).toContain("/data/venues-2026.json");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
  });
});
