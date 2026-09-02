import { describe, expect, it } from "vitest";
import {
  parseOriginalSubmission,
  serializeOriginalSubmission,
} from "../src/original-submission.js";

describe("original submission snapshots", () => {
  it("round-trips a versioned primitive-value snapshot", () => {
    const values = {
      title: "Original porch",
      hasPower: true,
      durationMinutes: 45,
      notes: null,
    } as const;

    expect(
      parseOriginalSubmission(serializeOriginalSubmission(values)),
    ).toEqual(values);
  });

  it("refuses unknown versions and non-primitive values", () => {
    expect(
      parseOriginalSubmission('{"version":2,"values":{"title":"old"}}'),
    ).toBeNull();
    expect(
      parseOriginalSubmission('{"version":1,"values":{"nested":{}}}'),
    ).toBeNull();
  });
});
