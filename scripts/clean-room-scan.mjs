import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRIVATE_DIRECTORIES = new Set([
  "private",
  "out",
  "raw-exports",
  "generated-messages",
  "generated-emails",
  "message-bodies",
]);
const RAW_EXPORT_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".ods",
]);
const MESSAGE_EXTENSIONS = new Set([".eml", ".mbox"]);
const KNOWN_PRIVATE_FILENAMES = [
  /^submissions(?:[-_.].*)?\.json$/i,
  /^matches(?:[-_.].*)?\.json$/i,
  /^geocache(?:[-_.].*)?\.json$/i,
];
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const PHONE_NUMBER = /\b(?:\+?1[ .-])?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}\b/g;
const GENERATED_BODY_HEADER =
  /(?:^|\n)(?:to|recipients):[^\n]+\nsubject:[^\n]+\n(?:content-type:|body:)/i;
const SAFE_EMAIL_HOSTS = new Set(["example.com", "example.net", "example.org"]);

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function inspectPath(path, location) {
  const normalized = normalizePath(path);
  const segments = normalized.toLowerCase().split("/");
  const findings = [];

  const privateSegment = segments.find((segment) =>
    PRIVATE_DIRECTORIES.has(segment),
  );
  if (privateSegment) {
    findings.push({
      kind: `prohibited ${privateSegment}/ directory`,
      location: `${location}:${normalized}`,
    });
  }

  const extension = extname(normalized).toLowerCase();
  if (RAW_EXPORT_EXTENSIONS.has(extension)) {
    findings.push({
      kind: `raw export (${extension})`,
      location: `${location}:${normalized}`,
    });
  }
  if (MESSAGE_EXTENSIONS.has(extension)) {
    findings.push({
      kind: `generated message body (${extension})`,
      location: `${location}:${normalized}`,
    });
  }
  if (
    KNOWN_PRIVATE_FILENAMES.some((pattern) =>
      pattern.test(basename(normalized)),
    )
  ) {
    findings.push({
      kind: "known participant-data artifact",
      location: `${location}:${normalized}`,
    });
  }

  return findings;
}

export function inspectContent(content, path, location) {
  // UTF-16 text and deliberately obfuscated text can contain NUL bytes while
  // still carrying participant data. Removing NULs recovers the searchable
  // text without attempting to interpret arbitrary binary formats.
  const searchableContent = content.replaceAll("\0", "");
  const findings = [];
  const normalized = normalizePath(path);

  for (const match of searchableContent.matchAll(EMAIL_ADDRESS)) {
    const host = match[1]?.toLowerCase();
    if (
      host &&
      !SAFE_EMAIL_HOSTS.has(host) &&
      !host.endsWith(".example") &&
      !host.endsWith(".invalid") &&
      !host.endsWith(".test")
    ) {
      findings.push({
        kind: "possible participant email address",
        location: `${location}:${normalized}`,
      });
      break;
    }
  }
  if (PHONE_NUMBER.test(searchableContent)) {
    findings.push({
      kind: "possible participant phone number",
      location: `${location}:${normalized}`,
    });
  }
  PHONE_NUMBER.lastIndex = 0;
  if (GENERATED_BODY_HEADER.test(searchableContent)) {
    findings.push({
      kind: "generated message body headers",
      location: `${location}:${normalized}`,
    });
  }

  return findings;
}

