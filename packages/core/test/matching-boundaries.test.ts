import { describe, expect, it } from "vitest";
import {
  formatZonedWindow,
  overlaps,
  rankPairings,
  suggestionsForAct,
  suggestionsForVenue,
  type MatchingInput,
} from "../src/matching.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import { openTestDatabase } from "./support/db.js";

const window = (start: string, end: string) => ({
  startsAt: new Date(`2105-09-12T${start}:00Z`),
  endsAt: new Date(`2105-09-12T${end}:00Z`),
});
function input(): MatchingInput {
  return {
    timezone: "UTC",
    assignments: [],
    venues: [
      {
        id: 1,
        title: "Porch",
        hostName: "Host",
        hasPower: null,
        requestedActNames: null,
        genrePreferences: null,
        slots: [
          { id: 10, venueId: 1, state: "open", ...window("11:00", "12:00") },
        ],
      },
    ],
    acts: [
      {
        id: 20,
        name: "Band",
        genre: null,
        requiresAmplification: true,
        housePreference: null,
        availabilities: [],
        linkedActIds: [],
      },
    ],
  };
}

describe("matching boundaries", () => {
  it("formats noon and midnight crossings with both distinct periods", () => {
    expect(formatZonedWindow(window("11:00", "12:00"), "UTC")).toBe(
      "11:00 AM–12:00 PM",
    );
    expect(
      formatZonedWindow(
        {
          startsAt: new Date("2105-09-12T23:30:00Z"),
          endsAt: new Date("2105-09-13T00:30:00Z"),
        },
        "UTC",
      ),
    ).toBe("11:30 PM–12:30 AM");
  });
  it("rejects an invalid timezone through the ranking chain", () => {
    expect(() =>
      rankPairings({ ...input(), timezone: "Invalid/Zone" }),
    ).toThrow(RangeError);
  });
  it("treats touching endpoints as nonoverlapping and containment as overlapping", () => {
    expect(overlaps(window("10:00", "11:00"), window("11:00", "12:00"))).toBe(
      false,
    );
    expect(overlaps(window("10:00", "13:00"), window("11:00", "12:00"))).toBe(
      true,
    );
    expect(overlaps(window("11:00", "12:00"), window("10:00", "13:00"))).toBe(
      true,
    );
  });
  it("does not combine disconnected availability windows to fill a slot", () => {
    const source = input();
    source.acts[0]!.availabilities = [
      window("10:00", "11:30"),
      window("11:45", "13:00"),
    ];
    expect(rankPairings(source)).toEqual([]);
    source.acts[0]!.availabilities = [window("11:00", "12:00")];
    expect(rankPairings(source)[0]!.reasons).toEqual([
      { code: "available", text: "Available 11:00 AM–12:00 PM" },
    ]);
    expect(rankPairings(source)[0]!.score).toBe(5);
  });
  it("returns empty filtered views for absent IDs and inventory", () => {
    expect(suggestionsForAct(input(), 999)).toEqual([]);
    expect(suggestionsForVenue(input(), 999)).toEqual([]);
    expect(rankPairings({ ...input(), acts: [] })).toEqual([]);
    expect(rankPairings({ ...input(), venues: [] })).toEqual([]);
  });
  it("ignores linked assignments whose act or slot is absent", () => {
    const source = input();
    source.acts[0]!.linkedActIds = [21, 22];
    source.assignments = [
      { actId: 21, slotId: 11 },
      { actId: 22, slotId: 999 },
    ];
    source.venues[0]!.slots.push({
      id: 11,
      venueId: 1,
      state: "assigned",
      ...window("11:00", "12:00"),
    });
    source.acts.push({
      ...source.acts[0]!,
      id: 22,
      name: "Other",
      linkedActIds: [],
    });
    expect(rankPairings(source)).toHaveLength(1);
    expect(rankPairings(source)[0]!.warnings).toEqual([]);
    expect(rankPairings(source)[0]!.score).toBe(0);
  });
  it("escapes punctuation in requested names without matching regex alternatives", () => {
    const source = input();
    source.acts[0]!.name = "Band (A+B)";
    source.venues[0]!.requestedActNames = "Band (A+B)";
    expect(rankPairings(source)[0]!.score).toBe(3000);
    source.acts[0]!.name = "Band AAAB";
    expect(rankPairings(source)[0]!.score).toBe(0);
  });
  it("ranks SQLite signup availability and removes a pairing after the real assignment persists", async () => {
    const database = await openTestDatabase("matching-chain-");
    try {
      const season = createSeasonSetup(database.db).createSeason({
        year: 2105,
        displayName: "Festival",
        timezone: "UTC",
        eventDate: "2105-09-12",
        eventCity: "Exampleton",
        eventState: "WI",
        openSignups: true,
        timeSlots: [{ startsAt: "11:00", endsAt: "12:00" }],
      }).season;
      const repository = createSeasonRepository(database.db);
      const host = repository.createHostSignup({
        seasonId: season.id,
        contact: { name: "Host" },
        venue: {
          title: "Porch",
          hasPower: true,
          requestedActNames: "Band",
          address: "100 Example St",
          spaceDescription: "Porch",
          rainBackup: false,
          notes: null,
        },
        gear: [],
        drinks: [],
        amenities: [],
      });
      const act = repository.createPerformerSignup({
        seasonId: season.id,
        contact: { name: "Performer" },
        act: {
          name: "Band",
          durationMinutes: 60,
          genre: "folk",
          description: "Synthetic act",
          links: "",
          canLendGear: false,
          notes: null,
          requiresAmplification: true,
          housePreference: "Host",
        },
        availabilities: [window("11:00", "12:00")],
      }).act;
      const suggestions = repository.suggestForVenue(host.venue.id);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]!.score).toBe(10025);
      expect(suggestions[0]!.reasons.map((reason) => reason.code)).toEqual([
        "mutual_request",
        "power_available",
        "available",
      ]);
      const slot = repository.listVenueSlots(host.venue.id)[0]!;
      repository.assignSlot(slot.id, slot.version, act.id);
      expect(repository.suggestForVenue(host.venue.id)).toEqual([]);
      expect(
        suggestionsForAct(repository.buildMatchingInput(season.id), act.id),
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });
});
