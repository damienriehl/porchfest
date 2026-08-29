import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VENUES_MAP_GENERATED_FROM,
  VENUES_MAP_SCHEMA_VERSION,
  assertVenuesMapSchemaDigest,
  computeVenuesMapSchemaDigest,
  loadVerifiedVenuesMapSchema,
  readPinnedVenuesMapSchemaDigest,
  type VenuesMapDocument,
} from "../src/index.js";

interface VenuesMapSchema {
  $schema: string;
  required: string[];
  properties: {
    schema_version: { const: string };
    generated_from: { enum: string[] };
  };
  $defs: Record<string, unknown>;
}

const bytes = readFileSync(
  new URL("../schemas/venues-map.v1.schema.json", import.meta.url),
);
const source = bytes.toString("utf8");
const schema = JSON.parse(source) as VenuesMapSchema;
const pinSource = readFileSync(
  new URL("../schemas/venues-map.v1.sha256", import.meta.url),
  "utf8",
);

// This fixture is compile-time coverage; `npm run typecheck` is the gate.
const sparse = {
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
} satisfies VenuesMapDocument;
void sparse;

describe("venues-map schema contract", () => {
  it("pins the exact shipped schema bytes", () => {
    const actualDigest = computeVenuesMapSchemaDigest(bytes);

    expect(readPinnedVenuesMapSchemaDigest()).toBe(actualDigest);
    expect(() => assertVenuesMapSchemaDigest(source)).not.toThrow();
  });

  it("rejects schema source whose bytes do not match the pin", () => {
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
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.properties.schema_version.const).toBe(
      VENUES_MAP_SCHEMA_VERSION,
    );
    expect(schema.properties.generated_from.enum).toEqual(
      VENUES_MAP_GENERATED_FROM,
    );
    expect(Object.keys(schema.properties.generated_from)).toEqual(["enum"]);
  });

  it("retains the required document keys and nested definitions", () => {
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

  it("rejects a pin that names a different schema file", () => {
    const wrongFilename = pinSource.replace(
      "venues-map.v1.schema.json",
      "other-schema.json",
    );

    expect(() => readPinnedVenuesMapSchemaDigest(wrongFilename)).toThrow(
      /expected sha256sum format/,
    );
  });

  it("accepts an uppercase digest in the pin", () => {
    const uppercaseDigest = pinSource.replace(/^[a-f0-9]{64}/, (digest) =>
      digest.toUpperCase(),
    );

    expect(readPinnedVenuesMapSchemaDigest(uppercaseDigest)).toBe(
      computeVenuesMapSchemaDigest(bytes),
    );
  });

  it("loads and memoizes the verified parsed schema", () => {
    const first = loadVerifiedVenuesMapSchema();
    const second = loadVerifiedVenuesMapSchema();

    expect(second).toBe(first);
    expect(first.digest).toBe(readPinnedVenuesMapSchemaDigest());
    expect(first.source).toBe(source);
    expect(first.schema).toEqual(schema);
  });
});
