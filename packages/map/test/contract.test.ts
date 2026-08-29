import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VENUES_MAP_GENERATED_FROM,
  VENUES_MAP_SCHEMA_VERSION,
  assertVenuesMapSchemaDigest,
  readPinnedVenuesMapSchemaDigest,
  readVenuesMapSchemaSource,
  type VenuesMapDocument,
} from "../src/index.js";

interface VenuesMapSchema {
  $schema: string;
  required: string[];
  properties: {
    schema_version: { const: string };
    generated_from: { enum: string[]; const?: unknown };
  };
  $defs: Record<string, unknown>;
}

const sparseDocument: VenuesMapDocument = {
  schema_version: VENUES_MAP_SCHEMA_VERSION,
  season: 2026,
  generated_from: "packages/web/src/routes/map.ts",
  event: {
    date: "2026-09-16",
    time: "6-8 PM",
    city: "Saint Paul",
    state: "MN",
  },
  venues: [
    {
      title: "Synthetic venue",
      address: "Redacted fixture location",
      lat: 44.97,
      lng: -93.19,
      schedule: "6–7 pm",
      acts: [
        {
          slot: "6-7",
          slot_label: "6–7 pm",
          name: "Synthetic act",
          genre: "",
          description: "",
          links: [{ url: "https://example.invalid/act" }],
        },
      ],
    },
  ],
};

describe("venues-map schema contract", () => {
  it("pins the exact shipped schema bytes", () => {
    const source = readVenuesMapSchemaSource();
    const actualDigest = createHash("sha256")
      .update(source, "utf8")
      .digest("hex");

    expect(readPinnedVenuesMapSchemaDigest()).toBe(actualDigest);
    expect(() => assertVenuesMapSchemaDigest()).not.toThrow();
  });

  it("rejects schema source whose bytes do not match the pin", () => {
    const source = readVenuesMapSchemaSource();
    const mutatedSource = source.replace(
      '"title": "SAP Porchfest 2026 venues map"',
      '"title": "Mutated venues map"',
    );

    expect(mutatedSource).not.toBe(source);
    expect(() => assertVenuesMapSchemaDigest(mutatedSource)).toThrow(
      /expected [a-f0-9]{64}, received [a-f0-9]{64}/,
    );
  });

  it("declares the 2020-12 draft and the widened v1.2.0 provenance", () => {
    const schema = JSON.parse(readVenuesMapSchemaSource()) as VenuesMapSchema;

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.schema_version.const).toBe(
      VENUES_MAP_SCHEMA_VERSION,
    );
    expect(schema.properties.generated_from.enum).toEqual(
      VENUES_MAP_GENERATED_FROM,
    );
    expect(schema.properties.generated_from.enum).toContain(
      "porchfest/tools/render.py",
    );
    expect(schema.properties.generated_from.enum).toContain(
      "packages/web/src/routes/map.ts",
    );
    expect(schema.properties.generated_from).not.toHaveProperty("const");
  });

  it("retains the required document keys and nested definitions", () => {
    const schema = JSON.parse(readVenuesMapSchemaSource()) as VenuesMapSchema;

    expect(schema.required).toEqual([
      "schema_version",
      "season",
      "generated_from",
      "event",
      "venues",
    ]);
    expect(schema.$defs).toEqual(
      expect.objectContaining({
        venue: expect.any(Object),
        act: expect.any(Object),
        link: expect.any(Object),
      }),
    );
  });

  it("types schema-optional act notes and link labels as optional", () => {
    expect(sparseDocument.venues[0]?.acts[0]?.note).toBeUndefined();
    expect(sparseDocument.venues[0]?.acts[0]?.links[0]?.label).toBeUndefined();
  });
});
