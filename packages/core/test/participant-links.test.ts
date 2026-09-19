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

describe("participant link boundary normalization", () => {
  it("ignores non-string values and every supported whole-answer placeholder", () => {
    expect(
      extractParticipantLinks(
        undefined,
        null,
        12,
        {},
        [],
        "",
        " \t",
        "N/A",
        "na",
        "NONE",
        "-",
        "NO",
      ),
    ).toEqual({ links: [], residue: [], invalidUrls: [], nonHttpSchemes: [] });
  });

  it("deduplicates serialized URLs across fields while preserving their first order", () => {
    expect(
      extractParticipantLinks(
        "HTTPS://EXAMPLE.INVALID:443/a, https://second.example.invalid/path).",
        "https://example.invalid/a https://second.example.invalid/path",
      ),
    ).toEqual({
      links: [
        "https://example.invalid/a",
        "https://second.example.invalid/path",
      ],
      residue: [],
      invalidUrls: [],
      nonHttpSchemes: [],
    });
  });

  it("keeps invalid URLs available for boundary errors rather than discarding the answer", () => {
    expect(
      extractParticipantLinks("Listen https://[bad], then https://[bad]."),
    ).toEqual({
      links: [],
      residue: ["Listen https://[bad], then https://[bad]."],
      invalidUrls: ["https://[bad]"],
      nonHttpSchemes: [],
    });
  });

  it("detects case-insensitive non-HTTP schemes and deduplicates them", () => {
    expect(
      extractParticipantLinks(
        "MAILTO:act@example.invalid",
        "mailto:other@example.invalid FTP://example.invalid/song",
      ).nonHttpSchemes,
    ).toEqual(["mailto:", "ftp:"]);
  });

  it("retains meaningful prose and URL fragments without mistaking placeholders inside prose", () => {
    expect(
      extractParticipantLinks(
        "No recording yet",
        "Demo https://example.invalid/a?q=one#part ; acoustic\n recording",
      ),
    ).toEqual({
      links: ["https://example.invalid/a?q=one#part"],
      residue: ["No recording yet", "Demo ; acoustic recording"],
      invalidUrls: [],
      nonHttpSchemes: [],
    });
  });
});
