import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_DIRECTORIES = new Set([
  'private',
  'out',
  'raw-exports',
  'generated-messages',
  'generated-emails',
  'message-bodies',
]);
const RAW_EXPORT_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.xls',
  '.xlsx',
  '.ods',
]);
const MESSAGE_EXTENSIONS = new Set(['.eml', '.mbox']);
const KNOWN_PRIVATE_FILENAMES = [
  /^submissions(?:[-_.].*)?\.json$/i,
  /^matches(?:[-_.].*)?\.json$/i,
  /^geocache(?:[-_.].*)?\.json$/i,
];
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const PHONE_NUMBER = /\b(?:\+?1[ .-])?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}\b/g;
const GENERATED_BODY_HEADER =
  /(?:^|\n)(?:to|recipients):[^\n]+\nsubject:[^\n]+\n(?:content-type:|body:)/i;
const SAFE_EMAIL_HOSTS = new Set(['example.com', 'example.net', 'example.org']);

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function inspectPath(path, location) {
  const normalized = normalizePath(path);
  const segments = normalized.toLowerCase().split('/');
  const findings = [];

  const privateSegment = segments.find((segment) => PRIVATE_DIRECTORIES.has(segment));
  if (privateSegment) {
    findings.push({
      kind: `prohibited ${privateSegment}/ directory`,
      location: `${location}:${normalized}`,
    });
  }

  const extension = extname(normalized).toLowerCase();
  if (RAW_EXPORT_EXTENSIONS.has(extension)) {
    findings.push({ kind: `raw export (${extension})`, location: `${location}:${normalized}` });
  }
  if (MESSAGE_EXTENSIONS.has(extension)) {
    findings.push({
      kind: `generated message body (${extension})`,
      location: `${location}:${normalized}`,
    });
  }
  if (KNOWN_PRIVATE_FILENAMES.some((pattern) => pattern.test(basename(normalized)))) {
    findings.push({ kind: 'known participant-data artifact', location: `${location}:${normalized}` });
  }

  return findings;
}

export function inspectContent(content, path, location) {
  if (content.includes('\0')) return [];
  const findings = [];
  const normalized = normalizePath(path);

  for (const match of content.matchAll(EMAIL_ADDRESS)) {
    const host = match[1]?.toLowerCase();
    if (
      host &&
      !SAFE_EMAIL_HOSTS.has(host) &&
      !host.endsWith('.example') &&
      !host.endsWith('.invalid') &&
      !host.endsWith('.test')
    ) {
      findings.push({
        kind: 'possible participant email address',
        location: `${location}:${normalized}`,
      });
      break;
    }
  }
  if (PHONE_NUMBER.test(content)) {
    findings.push({ kind: 'possible participant phone number', location: `${location}:${normalized}` });
  }
  PHONE_NUMBER.lastIndex = 0;
  if (GENERATED_BODY_HEADER.test(content)) {
    findings.push({ kind: 'generated message body headers', location: `${location}:${normalized}` });
  }

  return findings;
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function nulList(output) {
  return output.split('\0').filter(Boolean);
}

export function scanGitHistory(repoRoot) {
  let commits = [];
  try {
    commits = git(['rev-list', '--all'], repoRoot).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const findings = [];
  for (const commit of commits) {
    const shortCommit = commit.slice(0, 12);
    const paths = nulList(git(['ls-tree', '-r', '--name-only', '-z', commit], repoRoot));
    for (const path of paths) {
      const location = `history ${shortCommit}`;
      findings.push(...inspectPath(path, location));
      try {
        const content = git(['show', `${commit}:${path}`], repoRoot);
        findings.push(...inspectContent(content, path, location));
      } catch {
        // A path finding already catches binary export/message formats. Other
        // unreadable blobs are left to the image scan rather than reported as data.
      }
    }
  }
  return findings;
}

export async function scanWorkingTree(repoRoot) {
  const paths = nulList(
    git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repoRoot),
  );
  const findings = [];
  for (const path of paths) {
    findings.push(...inspectPath(path, 'working tree'));
    try {
      const content = await readFile(resolve(repoRoot, path), 'utf8');
      findings.push(...inspectContent(content, path, 'working tree'));
    } catch {
      // Binary and concurrently removed files are covered by path/history checks.
    }
  }
  return findings;
}

async function treeFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['.git', 'node_modules', 'data'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await treeFiles(path, root)));
    else if (entry.isFile()) files.push({ absolute: path, relative: relative(root, path) });
  }
  return files;
}

export async function scanTree(directory, location = 'image') {
  const findings = [];
  for (const file of await treeFiles(directory)) {
    findings.push(...inspectPath(file.relative, location));
    try {
      const content = await readFile(file.absolute, 'utf8');
      findings.push(...inspectContent(content, file.relative, location));
    } catch {
      // Path inspection still covers raw binary exports and mailboxes.
    }
  }
  return findings;
}

function scanImage(image) {
  const scriptPath = fileURLToPath(import.meta.url);
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--mount',
      `type=bind,source=${scriptPath},target=/tmp/clean-room-scan.mjs,readonly`,
      image,
      '/tmp/clean-room-scan.mjs',
      '--tree',
      '/app',
      '--skip-history',
    ],
    { encoding: 'utf8' },
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return result.status ?? 1;
}

function printFindings(findings) {
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.kind}\0${finding.location}`, finding);
  }
  for (const finding of unique.values()) {
    console.error(`ERROR: clean-room scan found ${finding.kind} at ${finding.location}`);
  }
  return unique.size;
}

async function main() {
  const args = process.argv.slice(2);
  const treeIndex = args.indexOf('--tree');
  const imageIndex = args.indexOf('--image');
  let findings = [];

  if (treeIndex >= 0) {
    const tree = args[treeIndex + 1];
    if (!tree) throw new Error('--tree requires a directory');
    findings = await scanTree(resolve(tree), 'image');
  } else {
    const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    findings.push(...(await scanWorkingTree(repoRoot)));
    if (!args.includes('--skip-history')) findings.push(...scanGitHistory(repoRoot));
  }

  if (printFindings(findings) > 0) {
    process.exitCode = 1;
    return;
  }

  if (imageIndex >= 0) {
    const image = args[imageIndex + 1];
    if (!image) throw new Error('--image requires an image reference');
    if (scanImage(image) !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  console.log('OK: clean-room scan found no participant data');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
