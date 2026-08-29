import { expect } from "vitest";
import type { GeoPort } from "../src/index.js";

export async function geoPortContract(create: () => GeoPort): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe("boolean");

  const located = await adapter.locate({
    address: "1 Contract Way",
    boundingBox: { north: 11, south: 10, east: 21, west: 20 },
    localityName: "Example Borough, ZZ",
  });
  expect(["located", "not-found", "refused", "unavailable"]).toContain(
    located.kind,
  );
  expect(located.reason.length).toBeGreaterThan(0);

  const result = await adapter.geocode({ address: "Contract address" });
  if (result !== null) {
    expect(Number.isFinite(result.latitude)).toBe(true);
    expect(Number.isFinite(result.longitude)).toBe(true);
  }
}
