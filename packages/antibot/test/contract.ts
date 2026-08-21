import { expect } from 'vitest';
import type { AntibotPort } from '../src/index.js';

export async function antibotPortContract(create: () => AntibotPort): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe('boolean');

  const result = await adapter.verify({ token: null, ipAddress: '127.0.0.1' });
  expect(['passed', 'failed', 'not-configured']).toContain(result.status);
}
