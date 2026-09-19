import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import {
  createRetentionSweep,
  RETENTION_SWEEP_INTERVAL_MS,
} from "../src/retention-sweep.js";

const roots: string[] = [];
const runtimes: PorchfestRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function boot() {
  const root = await mkdtemp(join(tmpdir(), "porchfest-sweep-boundaries-"));
  roots.push(root);
  const runtime = await createRuntime({
    dataDirectory: root,
    env: { PORCHFEST_SESSION_SECRET: "synthetic-sweep-boundary-secret" },
    announce: () => undefined,
  });
  runtimes.push(runtime);
  return runtime;
}

describe("retention sweep recovery boundaries", () => {
  it("reserves a failed scheduling attempt but allows a later real database scan", async () => {
    const runtime = await boot();
    const logs: string[] = [];
    const pending: Array<() => void> = [];
    let now = 0;
    let rejectSchedule = true;
    const sweep = createRetentionSweep(runtime.core, {
      now: () => now,
      log: (message) => logs.push(message),
      defer: (run) => {
        if (rejectSchedule) throw new Error("synthetic scheduler detail");
        pending.push(run);
      },
    });
    expect(sweep.onOrganizerActivity()).toBe(false);
    expect(logs).toEqual([
      "Retention sweep failed; application startup and organizer work will continue.",
    ]);
    rejectSchedule = false;
    now = RETENTION_SWEEP_INTERVAL_MS - 1;
    expect(sweep.onOrganizerActivity()).toBe(false);
    now++;
    expect(sweep.onOrganizerActivity()).toBe(true);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(runtime.core.retention.listReceipts()).toEqual([]);
    expect(logs).toHaveLength(1);
    now += RETENTION_SWEEP_INTERVAL_MS;
    expect(sweep.onOrganizerActivity()).toBe(true);
    pending.shift()!();
  });

  it("keeps a queued scan exclusive even after another interval has elapsed", async () => {
    const runtime = await boot();
    let now = 0;
    const pending: Array<() => void> = [];
    const sweep = createRetentionSweep(runtime.core, {
      now: () => now,
      defer: (run) => pending.push(run),
    });
    expect(sweep.onOrganizerActivity()).toBe(true);
    now += RETENTION_SWEEP_INTERVAL_MS * 2;
    expect(sweep.onOrganizerActivity()).toBe(false);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    expect(sweep.onOrganizerActivity()).toBe(true);
    pending.shift()!();
    expect(runtime.core.retention.listReceipts()).toEqual([]);
  });

  it("contains actual closed-database errors on boot and deferred activity", async () => {
    const runtime = await boot();
    runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const logs: string[] = [];
    let now = 0;
    const sweep = createRetentionSweep(runtime.core, {
      now: () => now,
      log: (message) => logs.push(message),
    });
    expect(() => sweep.onBoot()).not.toThrow();
    expect(sweep.onOrganizerActivity()).toBe(false);
    now += RETENTION_SWEEP_INTERVAL_MS;
    expect(sweep.onOrganizerActivity()).toBe(true);
    await Promise.resolve();
    expect(logs).toEqual(
      Array(2).fill(
        "Retention sweep failed; application startup and organizer work will continue.",
      ),
    );
    expect(sweep.onOrganizerActivity()).toBe(false);
    now += RETENTION_SWEEP_INTERVAL_MS;
    expect(sweep.onOrganizerActivity()).toBe(true);
    await Promise.resolve();
    expect(logs).toHaveLength(3);
  });
});
