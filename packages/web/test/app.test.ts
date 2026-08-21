import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/composition.js';

describe('application scaffold', () => {
  it('boots with an empty configuration and serves health', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'porchfest-empty-config-'));
    const runtime = await createRuntime({ env: {}, dataDirectory });

    const response = await runtime.app.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'porchfest' });
    expect(runtime.routes.list()).toEqual([
      expect.objectContaining({ method: 'GET', path: '/health', tier: 'public' }),
    ]);
  });
});
