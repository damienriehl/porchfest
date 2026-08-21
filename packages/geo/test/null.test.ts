import { describe, expect, it } from 'vitest';
import { NullGeoAdapter } from '../src/index.js';
import { geoPortContract } from './contract.js';

describe('NullGeoAdapter', () => {
  it('passes the shared geo port contract', async () => {
    await geoPortContract(() => new NullGeoAdapter());
  });

  it('returns no coordinates when unconfigured', async () => {
    const adapter = new NullGeoAdapter();
    expect(await adapter.geocode({ address: 'Anywhere' })).toBeNull();
    expect(adapter.configured).toBe(false);
  });
});
