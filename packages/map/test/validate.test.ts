import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import type { VenuesMapDocument } from "../src/contract.js";
import { validateVenuesMapDocument } from "../src/validate.js";

const legacyDocument = {
  schema_version: "1.1.0",
  season: 2026,
  generated_from: "porchfest/tools/render.py",
  event: {
    date: "2026-09-16",
    time: "6-8 PM",
    city: "Saint Paul",
    state: "MN",
  },
  venues: [
    {
      title: "Legacy synthetic venue",
      address: "1 Imaginary Avenue",
      lat: 44.97,
      lng: -93.19,
      schedule: "6–7 pm",
      acts: [
        {
          slot: "6-7",
          slot_label: "6–7 pm",
          name: "Legacy synthetic act",
          genre: "Folk",
          description: "Synthetic compatibility fixture.",
          links: [{ url: "https://example.invalid/legacy-act" }],
        },
      ],
    },
  ],
} satisfies VenuesMapDocument;

const neutralDocument = {
  schema_version: "1.3.0",
  season: 2027,
  generated_from: "packages/web/src/routes/map.ts",
  event: {
    date: "2027-05-22",
    time: "1-5 PM",
    city: "Exampleton",
    state: "WI",
  },
  venues: [
    {
      title: "Afternoon synthetic venue",
      address: "2 Fictional Street",
      lat: 12.34,
      lng: 56.78,
      schedule: "afternoon-1",
      acts: [
        {
          slot: "afternoon-1",
          slot_label: "afternoon-1",
          name: "Afternoon synthetic act",
          genre: "Experimental",
          description: "Synthetic deployment-neutral fixture.",
          links: [],
        },
      ],
    },
  ],
} satisfies VenuesMapDocument;

function copyDocument(): Record<string, unknown> {
  return structuredClone(neutralDocument) as unknown as Record<string, unknown>;
}

function expectInvalid(value: unknown, path: string, message?: RegExp): void {
  const result = validateVenuesMapDocument(value);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
    if (message !== undefined) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(message) }),
        ]),
      );
    }
  }
}

describe("validateVenuesMapDocument", () => {
  it("accepts a synthetic v1.1.0 producer document", () => {
    expect(validateVenuesMapDocument(legacyDocument)).toEqual({
      ok: true,
      document: legacyDocument,
    });
  });

  it("accepts deployment-neutral season, event, coordinates, and slots", () => {
    expect(validateVenuesMapDocument(neutralDocument)).toEqual({
      ok: true,
      document: neutralDocument,
    });
  });

  it("rejects a schema version outside the v1 pattern", () => {
    expectInvalid(
      { ...neutralDocument, schema_version: "0.9.0" },
      "/schema_version",
      /pattern/,
    );
  });

  it("rejects a schema version below the supported minimum", () => {
    expectInvalid(
      { ...neutralDocument, schema_version: "1.0.0" },
      "/schema_version",
      /at least 1\.1\.0/,
    );
  });

  it("rejects a link without its required url at the missing field path", () => {
    const document = copyDocument();
    const venues = document.venues as Array<Record<string, unknown>>;
    const acts = venues[0]?.acts as Array<Record<string, unknown>>;
    acts[0]!.links = [{}];

    expectInvalid(document, "/venues/0/acts/0/links/0/url");
  });

  it("rejects a link url outside the HTTP(S) pattern", () => {
    const document = copyDocument();
    const venues = document.venues as Array<Record<string, unknown>>;
    const acts = venues[0]?.acts as Array<Record<string, unknown>>;
    acts[0]!.links = [{ url: "ftp://example.invalid/act" }];

    expectInvalid(document, "/venues/0/acts/0/links/0/url");
  });

  it("rejects additional properties at the offending field path", () => {
    const document = copyDocument();
    document.unexpected = true;

    expectInvalid(document, "/unexpected");
  });

  it("rejects latitude outside the global coordinate range", () => {
    const document = copyDocument();
    const venues = document.venues as Array<Record<string, unknown>>;
    venues[0]!.lat = 91;

    expectInvalid(document, "/venues/0/lat");
  });

  it("rejects a malformed event date", () => {
    const document = copyDocument();
    const event = document.event as Record<string, unknown>;
    event.date = "not-a-date";

    expectInvalid(document, "/event/date", /format/);
  });

  it("compiles the schema once across repeated validation calls", async () => {
    vi.resetModules();
    const compile = vi.spyOn(Ajv2020.prototype, "compile");
    const validatorModule = await import("../src/validate.js");

    expect(validatorModule.validateVenuesMapDocument(legacyDocument).ok).toBe(
      true,
    );
    expect(validatorModule.validateVenuesMapDocument(neutralDocument).ok).toBe(
      true,
    );
    expect(compile).toHaveBeenCalledTimes(1);

    compile.mockRestore();
  });
});
