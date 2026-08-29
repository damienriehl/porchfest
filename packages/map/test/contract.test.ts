import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VENUES_MAP_GENERATED_FROM,
  VENUES_MAP_MINIMUM_SCHEMA_VERSION,
  VENUES_MAP_SCHEMA_VERSION,
  assertVenuesMapSchemaDigest,
  computeVenuesMapSchemaDigest,
  isSupportedVenuesMapVersion,
  loadVerifiedVenuesMapSchema,
  readPinnedVenuesMapSchemaDigest,
  venuesMapVersionPattern,
} from "../src/index.js";
import { makeVenuesMapDocument } from "./fixtures.js";

interface VenuesMapSchema {
  $schema: string;
  required: string[];
  properties: {
    schema_version: { type: string; pattern: string };
    season: { type: string; minimum: number };
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
const sparse = makeVenuesMapDocument();
void sparse;

describe("venues-map schema contract", () => {
  it("pins the exact shipped schema bytes", () => {
    const actualDigest = computeVenuesMapSchemaDigest(bytes);

    expect(readPinnedVenuesMapSchemaDigest()).toBe(actualDigest);
    expect(() => assertVenuesMapSchemaDigest(source)).not.toThrow();
  });

  it("rejects schema source whose bytes do not match the pin", () => {
    const mutatedSource = source.replace(
      '"title": "SAP Porchfest venues map v1.3.1"',
      '"title": "Mutated venues map"',
    );

    expect(mutatedSource).not.toBe(source);
    expect(() => assertVenuesMapSchemaDigest(mutatedSource)).toThrow(
      /expected [a-f0-9]{64}, received [a-f0-9]{64}/,
    );
  });

  it("declares the 2020-12 draft and the deployment-neutral v1.3.1 fields", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(VENUES_MAP_SCHEMA_VERSION).toBe("1.3.1");
    expect(schema.properties.schema_version).toEqual({
      type: "string",
      pattern: "^1\\.\\d+\\.\\d+$",
    });
    expect(schema.properties.schema_version.pattern).toBe(
      venuesMapVersionPattern.source,
    );
    expect(schema.properties.season).toEqual({
      type: "integer",
      minimum: 2000,
    });
    expect(schema.properties.generated_from.enum).toEqual(
      VENUES_MAP_GENERATED_FROM,
    );
    expect(Object.keys(schema.properties.generated_from)).toEqual(["enum"]);
  });

  it("supports schema versions in the v1 family from the minimum onward", () => {
    expect(VENUES_MAP_MINIMUM_SCHEMA_VERSION).toBe("1.1.0");
    expect(isSupportedVenuesMapVersion("1.0.99")).toBe(false);
    expect(isSupportedVenuesMapVersion("1.1.0")).toBe(true);
    expect(isSupportedVenuesMapVersion("1.3.0")).toBe(true);
    expect(isSupportedVenuesMapVersion("1.3.1")).toBe(true);
    expect(isSupportedVenuesMapVersion("1.10.0")).toBe(true);
    expect(isSupportedVenuesMapVersion("2.0.0")).toBe(false);
    expect(isSupportedVenuesMapVersion("1.3")).toBe(false);
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
