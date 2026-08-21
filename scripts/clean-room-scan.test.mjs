import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
