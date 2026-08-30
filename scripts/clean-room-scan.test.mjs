import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanGitHistory,
  scanTree,
  scanWorkingTree,
} from "./clean-room-scan.mjs";

function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Clean Room Test",
      GIT_AUTHOR_EMAIL: "clean-room@example.test",
      GIT_COMMITTER_NAME: "Clean Room Test",
      GIT_COMMITTER_EMAIL: "clean-room@example.test",
    },
  });
}

function runCleanRoom(repository) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("clean-room-scan.mjs", import.meta.url)),
      "--repo-root",
      repository,
      "--skip-history",
    ],
    { encoding: "utf8" },
  );
}

function participantEmail() {
  return ["neighbor", "@", "porchfest", ".", "community"].join("");
}

function participantPhone() {
  return ["612", "555", "0100"].join("-");
}

function generatedMessageBody() {
  return [
    ["To", ": neighbor"].join(""),
    ["Subject", ": Porchfest"].join(""),
    ["Body", ": See you there"].join(""),
  ].join("\n");
}

async function withTemporaryDirectory(prefix, test) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await withTemporaryDirectory(
  "porchfest-clean-not-git-",
  async (notARepository) => {
    assert.throws(
      () => scanGitHistory(notARepository),
      new RegExp(
        `clean-room scan could not enumerate Git history in ${notARepository}`,
      ),
    );
  },
);

await withTemporaryDirectory("porchfest-clean-history-", async (repository) => {
  git(repository, "init", "--quiet");
  await mkdir(join(repository, "private"));
  await writeFile(
    join(repository, "private", "contacts.txt"),
    "participant record\n",
  );
  git(repository, "add", "private/contacts.txt");
  git(repository, "commit", "--quiet", "-m", "bad fixture");

  const findings = scanGitHistory(repository);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "prohibited private/ directory");
  assert.match(findings[0]?.location ?? "", /private\/contacts\.txt$/);
});

await withTemporaryDirectory("porchfest-clean-image-", async (imageRoot) => {
  await mkdir(join(imageRoot, "out"));
  await writeFile(join(imageRoot, "out", "submissions.csv"), "name,email\n");
  await writeFile(
    join(imageRoot, "delivery.eml"),
    "To: recipient\nSubject: Hi\nBody: hi\n",
  );

  const kinds = (await scanTree(imageRoot)).map(({ kind }) => kind);
  assert.ok(kinds.includes("prohibited out/ directory"));
  assert.ok(kinds.includes("raw export (.csv)"));
  assert.ok(kinds.includes("generated message body (.eml)"));
});

await withTemporaryDirectory(
  "porchfest-clean-synthetic-season-",
  async (imageRoot) => {
    const fixtureRoot = join(
      imageRoot,
      "packages",
      "core",
      "test",
      "fixtures",
      "season-synthetic",
    );
    await mkdir(join(fixtureRoot, "out"), { recursive: true });
    await mkdir(join(fixtureRoot, "private"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "out", "submissions.json"),
      '{"email":"fixture@example.invalid"}\n',
    );
    await writeFile(
      join(fixtureRoot, "private", "matches-2026.json"),
      '{"note":"synthetic only"}\n',
    );
    await writeFile(
      join(fixtureRoot, "private", "geocache.json"),
      '{"Synthetic Street":{"lat":10,"lng":20}}\n',
    );

    assert.deepEqual(await scanTree(imageRoot), []);
  },
);

await withTemporaryDirectory(
  "porchfest-clean-working-nul-",
  async (repository) => {
    git(repository, "init", "--quiet");
    await writeFile(
      join(repository, "notes.txt"),
      Buffer.from(`Contact ${participantEmail()}\n`, "utf16le"),
    );

    const findings = await scanWorkingTree(repository);
    assert.deepEqual(findings, [
      {
        kind: "possible participant email address",
        location: "working tree:notes.txt",
      },
    ]);
  },
);

