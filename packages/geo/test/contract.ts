import { expect } from 'vitest';
import type { GeoPort } from '../src/index.js';

export async function geoPortContract(create: () => GeoPort): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe('boolean');

  const result = await adapter.geocode({ address: 'Contract address' });
  if (result !== null) {
    expect(Number.isFinite(result.latitude)).toBe(true);
    expect(Number.isFinite(result.longitude)).toBe(true);
  }
}