function git(args, cwd, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulList(output) {
  return output.split("\0").filter(Boolean);
}

function treeEntries(output) {
  return nulList(output).map((entry) => {
    const tab = entry.indexOf("\t");
    const metadata = entry.slice(0, tab).split(" ");
    return { objectId: metadata[2], path: entry.slice(tab + 1) };
  });
}

export function scanGitHistory(repoRoot) {
  let commits = [];
  try {
    commits = git(["rev-list", "--all"], repoRoot)
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `clean-room scan could not enumerate Git history in ${repoRoot}: ${detail}`,
      {
        cause: error,
      },
    );
  }

  const findings = [];
  const inspectedObjects = new Set();
  for (const commit of commits) {
    const shortCommit = commit.slice(0, 12);
    const entries = treeEntries(git(["ls-tree", "-r", "-z", commit], repoRoot));
    for (const { objectId, path } of entries) {
      const location = `history ${shortCommit}`;
      findings.push(...inspectPath(path, location));
      if (!objectId || inspectedObjects.has(objectId)) continue;
      inspectedObjects.add(objectId);
      try {
        const content = git(["cat-file", "blob", objectId], repoRoot);
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
  const findings = [];
  // Git ignore rules intentionally cover both prohibited participant-data
  // artifacts and legitimate runtime state, so `git ls-files` cannot define
  // this privacy boundary. Walk the filesystem to catch ignored artifacts.
  // The root data/ volume (including its SQLite files) and .env files are
  // expected after running the app; data, .env, and .env.* are also excluded
  // from container build contexts by .dockerignore. .git and node_modules are
  // omitted solely to keep the walk bounded and fast.
  const presentPaths = new Set();
  for (const file of await treeFiles(repoRoot)) {
    presentPaths.add(normalizePath(file.relative));
    findings.push(...inspectPath(file.relative, "working tree"));
    if (file.isSymbolicLink || isExpectedRuntimeFile(file.relative)) continue;
    try {
      const content = await readFile(file.absolute, "utf8");
      findings.push(...inspectContent(content, file.relative, "working tree"));
    } catch {
      // Binary and concurrently removed files are covered by path/history checks.
    }
  }

  // Preserve index coverage for staged paths whose working-tree copy is gone.
  // Reading their content was never part of this pass, but prohibited artifact
  // names in the index must remain a hard failure.
  const indexedPaths = nulList(git(["ls-files", "-z", "--cached"], repoRoot));
  for (const path of indexedPaths) {
    if (!presentPaths.has(normalizePath(path)))
      findings.push(...inspectPath(path, "Git index"));
  }
  return findings;
}

async function treeFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path);
    if (
      [".git", "node_modules"].includes(entry.name) ||
      relativePath === "data"
    )
      continue;
    if (entry.isDirectory()) files.push(...(await treeFiles(path, root)));
    else if (entry.isFile() || entry.isSymbolicLink())
      files.push({
        absolute: path,
        relative: relativePath,
        isSymbolicLink: entry.isSymbolicLink(),
      });
  }
  return files;
}

function isExpectedRuntimeFile(path) {
  const filename = basename(normalizePath(path)).toLowerCase();
  return (
    (filename !== ".env.example" &&
      (filename === ".env" || filename.startsWith(".env."))) ||
    filename.endsWith(".db") ||
    filename.endsWith(".db-shm") ||
    filename.endsWith(".db-wal")
  );
}

export async function scanTree(directory, location = "image") {
  const findings = [];
  for (const file of await treeFiles(directory)) {
    findings.push(...inspectPath(file.relative, location));
    if (file.isSymbolicLink) continue;
    try {
      const content = await readFile(file.absolute, "utf8");
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
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      "--mount",
      `type=bind,source=${scriptPath},target=/tmp/clean-room-scan.mjs,readonly`,
      image,
      "/tmp/clean-room-scan.mjs",
      "--tree",
      "/app",
      "--skip-history",
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result.status ?? 1;
}

function printFindings(findings) {
  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.kind}\0${finding.location}`, finding);
  }
  for (const finding of unique.values()) {
    console.error(
      `ERROR: clean-room scan found ${finding.kind} at ${finding.location}`,
    );
  }
  return unique.size;
}

async function main() {
  const args = process.argv.slice(2);
  const treeIndex = args.indexOf("--tree");
  const imageIndex = args.indexOf("--image");
  const repoRootIndex = args.indexOf("--repo-root");
  let findings = [];
  let scannedScope;

  if (treeIndex >= 0) {
    const tree = args[treeIndex + 1];
    if (!tree) throw new Error("--tree requires a directory");
    findings = await scanTree(resolve(tree), "image");
    scannedScope = "image tree";
  } else {
    const requestedRoot =
      repoRootIndex >= 0 ? args[repoRootIndex + 1] : undefined;
    if (repoRootIndex >= 0 && !requestedRoot)
      throw new Error("--repo-root requires a directory");
    const repoRoot = resolve(
      requestedRoot ?? fileURLToPath(new URL("..", import.meta.url)),
    );
    findings.push(...(await scanWorkingTree(repoRoot)));
    if (!args.includes("--skip-history")) {
      findings.push(...scanGitHistory(repoRoot));
      scannedScope = "working tree (including ignored paths) and Git history";
    } else {
      scannedScope = "working tree (including ignored paths)";
    }
  }

  if (printFindings(findings) > 0) {
    process.exitCode = 1;
    return;
  }

  if (imageIndex >= 0) {
    const image = args[imageIndex + 1];
    if (!image) throw new Error("--image requires an image reference");
    if (scanImage(image) !== 0) {
      process.exitCode = 1;
      return;
    }
    scannedScope += " and container image";
  }

  console.log(
    `OK: clean-room scan found no participant-data artifacts in ${scannedScope}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
