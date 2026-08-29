// R35: prove the composition root uses the configured window for automatic
// boot and organizer-activity sweeps, including the fail-closed default.
import { ANONYMIZED_CONTACT_NAME } from "@porchfest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import { RETENTION_SWEEP_INTERVAL_MS } from "../src/retention-sweep.js";

const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function dataDirectory() {
  const root = await mkdtemp(join(tmpdir(), "porchfest-sweep-integration-"));
  temporaryRoots.push(root);
  return root;
}

async function boot(
  root: string,
  retentionMonths = "24",
  authorize?: () => boolean,
) {
  const runtime = await createRuntime({
    dataDirectory: root,
    env: {
      PORCHFEST_RETENTION_MONTHS: retentionMonths,
      PORCHFEST_SESSION_SECRET: "retention-sweep-test-secret",
    },
    authorize,
    announce: () => undefined,
  });
  runtimes.push(runtime);
  return runtime;
}

function createParticipant(runtime: PorchfestRuntime) {
  const { season } = runtime.core.setup.createSeason({
    year: 2030,
    displayName: "Synthetic Sweep Season",
    timezone: "UTC",
    eventDate: "2030-09-14",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [],
    openSignups: true,
  });
  return runtime.core.seasons.createPerformerSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic Sweep Participant",
      email: "synthetic-sweep@example.invalid",
      phone: "synthetic-sweep-phone",
    },
    act: {
      name: "Synthetic Sweep Act",
      genre: "Synthetic genre",
      description: "Synthetic description",
      links: "https://example.invalid/synthetic-sweep",
      durationMinutes: 30,
      requiresAmplification: false,
      housePreference: null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [],
  });
}

describe("retention sweep composition", () => {
  it("anonymizes eligible records on boot and writes one retention receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    const root = await dataDirectory();
    const first = await boot(root);
    const signup = createParticipant(first);
    first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    vi.setSystemTime(new Date("2032-02-15T12:00:00.000Z"));
    const second = await boot(root);

    expect(
      second.core.retention.findParticipant(signup.contact.id),
    ).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
    });
    expect(second.core.retention.listReceipts()).toMatchObject([
      { contactId: signup.contact.id, action: "retention" },
    ]);
  });

  it("does nothing on an empty boot", async () => {
    const runtime = await boot(await dataDirectory());

    expect(runtime.core.retention.listEligible()).toEqual([]);
    expect(runtime.core.retention.listReceipts()).toEqual([]);
  });

  it("uses the 24-month default for invalid configuration on the boot path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    const root = await dataDirectory();
    const first = await boot(root);
    const signup = createParticipant(first);
    first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    vi.setSystemTime(new Date("2031-01-15T12:00:00.000Z"));
    const second = await boot(root, "invalid");

    expect(second.core.retention.retentionMonths).toBe(24);
    expect(
      second.core.retention.findParticipant(signup.contact.id),
    ).toMatchObject({
      name: "Synthetic Sweep Participant",
      email: "synthetic-sweep@example.invalid",
      phone: "synthetic-sweep-phone",
    });
    expect(second.core.retention.listReceipts()).toEqual([]);
  });

  it("leaves a record inside the configured window untouched on boot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    const root = await dataDirectory();
    const first = await boot(root, "18");
    const signup = createParticipant(first);
    first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    vi.setSystemTime(new Date("2031-07-14T12:00:00.000Z"));
    const second = await boot(root, "18");

    expect(second.core.retention.findParticipant(signup.contact.id)?.name).toBe(
      "Synthetic Sweep Participant",
    );
    expect(second.core.retention.listReceipts()).toEqual([]);
  });

  it("defers an authorized admin sweep and suppresses it inside the throttle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
    let monotonicNow = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    const runtime = await boot(await dataDirectory(), "24", () => true);
    const signup = createParticipant(runtime);
    vi.setSystemTime(new Date("2032-02-15T12:00:00.000Z"));

    monotonicNow = RETENTION_SWEEP_INTERVAL_MS - 1;
    expect((await runtime.request("/admin/setup")).status).toBe(200);
    expect(
      runtime.core.retention.findParticipant(signup.contact.id)?.name,
    ).toBe("Synthetic Sweep Participant");

    monotonicNow = RETENTION_SWEEP_INTERVAL_MS;
    expect((await runtime.request("/admin/setup")).status).toBe(200);
    await Promise.resolve();
    expect(
      runtime.core.retention.findParticipant(signup.contact.id)?.name,
    ).toBe(ANONYMIZED_CONTACT_NAME);
    expect(runtime.core.retention.listReceipts()).toMatchObject([
      { contactId: signup.contact.id, action: "retention" },
    ]);
  });
});
