import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanGitHistory, scanTree, scanWorkingTree } from './clean-room-scan.mjs';

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

function participantEmail() {
  return ['neighbor', '@', 'porchfest', '.', 'community'].join('');
}

function participantPhone() {
  return ['612', '555', '0100'].join('-');
}

function generatedMessageBody() {
  return [
    ['To', ': neighbor'].join(''),
    ['Subject', ': Porchfest'].join(''),
    ['Body', ': See you there'].join(''),
  ].join('\n');
}

describe('clean-room scan', () => {
  it('fails closed when Git history cannot be enumerated', async () => {
    const notARepository = await mkdtemp(join(tmpdir(), 'porchfest-clean-not-git-'));

    expect(() => scanGitHistory(notARepository)).toThrow(
      `clean-room scan could not enumerate Git history in ${notARepository}`,
    );
  });

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

  it('detects NUL-encoded participant content in the working tree', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'porchfest-clean-working-nul-'));
    git(repository, 'init', '--quiet');
    await writeFile(
      join(repository, 'notes.txt'),
      Buffer.from(`Contact ${participantEmail()}\n`, 'utf16le'),
    );

    expect(await scanWorkingTree(repository)).toEqual([
      expect.objectContaining({
        kind: 'possible participant email address',
        location: 'working tree:notes.txt',
      }),
    ]);
  });

  it('detects NUL-encoded participant content committed in history', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'porchfest-clean-history-nul-'));
    git(repository, 'init', '--quiet');
    await writeFile(
      join(repository, 'notes.txt'),
      Buffer.from(`Call ${participantPhone()}\n`, 'utf16le'),
    );
    git(repository, 'add', 'notes.txt');
    git(repository, 'commit', '--quiet', '-m', 'bad NUL fixture');

    expect(scanGitHistory(repository)).toEqual([
      expect.objectContaining({
        kind: 'possible participant phone number',
        location: expect.stringContaining('history '),
      }),
    ]);
  });

  it('detects NUL-encoded generated message content in an image tree', async () => {
    const imageRoot = await mkdtemp(join(tmpdir(), 'porchfest-clean-image-nul-'));
    await writeFile(
      join(imageRoot, 'notes.txt'),
      Buffer.from(`${generatedMessageBody()}\n`, 'utf16le'),
    );

    expect(await scanTree(imageRoot)).toEqual([
      expect.objectContaining({
        kind: 'generated message body headers',
        location: 'image:notes.txt',
      }),
    ]);
  });

  it('detects sensitive content even when the file path is otherwise neutral', async () => {
    const imageRoot = await mkdtemp(join(tmpdir(), 'porchfest-clean-neutral-paths-'));
    await writeFile(join(imageRoot, 'notes.txt'), `${participantEmail()}\n`);
    await writeFile(join(imageRoot, 'reminder.txt'), `Call ${participantPhone()}\n`);
    await writeFile(join(imageRoot, 'draft.txt'), `${generatedMessageBody()}\n`);

    expect(await scanTree(imageRoot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'possible participant email address' }),
        expect.objectContaining({ kind: 'possible participant phone number' }),
        expect.objectContaining({ kind: 'generated message body headers' }),
      ]),
    );
  });
});
