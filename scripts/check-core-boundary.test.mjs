import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCoreBoundaryViolations } from './check-core-boundary.mjs';

describe('core dependency boundary', () => {
  it('flags imports from an adapter package', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'porchfest-core-boundary-'));
    await mkdir(join(directory, 'src'));
    await writeFile(
      join(directory, 'src/example.ts'),
      "import { NullEmailAdapter } from '@porchfest/email';\n",
    );

    await expect(findCoreBoundaryViolations(directory)).resolves.toEqual([
      expect.objectContaining({ specifier: '@porchfest/email' }),
    ]);
  });
});
