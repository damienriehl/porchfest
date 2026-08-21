import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SESSION_SECRET_FILENAME,
  SESSION_SECRET_PLACEHOLDER,
  loadSessionSecret,
} from '../src/config/session-secret.js';

describe('session secret boot policy', () => {
  it('generates different keys for two fresh data volumes', async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), 'porchfest-secret-a-'));
    const secondDirectory = await mkdtemp(join(tmpdir(), 'porchfest-secret-b-'));

    const first = await loadSessionSecret({ dataDirectory: firstDirectory });
    const firstAgain = await loadSessionSecret({ dataDirectory: firstDirectory });
    const second = await loadSessionSecret({ dataDirectory: secondDirectory });

    expect(first).toBe(firstAgain);
    expect(first).not.toBe(second);
    expect((await stat(join(firstDirectory, SESSION_SECRET_FILENAME))).mode & 0o777).toBe(0o600);
  });

  it('refuses the public example placeholder', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'porchfest-secret-placeholder-'));
    await expect(
      loadSessionSecret({ dataDirectory, configuredSecret: SESSION_SECRET_PLACEHOLDER }),
    ).rejects.toThrow(/placeholder/i);
  });
});
