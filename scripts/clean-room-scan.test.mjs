import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanGitHistory, scanTree } from './clean-room-scan.mjs';

function git(directory, ...args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Clean Room Test',
      GIT_AUTHOR_EMAIL: 'clean-room@example.test',
      GIT_COMMITTER_NAME: 'Clean Room Test',
      GIT_COMMITTER_EMAIL: 'clean-room@example.test',
    },
  });
}

describe('clean-room scan', () => {
  it('refuses a prohibited artifact committed anywhere in history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'porchfest-clean-history-'));
    git(repository, 'init', '--quiet');
    await mkdir(join(repository, 'private'));
    await writeFile(join(repository, 'private', 'contacts.txt'), 'participant record\n');
    git(repository, 'add', 'private/contacts.txt');
    git(repository, 'commit', '--quiet', '-m', 'bad fixture');

    expect(scanGitHistory(repository)).toEqual([
      expect.objectContaining({
        kind: 'prohibited private/ directory',
        location: expect.stringContaining('private/contacts.txt'),
      }),
    ]);
  });

  it('refuses raw exports and generated message bodies in an image tree', async () => {
    const imageRoot = await mkdtemp(join(tmpdir(), 'porchfest-clean-image-'));
    await mkdir(join(imageRoot, 'out'));
    await writeFile(join(imageRoot, 'out', 'submissions.csv'), 'name,email\n');
    await writeFile(join(imageRoot, 'delivery.eml'), 'To: recipient\nSubject: Hi\nBody: hi\n');

    const findings = await scanTree(imageRoot);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'prohibited out/ directory' }),
        expect.objectContaining({ kind: 'raw export (.csv)' }),
        expect.objectContaining({ kind: 'generated message body (.eml)' }),
      ]),
    );
  });
});
