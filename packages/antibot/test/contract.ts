import { expect } from "vitest";
import type { AntibotPort, AntibotResult } from "../src/index.js";

const knownStatuses: readonly AntibotResult["status"][] = [
  "passed",
  "failed",
  "not-configured",
  "unavailable",
];

export async function antibotPortContract(
  create: () => AntibotPort,
): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe("boolean");

  const result = await adapter.verify({ token: null, ipAddress: "127.0.0.1" });
  expect(knownStatuses).toContain(result.status);

  if (result.status !== "passed") {
    expect(result.reason.length).toBeGreaterThan(0);
  }
}
