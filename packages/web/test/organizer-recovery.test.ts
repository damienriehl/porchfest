import { CORE_DATABASE_FILENAME, openCoreDatabase } from "@porchfest/core";
import { desc } from "drizzle-orm";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  main,
  ORGANIZER_RECOVERY_TTL_MS,
  runOrganizerLink,
  type OrganizerLinkOutput,
} from "../../../scripts/organizer-link.js";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import { ADMIN_SIGN_IN_PATH } from "../src/routes/admin.js";
import { organizerInvites } from "../../core/src/storage/schema.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function boot() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-recovery-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "recovery-test-session-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);
  return { runtime, announced, dataDirectory };
}

function bootstrapTokenFrom(announced: readonly string[]): string {
  return announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: OrganizerLinkOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { output, stdout, stderr };
}

async function createOrganizer(
  runtime: PorchfestRuntime,
  announced: readonly string[],
) {
  return runtime.core.access.redeemLink({
    token: bootstrapTokenFrom(announced),
    displayName: "Only Organizer",
    email: "only@example.invalid",
  }).organizer;
}

describe("organizer recovery links", () => {
  it("refuses an existing data directory without creating a database", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-recovery-"));
    temporaryRoots.push(dataDirectory);
    const databasePath = join(dataDirectory, CORE_DATABASE_FILENAME);
    const captured = captureOutput();

    const exitCode = await main(
      [],
      { PUBLIC_BASE_URL, PORCHFEST_DATA_DIR: dataDirectory },
      captured.output,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(databasePath);
    await expect(stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redeems a recovery link into a working session for the existing organizer", async () => {
    const { runtime, announced } = await boot();
    const organizer = await createOrganizer(runtime, announced);
    const captured = captureOutput();

    const exitCode = runOrganizerLink(
      runtime.core.access,
      PUBLIC_BASE_URL,
      undefined,
      captured.output,
    );

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    const expectedUrlPrefix = `    ${PUBLIC_BASE_URL}${ADMIN_SIGN_IN_PATH}?token=`;
    expect(captured.stdout.join("\n")).toContain(expectedUrlPrefix);
    const recoveryToken =
      captured.stdout.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const recovered = runtime.core.access.redeemLink({
      token: recoveryToken,
      displayName: "Ignored Replacement Name",
    });
    expect(recovered.organizer.id).toBe(organizer.id);
    expect(runtime.core.access.listOrganizers()).toHaveLength(1);
    expect(runtime.core.access.resolveSession(recovered.token)?.id).toBe(
      organizer.id,
    );

    // The printed URL is a bearer credential; a copy captured in transit must
    // be worthless after the organizer has signed in with it.
    expect(() =>
      runtime.core.access.redeemLink({
        token: recoveryToken,
        displayName: "Replay Attempt",
      }),
    ).toThrow("link was already used");
  });

  it("auto-selects the only active organizer and excludes deactivated candidates", async () => {
    const { runtime, announced } = await boot();
    const active = await createOrganizer(runtime, announced);
    const secondInvite = runtime.core.access.issueInvite(
      "deactivated@example.invalid",
      active.id,
    );
    const deactivated = runtime.core.access.redeemLink({
      token: secondInvite.token,
      displayName: "Deactivated Organizer",
    }).organizer;
    runtime.core.access.deactivateOrganizer(deactivated.id);
    const captured = captureOutput();

    const exitCode = runOrganizerLink(
      runtime.core.access,
      PUBLIC_BASE_URL,
      undefined,
      captured.output,
    );

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.join("\n")).toContain(active.email);
    expect(captured.stdout.join("\n")).not.toContain(deactivated.email);
  });

  it("refuses to issue a link when every organizer is deactivated", async () => {
    const { runtime, announced } = await boot();
    const organizer = await createOrganizer(runtime, announced);
    runtime.core.access.deactivateOrganizer(organizer.id);
    const captured = captureOutput();

    const exitCode = runOrganizerLink(
      runtime.core.access,
      PUBLIC_BASE_URL,
      undefined,
      captured.output,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      "No active organizer accounts exist",
    );
    expect(captured.stderr.join("\n")).toContain("deactivated account");
  });

  it("ignores partial anti-bot configuration and issues a one-hour recovery link", async () => {
    const { runtime, announced, dataDirectory } = await boot();
    await createOrganizer(runtime, announced);
    const captured = captureOutput();

    const exitCode = await main(
      [],
      {
        PUBLIC_BASE_URL,
        PORCHFEST_DATA_DIR: dataDirectory,
        PORCHFEST_TURNSTILE_SITE_KEY: "partial-config-must-not-matter",
      },
      captured.output,
    );

    expect(exitCode).toBe(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout.join("\n")).toContain("expires in one hour");

    const connection = openCoreDatabase(
      join(dataDirectory, CORE_DATABASE_FILENAME),
    );
    try {
      const invite = connection.database
        .select()
        .from(organizerInvites)
        .orderBy(desc(organizerInvites.id))
        .get();
      expect(invite).toBeDefined();
      expect(invite!.expiresAt.valueOf() - invite!.createdAt.valueOf()).toBe(
        ORGANIZER_RECOVERY_TTL_MS,
      );
    } finally {
      connection.close();
    }
  });

  it("refuses to guess when several organizers exist and lists candidates", async () => {
    const { runtime, announced } = await boot();
    const first = await createOrganizer(runtime, announced);
    const secondInvite = runtime.core.access.issueInvite(
      "second@example.invalid",
      first.id,
    );
    const second = runtime.core.access.redeemLink({
      token: secondInvite.token,
      displayName: "Second Organizer",
    }).organizer;
    const captured = captureOutput();

    const exitCode = runOrganizerLink(
      runtime.core.access,
      PUBLIC_BASE_URL,
      undefined,
      captured.output,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      `${first.id}: only@example.invalid`,
    );
    expect(captured.stderr.join("\n")).toContain(
      `${second.id}: second@example.invalid`,
    );
  });

  it("returns non-zero when the named organizer does not exist", async () => {
    const { runtime, announced } = await boot();
    await createOrganizer(runtime, announced);
    const captured = captureOutput();

    const exitCode = runOrganizerLink(
      runtime.core.access,
      PUBLIC_BASE_URL,
      "missing@example.invalid",
      captured.output,
    );

    expect(exitCode).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join("\n")).toContain(
      'Organizer "missing@example.invalid" was not found.',
    );
  });
});