await withTemporaryDirectory(
  "porchfest-clean-ignored-artifacts-",
  async (repository) => {
    git(repository, "init", "--quiet");
    await writeFile(
      join(repository, ".gitignore"),
      ["private/", "data/", "*.csv", "*.db", ""].join("\n"),
    );

    const privateDirectory = join(repository, "packages", "core", "private");
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(
      join(privateDirectory, "raw-export.csv"),
      "contact_name,contact_email,contact_phone\n",
    );

    const refused = runCleanRoom(repository);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /prohibited private\/ directory at working tree:packages\/core\/private\/raw-export\.csv/,
    );
    assert.match(
      refused.stderr,
      /raw export \(\.csv\) at working tree:packages\/core\/private\/raw-export\.csv/,
    );

    await rm(join(repository, "packages"), { recursive: true });
    const dataDirectory = join(repository, "data");
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, "porchfest.db"), "runtime data\n");

    const allowed = runCleanRoom(repository);
    assert.equal(allowed.status, 0);
    assert.match(allowed.stdout, /working tree \(including ignored paths\)/);
  },
);

await withTemporaryDirectory(
  "porchfest-clean-index-artifacts-",
  async (repository) => {
    git(repository, "init", "--quiet");
    await writeFile(join(repository, ".gitignore"), "private/\n*.csv\n");
    const privateDirectory = join(repository, "packages", "core", "private");
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(
      join(privateDirectory, "raw-export.csv"),
      "contact_name,contact_email,contact_phone\n",
    );
    git(repository, "add", "--force", "packages/core/private/raw-export.csv");
    await rm(join(repository, "packages"), { recursive: true });

    const refused = runCleanRoom(repository);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /prohibited private\/ directory at Git index:packages\/core\/private\/raw-export\.csv/,
    );
  },
);

await withTemporaryDirectory(
  "porchfest-clean-symlink-artifacts-",
  async (repository) => {
    git(repository, "init", "--quiet");
    await writeFile(join(repository, ".gitignore"), "private/\n*.csv\n");
    await writeFile(join(repository, "fixture.txt"), "participant record\n");
    const privateDirectory = join(repository, "packages", "core", "private");
    await mkdir(privateDirectory, { recursive: true });
    await symlink(
      join(repository, "fixture.txt"),
      join(privateDirectory, "raw-export.csv"),
    );

    const refused = runCleanRoom(repository);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /prohibited private\/ directory at working tree:packages\/core\/private\/raw-export\.csv/,
    );
  },
);

await withTemporaryDirectory(
  "porchfest-clean-history-nul-",
  async (repository) => {
    git(repository, "init", "--quiet");
    await writeFile(
      join(repository, "notes.txt"),
      Buffer.from(`Call ${participantPhone()}\n`, "utf16le"),
    );
    git(repository, "add", "notes.txt");
    git(repository, "commit", "--quiet", "-m", "bad NUL fixture");

    const findings = scanGitHistory(repository);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, "possible participant phone number");
    assert.match(findings[0]?.location ?? "", /^history [^:]+:notes\.txt$/);
  },
);

await withTemporaryDirectory(
  "porchfest-clean-image-nul-",
  async (imageRoot) => {
    await writeFile(
      join(imageRoot, "notes.txt"),
      Buffer.from(`${generatedMessageBody()}\n`, "utf16le"),
    );

    assert.deepEqual(await scanTree(imageRoot), [
      {
        kind: "generated message body headers",
        location: "image:notes.txt",
      },
    ]);
  },
);

await withTemporaryDirectory(
  "porchfest-clean-neutral-paths-",
  async (imageRoot) => {
    await writeFile(join(imageRoot, "notes.txt"), `${participantEmail()}\n`);
    await writeFile(
      join(imageRoot, "reminder.txt"),
      `Call ${participantPhone()}\n`,
    );
    await writeFile(
      join(imageRoot, "draft.txt"),
      `${generatedMessageBody()}\n`,
    );

    const kinds = (await scanTree(imageRoot)).map(({ kind }) => kind);
    assert.ok(kinds.includes("possible participant email address"));
    assert.ok(kinds.includes("possible participant phone number"));
    assert.ok(kinds.includes("generated message body headers"));
  },
);

console.log(
  "OK: clean-room self-test refuses participant-data artifacts and content",
);
