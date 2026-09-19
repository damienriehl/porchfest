import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizedHttpUrl, tokenizeLinks } from "../src/routes/http-links.js";
import { createTestingRuntime } from "../src/composition.js";

describe("participant website URL boundaries", () => {
  it.each([null, "", " \n\r\t "])(
    "returns no links for empty input %s",
    (value) => {
      expect(tokenizeLinks(value)).toEqual([]);
    },
  );
  it("splits mixed whitespace without destroying punctuation inside links", () => {
    expect(
      tokenizeLinks(
        " https://example.invalid/?x=1&y=2\n\thttp://other.invalid/a,b \r\nhttps://third.invalid/#part ",
      ),
    ).toEqual([
      "https://example.invalid/?x=1&y=2",
      "http://other.invalid/a,b",
      "https://third.invalid/#part",
    ]);
  });
  it.each([
    ["HTTPS://EXAMPLE.INVALID:443", "https://example.invalid/"],
    ["http://EXAMPLE.INVALID:80/path", "http://example.invalid/path"],
    ["https://example.invalid/a/../music", "https://example.invalid/music"],
    ["https://example.invalid/a b", "https://example.invalid/a%20b"],
    [
      "https://example.invalid/?a=1&b=2#music",
      "https://example.invalid/?a=1&b=2#music",
    ],
  ])("normalizes accepted URL %s", (input, expected) => {
    expect(normalizedHttpUrl(input)).toBe(expected);
  });
  it.each([
    "",
    "artist.example.invalid",
    "/music",
    "//example.invalid",
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:artist@example.invalid",
    "ftp://example.invalid/music",
    "https://",
    "https://example.invalid:99999",
  ])("rejects non-web or malformed URL %s", (value) => {
    expect(normalizedHttpUrl(value)).toBeNull();
  });
  it("normalizes valid legacy links and omits bad tokens through real persistence and map HTTP serialization", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-link-coverage-"),
    );
    const runtime = await createTestingRuntime({
      dataDirectory,
      env: {
        PUBLIC_BASE_URL: "https://festival.example.invalid",
        PORCHFEST_SESSION_SECRET: "synthetic-map-links-secret",
      },
      announce: () => undefined,
    });
    try {
      const { season } = runtime.core.setup.createSeason({
        year: 2020,
        displayName: "Synthetic link season",
        timezone: "UTC",
        eventDate: "2020-06-01",
        eventCity: "Exampleton",
        eventState: "WI",
        timeSlots: [{ startsAt: "18:00", endsAt: "19:00" }],
        bounds: { north: 11, south: 10, east: 21, west: 20 },
        openSignups: true,
      });
      const host = runtime.core.seasons.createHostSignup({
        seasonId: season.id,
        contact: {
          name: "Synthetic Host",
          email: "host@example.invalid",
          phone: null,
        },
        venue: {
          title: "Synthetic Porch",
          address: "Synthetic Test Address",
          spaceDescription: "Porch",
          hasPower: true,
          rainBackup: false,
          requestedActNames: null,
          genrePreferences: null,
          notes: null,
        },
        gear: [],
        drinks: [],
        amenities: [],
      });
      const performer = runtime.core.seasons.createPerformerSignup({
        seasonId: season.id,
        contact: {
          name: "Synthetic Performer",
          email: "performer@example.invalid",
          phone: null,
        },
        act: {
          name: "Synthetic Act",
          genre: "Folk",
          description: "Songs",
          links:
            " HTTPS://ARTIST.EXAMPLE.INVALID:443\n javascript:alert(1)\t/mail\nhttp://artist.example.invalid:80/a/../music ",
          durationMinutes: 45,
          requiresAmplification: false,
          housePreference: null,
          sharedMemberNote: null,
          canLendGear: false,
          notes: null,
        },
        availabilities: [],
      });
      const slot = runtime.core.seasons.ensureVenueSlots(host.venue.id)[0]!;
      runtime.core.seasons.assignSlot(slot.id, slot.version, performer.act.id);
      runtime.core.geocoding.verifyVenueCoordinate(
        host.venue.id,
        { latitude: 10.5, longitude: 20.5 },
        null,
        host.venue.version,
      );
      const locked = runtime.core.seasons.transitionSeason(
        season.id,
        runtime.core.seasons.getSeason(season.id).version,
        "locked",
      );
      runtime.core.seasons.publishSeasonMap(locked.id, locked.version, {
        eventCity: locked.eventCity,
        eventState: locked.eventState,
      });
      const response = await runtime.request(
        "https://festival.example.invalid/map/data.json",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        venues: [
          {
            acts: [
              {
                links: [
                  { url: "https://artist.example.invalid/" },
                  { url: "http://artist.example.invalid/music" },
                ],
              },
            ],
          },
        ],
      });
    } finally {
      runtime.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
