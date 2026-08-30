import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  rankPairings,
  suggestionsForAct,
  suggestionsForVenue,
  type MatchingInput,
} from "../src/matching.js";

function fixture(): MatchingInput {
  const raw = JSON.parse(
    readFileSync(
      new URL("./fixtures/matching-season.json", import.meta.url),
      "utf8",
    ),
  ) as MatchingInput;
  return {
    ...raw,
    venues: raw.venues.map((venue) => ({
      ...venue,
      slots: venue.slots.map((slot) => ({
        ...slot,
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
      })),
    })),
    acts: raw.acts.map((act) => ({
      ...act,
      availabilities: act.availabilities.map((availability) => ({
        startsAt: new Date(availability.startsAt),
        endsAt: new Date(availability.endsAt),
      })),
    })),
  };
}

describe("deterministic matching", () => {
  it("prioritizes mutual and one-sided requests and explains every pairing", () => {
    const ranked = rankPairings(fixture());
    expect(ranked[0]?.act.name).toBe("The Porch Cats");
    expect(ranked[0]?.reasons.map(({ code }) => code)).toContain(
      "mutual_request",
    );
    const oneSided = ranked.find(({ act }) => act.name === "Solo Folk");
    expect(oneSided?.reasons.map(({ code }) => code)).toContain("host_request");
    expect(ranked.indexOf(oneSided!)).toBeGreaterThan(0);
    expect(
      ranked
        .find(({ act }) => act.name === "Solo Folk")
        ?.reasons.map(({ code }) => code),
    ).toContain("genre_fit");
    expect(ranked.every(({ reasons }) => reasons.length > 0)).toBe(true);
  });

  it("excludes unavailable inventory and ranks no-power amplification down", () => {
    const ranked = rankPairings(fixture());
    expect(ranked.some(({ slot }) => slot.state !== "open")).toBe(false);
    expect(ranked.some(({ act }) => act.name === "Already Booked")).toBe(false);
    expect(ranked.some(({ act }) => act.name === "Partial Window")).toBe(false);
    const oak = ranked.filter(({ venue }) => venue.id === 2);
    expect(oak.findIndex(({ act }) => act.name === "Solo Folk")).toBeLessThan(
      oak.findIndex(({ act }) => act.name === "Amped Friends"),
    );
    expect(
      oak
        .find(({ act }) => act.name === "Amped Friends")
        ?.warnings.map(({ code }) => code),
    ).toContain("no_power");
  });

  it("is stable after input shuffling and both filtered views agree", () => {
    const input = fixture();
    const first = rankPairings(input);
    const shuffled = rankPairings({
      timezone: input.timezone,
      venues: [...input.venues]
        .reverse()
        .map((venue) => ({ ...venue, slots: [...venue.slots].reverse() })),
      acts: [...input.acts].reverse(),
      assignments: [...input.assignments].reverse(),
    });
    const signature = (items: typeof first) =>
      items.map(({ act, slot, score, reasons, warnings }) => ({
        actId: act.id,
        slotId: slot.id,
        score,
        reasons,
        warnings,
      }));
    expect(signature(shuffled)).toEqual(signature(first));
    expect(signature(rankPairings(input))).toEqual(signature(first));

    const pairing = first[0]!;
    const fromVenue = suggestionsForVenue(input, pairing.venue.id).find(
      ({ act, slot }) =>
        act.id === pairing.act.id && slot.id === pairing.slot.id,
    );
    const fromAct = suggestionsForAct(input, pairing.act.id).find(
      ({ act, slot }) =>
        act.id === pairing.act.id && slot.id === pairing.slot.id,
    );
    expect(fromVenue).toMatchObject({
      score: pairing.score,
      reasons: pairing.reasons,
    });
    expect(fromAct).toMatchObject({
      score: pairing.score,
      reasons: pairing.reasons,
    });
  });

  it("warns about an overlapping linked act and ranks that pairing down", () => {
    const input = fixture();
    const ranked = rankPairings(input);
    const linked = ranked.find(
      ({ act, slot }) => act.name === "Amped Friends" && slot.id === 11,
    );
    expect(linked?.warnings.map(({ code }) => code)).toContain("shared_member");
    expect(linked?.warnings[0]?.text).toContain("Booked Friends");
    expect(linked?.warnings[0]?.text).toContain("Oak Avenue Stage");
    expect(linked?.warnings[0]?.text).toContain("1:00–2:00 PM");
    expect(linked?.warnings[0]?.text).not.toContain("UTC");
    const withoutLink: MatchingInput = {
      ...input,
      acts: input.acts.map((act) =>
        act.id === 103 ? { ...act, linkedActIds: [] } : act,
      ),
    };
    const unlinked = rankPairings(withoutLink).find(
      ({ act, slot }) => act.id === 103 && slot.id === 11,
    );
    expect(linked!.score).toBeLessThan(unlinked!.score);
  });

  it("warns when a linked act's continuation overlaps the candidate slot", () => {
    const input = fixture();
    input.assignments = [
      { actId: 104, slotId: 22 },
      { actId: 104, slotId: 21 },
    ];

    const linked = rankPairings(input).find(
      ({ act, slot }) => act.id === 103 && slot.id === 11,
    );

    expect(linked?.warnings).toContainEqual({
      code: "shared_member",
      text: "Booked Friends shares a member and plays at Oak Avenue Stage, 1:00–2:00 PM",
    });
  });

  it("explains availability in the season timezone", () => {
    const available = rankPairings(fixture()).find(
      ({ act, slot }) => act.id === 101 && slot.id === 11,
    );

    expect(
      available?.reasons.find(({ code }) => code === "available")?.text,
    ).toBe("Available 1:00–2:00 PM");
  });

  it("matches requested-name entries without short substring false positives", () => {
    const input = fixture();
    input.venues[0] = {
      ...input.venues[0]!,
      requestedActNames: "Joe",
    };
    input.venues[1] = {
      ...input.venues[1]!,
      requestedActNames: "Sam",
    };
    input.acts.push(
      {
        id: 107,
        name: "Banjoe Boys",
        genre: null,
        requiresAmplification: false,
        housePreference: null,
        availabilities: [],
        linkedActIds: [],
      },
      {
        id: 108,
        name: "Samantha Lee",
        genre: null,
        requiresAmplification: false,
        housePreference: null,
        availabilities: [],
        linkedActIds: [],
      },
    );

    const ranked = rankPairings(input);
    expect(
      ranked
        .find(({ act, venue }) => act.id === 107 && venue.id === 1)
        ?.reasons.map(({ code }) => code),
    ).not.toContain("host_request");
    expect(
      ranked
        .find(({ act, venue }) => act.id === 108 && venue.id === 2)
        ?.reasons.map(({ code }) => code),
    ).not.toContain("host_request");

    input.venues[0] = {
      ...input.venues[0]!,
      requestedActNames: "Unrelated, The Porch Cats and Solo Folk\nAnother Act",
    };
    const multiEntry = rankPairings(input);
    expect(
      multiEntry
        .find(({ act, venue }) => act.id === 101 && venue.id === 1)
        ?.reasons.map(({ code }) => code),
    ).toContain("mutual_request");
    expect(
      multiEntry
        .find(({ act, venue }) => act.id === 102 && venue.id === 1)
        ?.reasons.map(({ code }) => code),
    ).toContain("host_request");
  });

  it("uses whole-word, non-negated genre preferences", () => {
    const input = fixture();
    input.venues[0] = {
      ...input.venues[0]!,
      genrePreferences: "anything but country; no folk; norfolk sound; jazz",
    };
    input.acts.push({
      id: 109,
      name: "Country Fixture",
      genre: "Country",
      requiresAmplification: false,
      housePreference: null,
      availabilities: [],
      linkedActIds: [],
    });

    const codesFor = (actId: number) =>
      rankPairings(input)
        .find(({ act, venue }) => act.id === actId && venue.id === 1)
        ?.reasons.map(({ code }) => code);
    expect(codesFor(109)).not.toContain("genre_fit");
    expect(codesFor(102)).not.toContain("genre_fit");
    expect(codesFor(101)).toContain("genre_fit");
  });
});
