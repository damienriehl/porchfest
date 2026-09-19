import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderSeasonLifecyclePage,
  stoppedActions,
} from "../src/views/season-lifecycle.js";
import { createTestingRuntime } from "../src/composition.js";

describe("lifecycle warnings follow real domain legality", () => {
  it("warns only about actions lost when signups close", () => {
    expect(stoppedActions("signups_open", "signups_closed")).toEqual([
      "signup",
    ]);
  });
  it("warns about signup, assignment, and holds when locking", () => {
    expect(stoppedActions("assigning", "locked")).toEqual([
      "signup",
      "assignment",
      "hold",
    ]);
  });
  it("warns that archive removes remaining correction and release powers", () => {
    expect(stoppedActions("locked", "archived")).toEqual([
      "hold_release",
      "correction",
    ]);
  });
  it("reports no new restrictions for a transition that only adds powers", () => {
    expect(stoppedActions("setup", "signups_open")).toEqual([]);
    expect(stoppedActions("signups_closed", "assigning")).toEqual([]);
    expect(stoppedActions("archived", "archived")).toEqual([]);
  });
  it("renders real persisted season state, confirmation requirements, and archived empty state", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-lifecycle-view-"),
    );
    const runtime = await createTestingRuntime({
      dataDirectory,
      env: { PORCHFEST_SESSION_SECRET: "synthetic-lifecycle-view-secret" },
      announce: () => undefined,
    });
    try {
      const { season } = runtime.core.setup.createSeason({
        year: 2031,
        displayName: "Synthetic <Season>",
        timezone: "UTC",
        eventDate: "2031-06-01",
        eventCity: "Exampleton",
        eventState: "WI",
        timeSlots: [],
        openSignups: true,
      });
      const options = {
        season,
        heldSlotCount: 1,
        csrfToken: 'csrf"test',
        signupUrls: null,
        publicMapUrl: null,
      };
      const html = renderSeasonLifecyclePage(options);
      expect(html).toContain("Synthetic &lt;Season&gt;");
      expect(html).toContain('value="csrf&quot;test"');
      expect(html).toContain('id="confirmation-locked"');
      expect(html).toContain('id="confirmation-archived"');
      expect(html).not.toContain('id="confirmation-signups_closed"');
      expect(html).toContain(
        "1 slot is still held; release it before archiving.",
      );
      expect(html).not.toContain('value="setup"');
      expect(
        renderSeasonLifecyclePage({ ...options, heldSlotCount: 2 }),
      ).toContain("2 slots are still held; release them before archiving.");
      expect(
        renderSeasonLifecyclePage({ ...options, heldSlotCount: 0 }),
      ).not.toContain("still held");
      const errorHtml = renderSeasonLifecyclePage({
        ...options,
        error: "<Conflict>",
        transitioned: true,
      });
      expect(errorHtml).toContain("&lt;Conflict&gt;");
      expect(errorHtml).not.toContain("Season moved to");
      const archived = runtime.core.seasons.transitionSeason(
        season.id,
        season.version,
        "archived",
      );
      const archivedHtml = renderSeasonLifecyclePage({
        ...options,
        season: archived,
        heldSlotCount: 0,
        transitioned: true,
      });
      expect(archivedHtml).toContain("Season moved to archived.");
      expect(archivedHtml).toContain("No further transitions are available.");
      expect(archivedHtml).not.toContain('name="target_state"');
    } finally {
      runtime.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
