import { describe, expect, it } from "vitest";
import { extractParticipantLinks } from "../src/participant-links.js";

describe("participant link extraction", () => {
  it("normalizes HTTP(S), preserves useful residue, and drops placeholders", () => {
    expect(
      extractParticipantLinks(
        "Demo https://example.invalid/listen, summer recording",
        "n/a",
      ),
    ).toEqual({
      links: ["https://example.invalid/listen"],
      residue: ["Demo summer recording"],
      invalidUrls: [],
      nonHttpSchemes: [],
    });
  });

  it("reports non-HTTP schemes without treating them as structured links", () => {
    expect(extractParticipantLinks("javascript:alert(1)")).toMatchObject({
      links: [],
      residue: ["javascript:alert(1)"],
      nonHttpSchemes: ["javascript:"],
    });
  });
});
