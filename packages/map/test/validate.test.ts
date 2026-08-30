import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import { validateVenuesMapDocument } from "../src/validate.js";
import { makeVenuesMapDocument } from "./fixtures.js";

const legacyDocument = makeVenuesMapDocument({
  schema_version: "1.1.0",
  generated_from: "porchfest/tools/render.py",
});

const neutralDocument = makeVenuesMapDocument();

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

  it("R16 accepts the unpublished empty-venues document", () => {
    const document = makeVenuesMapDocument({ venues: [] });

    expect(validateVenuesMapDocument(document)).toEqual({
      ok: true,
      document,
    });
  });

  it("accepts optional act slot intervals", () => {
    const document = copyDocument();
    const venues = document.venues as Array<Record<string, unknown>>;
    const acts = venues[0]?.acts as Array<Record<string, unknown>>;
    acts[0]!.slot_start = "13:00:00Z";
    acts[0]!.slot_end = "14:00:00Z";

    expect(validateVenuesMapDocument(document)).toEqual({
      ok: true,
      document,
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

  it.each([
    ["schedule", " ", "/venues/0/schedule"],
    ["schedule", " afternoon-1 ", "/venues/0/schedule"],
    ["slot", " ", "/venues/0/acts/0/slot"],
    ["slot", " afternoon-1 ", "/venues/0/acts/0/slot"],
    ["slot_label", " ", "/venues/0/acts/0/slot_label"],
    ["slot_label", " afternoon-1 ", "/venues/0/acts/0/slot_label"],
  ])("rejects surrounding whitespace in %s", (field, value, path) => {
    const document = copyDocument();
    const venues = document.venues as Array<Record<string, unknown>>;
    if (field === "schedule") {
      venues[0]!.schedule = value;
    } else {
      const acts = venues[0]?.acts as Array<Record<string, unknown>>;
      acts[0]![field] = value;
    }

    expectInvalid(document, path, /pattern/);
  });

  it("supports formatMinimum through the Ajv instance configured with formats", () => {
    const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
    const ajv = new Ajv2020();
    addFormats(ajv);
    const validate = ajv.compile({
      type: "string",
      format: "date",
      formatMinimum: "2027-01-01",
    });

    expect(validate("2027-05-22")).toBe(true);
    expect(validate("2026-12-31")).toBe(false);
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
