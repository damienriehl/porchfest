import { describe, expect, it } from "vitest";
import { escapeRegex } from "../src/strings.js";
import { rankPairings, type MatchingInput } from "../src/matching.js";

describe("literal regular expression escaping", () => {
  it.each([
    "",
    "ordinary words",
    ".*+?^${}()|[]\\",
    "C++",
    "[brackets]",
    "a.b",
    "(a+)+$",
    "🎺 café",
    "line\nbreak",
    "a/b-c",
  ])("matches only the complete literal input %j", (text) => {
    const expression = new RegExp(`^(?:${escapeRegex(text)})$`, "u");
    expect(expression.test(text)).toBe(true);
    expect(expression.test(`prefix${text}`)).toBe(false);
    expect(expression.test(`${text}suffix`)).toBe(false);
  });

  it("preserves metacharacters as literals through actual requested-act and genre ranking", () => {
    const input: MatchingInput = {
      timezone: "UTC",
      assignments: [],
      venues: [
        {
          id: 1,
          title: "Synthetic porch",
          hostName: null,
          hasPower: null,
          requestedActNames: "Please book A.B",
          genrePreferences: "We enjoy c++",
          slots: [
            {
              id: 1,
              venueId: 1,
              startsAt: new Date("2104-06-01T13:00Z"),
              endsAt: new Date("2104-06-01T14:00Z"),
              state: "open",
            },
          ],
        },
      ],
      acts: ["A.B", "AxB"].map((name, index) => ({
        id: index + 1,
        name,
        genre: index === 0 ? "c++" : "ccc",
        requiresAmplification: null,
        housePreference: null,
        availabilities: [],
        linkedActIds: [],
      })),
    };
    const ranked = rankPairings(input);
    expect(ranked.map((row) => [row.act.name, row.score])).toEqual([
      ["A.B", 3050],
      ["AxB", 0],
    ]);
    expect(ranked[0]!.reasons.map((reason) => reason.code)).toEqual([
      "host_request",
      "genre_fit",
      "availability_unstated",
    ]);
    expect(ranked[1]!.reasons.map((reason) => reason.code)).toEqual([
      "availability_unstated",
    ]);
  });

  it("does not throw on incomplete regex syntax supplied in participant names or preferences", () => {
    const input: MatchingInput = {
      timezone: "UTC",
      assignments: [],
      venues: [
        {
          id: 1,
          title: "Porch (",
          hostName: null,
          hasPower: null,
          requestedActNames: "[unfinished",
          genrePreferences: "[unfinished",
          slots: [
            {
              id: 1,
              venueId: 1,
              startsAt: new Date("2104-06-01T13:00Z"),
              endsAt: new Date("2104-06-01T14:00Z"),
              state: "open",
            },
          ],
        },
      ],
      acts: [
        {
          id: 1,
          name: "Other",
          genre: "[unfinished",
          requiresAmplification: null,
          housePreference: "Porch ( please",
          availabilities: [],
          linkedActIds: [],
        },
      ],
    };
    expect(rankPairings(input)[0]!.score).toBe(3050);
  });
});
