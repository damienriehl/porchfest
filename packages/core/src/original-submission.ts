export type OriginalSubmissionValues = Readonly<
  Record<string, string | number | boolean | null>
>;

interface OriginalSubmissionSnapshotV1 {
  readonly version: 1;
  readonly values: OriginalSubmissionValues;
}

export function serializeOriginalSubmission(
  values: OriginalSubmissionValues,
): string {
  return JSON.stringify({
    version: 1,
    values,
  } satisfies OriginalSubmissionSnapshotV1);
}

export function parseOriginalSubmission(
  serialized: string | null,
): OriginalSubmissionValues | null {
  if (serialized === null) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isPlainRecord(parsed) || parsed.version !== 1) return null;
    const values = parsed.values;
    if (!isPlainRecord(values)) return null;
    if (
      Object.values(values).some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean",
      )
    ) {
      return null;
    }
    return values as OriginalSubmissionValues;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
