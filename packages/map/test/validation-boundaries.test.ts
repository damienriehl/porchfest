import { describe, expect, it } from "vitest";
import { validateVenuesMapDocument } from "../src/validate.js";
import { makeVenuesMapDocument } from "./fixtures.js";

function errors(value: unknown) {
  const result = validateVenuesMapDocument(value);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected an invalid document");
  return result.errors;
}

describe("public map contract boundary integration", () => {
  it.each([null, [], "map", 42, false])(
    "rejects a non-document %j at the root",
    (value) => {
      expect(errors(value)).toContainEqual({
        path: "/",
        message: "must be object",
      });
    },
  );

  it("reports every independent nested failure and escapes JSON pointer property names", () => {
    const document = makeVenuesMapDocument();
    Object.assign(document.event, { "unexpected~/name": true });
    document.venues[0]!.lng = -181;
    document.venues[0]!.acts = [];
    const paths = errors(document).map(({ path }) => path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/event/unexpected~0~1name",
        "/venues/0/lng",
        "/venues/0/acts",
      ]),
    );
  });

  it.each([1999, 2027.5, "2027", null])(
    "rejects invalid season %j without coercion",
    (season) => {
      expect(errors({ ...makeVenuesMapDocument(), season })).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "/season" })]),
      );
    },
  );

  it.each(["slot_start", "slot_end"] as const)(
    "rejects invalid %s times",
    (field) => {
      const document = makeVenuesMapDocument();
      document.venues[0]!.acts[0]![field] = "25:00:00Z";
      expect(errors(document)).toContainEqual({
        path: `/venues/0/acts/0/${field}`,
        message: 'must match format "time"',
      });
    },
  );

  it("round-trips a sparse public document through JSON and the pinned schema without mutation", () => {
    const document = makeVenuesMapDocument({ season: 2000 });
    const venue = document.venues[0]!;
    venue.lat = -90;
    venue.lng = 180;
    Object.assign(venue.acts[0]!, {
      genre: "",
      description: "",
      links: [],
      note: "",
      slot_start: "13:00:00+01:00",
    });
    const parsed: unknown = JSON.parse(JSON.stringify(document));
    const before = structuredClone(parsed);
    const result = validateVenuesMapDocument(parsed);
    expect(result).toEqual({ ok: true, document });
    if (result.ok) expect(result.document).toBe(parsed);
    expect(parsed).toEqual(before);
  });

  it("keeps prior errors stable across subsequent cached-validator calls", () => {
    const first = errors({});
    const snapshot = structuredClone(first);
    expect(validateVenuesMapDocument(makeVenuesMapDocument()).ok).toBe(true);
    errors(null);
    expect(first).toEqual(snapshot);
    expect(first.map(({ path }) => path)).toEqual([
      "/schema_version",
      "/season",
      "/generated_from",
      "/event",
      "/venues",
    ]);
  });

  it("rejects additional fields inside acts and links", () => {
    const document = makeVenuesMapDocument();
    Object.assign(document.venues[0]!.acts[0]!, { internalNotes: "private" });
    Object.assign(document.venues[0]!.acts[0]!.links[0]!, { token: "fixture" });
    expect(errors(document).map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "/venues/0/acts/0/internalNotes",
        "/venues/0/acts/0/links/0/token",
      ]),
    );
  });
});
