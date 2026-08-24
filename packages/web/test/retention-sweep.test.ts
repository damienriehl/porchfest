// R35: retention enforcement is tied to boot and real organizer activity, with
// no scheduler keeping an otherwise idle container awake.
import type { CoreRuntime } from "@porchfest/core";
import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  RETENTION_SWEEP_INTERVAL_MS,
  createRetentionSweep,
} from "../src/retention-sweep.js";
import { RouteRegistry } from "../src/router/registry.js";

function coreWithSweep(sweep: () => unknown): CoreRuntime {
  return {
    retention: { anonymizeEligible: sweep },
  } as unknown as CoreRuntime;
}

describe("opportunistic retention sweep", () => {
  it("runs on boot and defers organizer-triggered work until the throttle allows", () => {
    let now = 0;
    const deferred: Array<() => void> = [];
    const anonymizeEligible = vi.fn(() => []);
    const sweep = createRetentionSweep(coreWithSweep(anonymizeEligible), {
      now: () => now,
      defer: (run) => deferred.push(run),
    });

    sweep.onBoot();
    expect(anonymizeEligible).toHaveBeenCalledTimes(1);

    expect(sweep.onOrganizerActivity()).toBe(false);
    expect(deferred).toHaveLength(0);

    now = RETENTION_SWEEP_INTERVAL_MS;
    expect(sweep.onOrganizerActivity()).toBe(true);
    expect(sweep.onOrganizerActivity()).toBe(false);
    expect(anonymizeEligible).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);

    deferred.shift()?.();
    expect(anonymizeEligible).toHaveBeenCalledTimes(2);
  });

  it("logs a fixed message and keeps boot and organizer work alive after failures", async () => {
    let now = 0;
    const deferred: Array<() => void> = [];
    const log = vi.fn();
    const sweep = createRetentionSweep(
      coreWithSweep(() => {
        throw new Error("private database detail");
      }),
      {
        now: () => now,
        defer: (run) => deferred.push(run),
        log,
      },
    );

    expect(() => sweep.onBoot()).not.toThrow();
    expect(log).toHaveBeenLastCalledWith(
      "Retention sweep failed; application startup and organizer work will continue.",
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain(
      "private database detail",
    );

    now = RETENTION_SWEEP_INTERVAL_MS;
    const app = new Hono();
    const routes = new RouteRegistry(app, () => true, undefined, {
      onOrganizerActivity: sweep.onOrganizerActivity,
    });
    routes.register({
      method: "GET",
      path: "/admin-work",
      tier: "organizer",
      handler: (context: Context) => context.text("still working"),
    });

    const response = await app.request("/admin-work");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("still working");
    expect(deferred).toHaveLength(1);
    expect(() => deferred.shift()?.()).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not treat denied or participant requests as organizer activity", async () => {
    const onOrganizerActivity = vi.fn();
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      (tier) => tier === "participant",
      undefined,
      { onOrganizerActivity },
    );
    routes.register({
      method: "GET",
      path: "/participant",
      tier: "participant",
      handler: (context: Context) => context.text("participant"),
    });
    routes.register({
      method: "GET",
      path: "/organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    expect((await app.request("/participant")).status).toBe(200);
    expect((await app.request("/organizer")).status).toBe(401);
    expect(onOrganizerActivity).not.toHaveBeenCalled();
  });
});
