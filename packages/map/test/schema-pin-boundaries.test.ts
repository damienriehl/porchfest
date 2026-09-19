import { describe, expect, it } from "vitest";
import {
  assertVenuesMapSchemaDigest,
  computeVenuesMapSchemaDigest,
  readPinnedVenuesMapSchemaDigest,
  readVenuesMapSchemaSource,
} from "../src/contract.js";
import { validateVenuesMapDocument } from "../src/validate.js";
import { makeVenuesMapDocument } from "./fixtures.js";

describe("schema pin parsing and shipped schema integration", () => {
  it.each([
    "",
    "not-a-digest",
    `${"a".repeat(63)}  venues-map.v1.schema.json`,
    `${"g".repeat(64)}  venues-map.v1.schema.json`,
    `${"a".repeat(64)}  venues-map.v1.schema.json.extra`,
  ])("rejects malformed pin %j", (pin) => {
    expect(() => readPinnedVenuesMapSchemaDigest(pin)).toThrow(
      /invalid venues-map schema digest pin/,
    );
  });
  it("accepts binary sha256sum syntax with CRLF and ignores subsequent lines", () => {
    const digest = computeVenuesMapSchemaDigest(readVenuesMapSchemaSource());
    expect(
      readPinnedVenuesMapSchemaDigest(
        `${digest.toUpperCase()} *venues-map.v1.schema.json\r\nignored\r\n`,
      ),
    ).toBe(digest);
  });
  it("checks actual shipped bytes before validating a serialized document against that schema", () => {
    const source = readVenuesMapSchemaSource();
    expect(() => assertVenuesMapSchemaDigest()).not.toThrow();
    expect(() =>
      assertVenuesMapSchemaDigest(Buffer.from(source)),
    ).not.toThrow();
    expect(computeVenuesMapSchemaDigest(Buffer.from(source))).toBe(
      readPinnedVenuesMapSchemaDigest(),
    );
    expect(
      validateVenuesMapDocument(
        JSON.parse(JSON.stringify(makeVenuesMapDocument())),
      ).ok,
    ).toBe(true);
  });
  it("rejects even whitespace-only changes to the pinned artifact", () => {
    const source = readVenuesMapSchemaSource();
    expect(() => assertVenuesMapSchemaDigest(`${source}\n`)).toThrow(
      /digest mismatch/,
    );
  });
});
