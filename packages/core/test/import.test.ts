import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnnotationRepository } from "../src/annotations.js";
import { createGeocodingRepository } from "../src/geocoding.js";
import { createImportKeyRepository } from "../src/import-keys.js";
import {
  importGoal1Season,
  type Goal1ImportCore,
  type ImportReport,
} from "../src/import/goal1.js";
import type { GeoPort } from "../src/ports/geo.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import {
  acts,
  annotations,
  assignments,
  contacts,
  importKeys,
  seasons,
  slots,
  venueCoordinates,
  venues,
} from "../src/storage/schema.js";
import { generateSeasonFixture } from "./fixtures/season-synthetic/generate.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/season-synthetic/", import.meta.url),
);
const fixtureArtifactFiles = {
  submissions: "synthetic.submissions.json",
  slate: "slate.synthetic.json",
  geocache: "synthetic.geocache.json",
} as const;
const beforeDecideBy = new Date("2026-08-31T12:00:00.000Z");
const importOptions = {
  artifactsDirectory: fixtureDirectory,
  artifactFiles: fixtureArtifactFiles,
  localityName: "Synthetic Lantern District",
  bounds: { north: 10.5, south: 9.5, east: 20.5, west: 19.5 },
  timezone: "America/Chicago",
  now: () => beforeDecideBy,
} as const;

const offlineGeo: GeoPort = {
  name: "offline-test",
  configured: false,
  async locate() {
    return { kind: "unavailable", reason: "offline synthetic test" };
  },
  async geocode() {
    return null;
  },
};

describe("Goal-1 season import (U10 / KTD13)", () => {
  let database: TestDatabase;
  let core: Goal1ImportCore;

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-goal1-import-");
    core = makeCore(database, () => beforeDecideBy);
  });

  afterEach(async () => {
    await database.close();
  });

  function runImport(): ImportReport {
    return importGoal1Season(core, importOptions);
  }

  it("R23: importing the synthetic fidelity shapes yields 22 slate venues and 20 active canonical venues", () => {
    const report = runImport();
    const activeVenues = database.db
      .select({ total: sql<number>`count(*)` })
      .from(venues)
      .where(
        and(isNull(venues.canonicalVenueId), ne(venues.status, "withdrawn")),
      )
      .get()!.total;
    const approvedActs = database.db
      .select({ total: sql<number>`count(distinct ${assignments.actId})` })
      .from(assignments)
      .get()!.total;
    const holds = database.db
      .select({ total: sql<number>`count(*)` })
      .from(slots)
      .where(eq(slots.state, "held"))
      .get()!.total;

    expect(activeVenues).toBe(20);
    expect(approvedActs + holds).toBe(21);
    expect(database.db.select().from(assignments).all()).toHaveLength(32);
    expect(database.db.select().from(venues).all()).toHaveLength(25);
    expect(database.db.select().from(acts).all()).toHaveLength(33);
    expect(database.db.select().from(contacts).all()).toHaveLength(53);
    expect(report.records.venue.created).toBe(25);
    expect(report.records.act.created).toBe(33);
    expect(report.records.assignment.created).toBe(38);
    expect(report.summary).toEqual({
      slateVenues: 22,
      approvedActEntries: 21,
      placeholderActs: 6,
      placeholderVenues: 2,
      unmatchedVenues: 1,
      floatingPerformers: 1,
    });
    expect(report.supersessions).toHaveLength(3);
    expect(report.holds).toHaveLength(1);

    const unmatchedVenueKey = core.importKeys.find(
      report.seasonId,
      "goal1:host-venue",
      "2026-05-23T10:00:00Z",
    );
    const floatingActKey = core.importKeys.find(
      report.seasonId,
      "goal1:performer-act",
      "2026-05-27T11:00:00Z",
    );
    expect(unmatchedVenueKey).not.toBeNull();
    expect(floatingActKey).not.toBeNull();
    expect(
      database.db
        .select()
        .from(assignments)
        .innerJoin(slots, eq(slots.id, assignments.slotId))
        .where(eq(slots.venueId, unmatchedVenueKey!.recordId))
        .all(),
    ).toEqual([]);
    expect(
      database.db
        .select()
        .from(assignments)
        .where(eq(assignments.actId, floatingActKey!.recordId))
        .all(),
    ).toEqual([]);
  });

  it("R23: re-running the import changes no row count or version", () => {
    runImport();
    const before = versionSnapshot(database);
    const second = runImport();
    const after = versionSnapshot(database);

    expect(after).toEqual(before);
    for (const counts of Object.values(second.records)) {
      expect(counts.created).toBe(0);
    }
    expect(second.records.venue.found).toBe(25);
    expect(second.records.act.found).toBe(33);
    expect(second.records.contact.found).toBe(53);
    expect(second.records.coordinate.found).toBe(20);
    expect(second.records.annotation.found).toBe(before.counts.annotations);
    expect(second.annotationCount).toBe(before.counts.annotations);
    expect(second.supersessions.every(({ status }) => status === "found")).toBe(
      true,
    );
    expect(second.holds).toEqual([
      expect.objectContaining({ status: "found" }),
    ]);
    expect(
      second.placeholderActs.map(
        ({ virtualPerformerKey, reachVia, status }) => [
          virtualPerformerKey,
          reachVia,
          status,
        ],
      ),
    ).toEqual([
      ["virtual-act-1", "manual_contact", "found"],
      ["virtual-act-2", "slot", "found"],
      ["virtual-act-3", "slot", "found"],
      ["virtual-act-4", "chase", "found"],
      ["virtual-act-5", "chase", "found"],
      ["virtual-act-6", "timestamp", "found"],
    ]);
  });

  it("R29: re-running an invalid geocache entry preserves its null-normalized row version", async () => {
    const temporary = await copyFixture("porchfest-invalid-coordinate-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const address = Object.keys(geocache)[2]!;
      geocache[address].lat = 91;
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      const options = { ...importOptions, artifactsDirectory: temporary };
      importGoal1Season(core, options);
      const before = database.db
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.rejectionCode, "invalid-coordinate"))
        .get()!;

      const second = importGoal1Season(core, options);
      const after = database.db
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.id, before.id))
        .get()!;

      expect(before).toMatchObject({
        latitude: null,
        longitude: null,
        status: "needs-review",
      });
      expect(after).toEqual(before);
      expect(second.records.coordinate).toMatchObject({
        created: 0,
        found: 20,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: fidelity summary counts only venue entries that resolve", async () => {
    const temporary = await copyFixture("porchfest-unresolved-venue-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[0].host_ts = "missing-host-natural-key";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      expect(report.summary.slateVenues).toBe(21);
      expect(report.warnings).toContain(
        "Venue entry did not resolve: venue-01",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: date_display produces one deterministic season across host timezones", async () => {
    const temporary = await copyFixture("porchfest-date-display-");
    const previousTimezone = process.env.TZ;
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      delete matches.event.date;
      matches.event.date_display = "September 16, 2026";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const options = { ...importOptions, artifactsDirectory: temporary };

      process.env.TZ = "Pacific/Auckland";
      const first = importGoal1Season(core, options);
      matches.event.date_display = "Wednesday, September 16";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      process.env.TZ = "America/Los_Angeles";
      const second = importGoal1Season(core, { ...options, eventYear: 2026 });

      expect(second.seasonId).toBe(first.seasonId);
      const importedSeasons = database.db.select().from(seasons).all();
      expect(importedSeasons).toHaveLength(1);
      expect(importedSeasons[0]!.eventDate).toBe("2026-09-16");

      matches.event.date_display = "wednesday September 16 2026";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const alternatePunctuation = importGoal1Season(core, options);
      expect(alternatePunctuation.seasonId).toBe(first.seasonId);

      matches.event.date_display = "Wednesday, September 16";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      expect(() => importGoal1Season(core, options)).toThrow(
        "Event date_display has no year; pass --event-year YYYY",
      );

      matches.event.date_display = "Funday, September 16";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      expect(() =>
        importGoal1Season(core, { ...options, eventYear: 2026 }),
      ).toThrow(
        "Event date_display must use a month-name date such as September 16, 2026: Funday, September 16",
      );
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rolls back direct core imports when a late artifact error occurs", async () => {
    const temporary = await copyFixture("porchfest-direct-rollback-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const activeAddress = Object.keys(geocache)[2]!;
      geocache[activeAddress].lat = "not-a-coordinate";
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      expect(() =>
        importGoal1Season(core, {
          ...importOptions,
          artifactsDirectory: temporary,
        }),
      ).toThrow("geocache latitude must be a finite number");

      expect(database.db.select().from(seasons).all()).toEqual([]);
      expect(database.db.select().from(venues).all()).toEqual([]);
      expect(database.db.select().from(acts).all()).toEqual([]);
      expect(database.db.select().from(contacts).all()).toEqual([]);
      expect(database.db.select().from(importKeys).all()).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R26: reach_via host and manual_contact tokens resolve alongside the timestamp fallback", async () => {
    const matches = await readFixture<{
      virtual_performers: Record<
        string,
        { reach_via: string; manual_contact?: string }
      >;
      venues: {
        host_ts?: string;
        chase: string[];
        slots: Record<string, { virtual_performer?: string }>;
      }[];
    }>(fixtureArtifactFiles.slate);
    const report = runImport();
    const { seasonId } = report;
    const placeholders = database.db
      .select()
      .from(acts)
      .where(and(eq(acts.seasonId, seasonId), eq(acts.placeholder, true)))
      .all();

    expect(placeholders).toHaveLength(6);
    for (const act of placeholders) {
      expect(act.reachViaContactId).not.toBeNull();
      const resolved = core.seasons.resolveContact(act.reachViaContactId!);
      expect(resolved.canonical.email).toMatch(/@example\.invalid$/);
    }
    for (const [virtualKey, performer] of Object.entries(
      matches.virtual_performers,
    )) {
      const act = core.seasons.getAct(
        core.importKeys.find(seasonId, "goal1:virtual-performer", virtualKey)!
          .recordId,
      );
      let expectedContactId: number;
      if (performer.reach_via === "manual_contact") {
        expectedContactId = core.importKeys.find(
          seasonId,
          "goal1:manual-contact",
          performer.manual_contact!,
        )!.recordId;
      } else if (performer.reach_via === "host") {
        const venue = matches.venues.find(
          ({ chase, slots }) =>
            Object.values(slots).some(
              ({ virtual_performer }) => virtual_performer === virtualKey,
            ) || chase.some((entry) => containsWholeToken(entry, virtualKey)),
        )!;
        expectedContactId = core.importKeys.find(
          seasonId,
          "goal1:host-contact",
          venue.host_ts!,
        )!.recordId;
      } else {
        expectedContactId = core.importKeys.find(
          seasonId,
          "goal1:performer-contact",
          performer.reach_via,
        )!.recordId;
      }
      expect(act.reachViaContactId, virtualKey).toBe(expectedContactId);
    }
    expect(
      report.placeholderActs.map(({ virtualPerformerKey, reachVia }) => [
        virtualPerformerKey,
        reachVia,
      ]),
    ).toEqual([
      ["virtual-act-1", "manual_contact"],
      ["virtual-act-2", "slot"],
      ["virtual-act-3", "slot"],
      ["virtual-act-4", "chase"],
      ["virtual-act-5", "chase"],
      ["virtual-act-6", "timestamp"],
    ]);
    for (const manualKey of [
      "manual-paper-comet",
      "manual-extra-one",
      "manual-extra-two",
    ]) {
      const manual = core.importKeys.find(
        seasonId,
        "goal1:manual-contact",
        manualKey,
      );
      expect(manual).not.toBeNull();
      expect(
        core.annotations
          .listAnnotations(seasonId, "contact", manual!.recordId)
          .some(({ note }) => note.startsWith("Contact sourced from 2025")),
      ).toBe(true);
    }
  });

  it("virtual_performer slots name exactly two host-reached acts and preserve the slot note", async () => {
    const matches = await readFixture<{
      virtual_performers: Record<string, { reach_via: string }>;
      venues: {
        host_ts: string;
        slots: Record<string, { virtual_performer?: string; note?: string }>;
      }[];
    }>(fixtureArtifactFiles.slate);
    const virtualSlots = matches.venues.flatMap(({ host_ts, slots }) =>
      Object.entries(slots).flatMap(([slotLabel, slot]) =>
        slot.virtual_performer ? [{ host_ts, slotLabel, ...slot }] : [],
      ),
    );

    expect(
      virtualSlots.map(({ virtual_performer }) => virtual_performer),
    ).toEqual(["virtual-act-2", "virtual-act-3"]);
    expect(
      virtualSlots.map(
        ({ virtual_performer }) =>
          matches.virtual_performers[virtual_performer!]!.reach_via,
      ),
    ).toEqual(["host", "host"]);
    expect(virtualSlots.filter(({ note }) => note)).toHaveLength(1);

    const { seasonId } = runImport();
    const notedSlot = virtualSlots.find(({ note }) => note)!;
    const venueId = core.importKeys.find(
      seasonId,
      "goal1:host-venue",
      notedSlot.host_ts,
    )!.recordId;
    expect(
      core.annotations
        .listAnnotations(seasonId, "venue", venueId)
        .map(({ note }) => note),
    ).toContain(`Slot ${notedSlot.slotLabel}: ${notedSlot.note}`);
  });

  it("an unassigned host reach warns and falls back to manual_contact when supplied", async () => {
    const temporary = await copyFixture("porchfest-virtual-manual-fallback-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[2].slots["7-8"] = { open: true };
      matches.virtual_performers["virtual-act-2"].manual_contact =
        "manual-paper-comet";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const act = core.seasons.getAct(
        core.importKeys.find(
          report.seasonId,
          "goal1:virtual-performer",
          "virtual-act-2",
        )!.recordId,
      );
      const manual = core.importKeys.find(
        report.seasonId,
        "goal1:manual-contact",
        "manual-paper-comet",
      )!;

      expect(act.reachViaContactId).toBe(manual.recordId);
      expect(report.placeholderActs).toContainEqual(
        expect.objectContaining({
          virtualPerformerKey: "virtual-act-2",
          reachVia: "manual_contact",
        }),
      );
      expect(report.summary.placeholderActs).toBe(6);
      expect(report.warnings).toContain(
        "Virtual performer reach-via did not resolve: virtual-act-2",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("a previously imported placeholder stays found when its reach no longer resolves", async () => {
    const temporary = await copyFixture("porchfest-virtual-found-rerun-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const options = { ...importOptions, artifactsDirectory: temporary };
      const first = importGoal1Season(core, options);
      const original = first.placeholderActs.find(
        ({ virtualPerformerKey }) => virtualPerformerKey === "virtual-act-2",
      )!;

      matches.venues[2].slots["7-8"] = { open: true };
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const second = importGoal1Season(core, options);

      expect(second.placeholderActs).toContainEqual(
        expect.objectContaining({
          virtualPerformerKey: "virtual-act-2",
          actId: original.actId,
          status: "found",
        }),
      );
      expect(second.records.act.skipped).toBe(0);
      expect(second.warnings).not.toContain(
        "Virtual performer reach-via did not resolve: virtual-act-2",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("a chase key in two venues uses the first exact whole-token match and warns", async () => {
    const temporary = await copyFixture("porchfest-virtual-chase-ambiguous-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[0].chase.push(
        "Do not confuse virtual-act-4ville with the requested placeholder.",
      );
      matches.venues[1].chase.push(
        "Please contact VIRTUAL-ACT-4 through this earlier synthetic host.",
      );
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const act = core.seasons.getAct(
        core.importKeys.find(
          report.seasonId,
          "goal1:virtual-performer",
          "virtual-act-4",
        )!.recordId,
      );
      const firstExactHost = core.importKeys.find(
        report.seasonId,
        "goal1:host-contact",
        matches.venues[1].host_ts,
      )!;

      expect(act.reachViaContactId).toBe(firstExactHost.recordId);
      expect(report.warnings).toContain(
        "Virtual performer chase matched multiple venues; using first: virtual-act-4",
      );
      expect(report.placeholderActs).toContainEqual(
        expect.objectContaining({
          virtualPerformerKey: "virtual-act-4",
          reachVia: "chase",
        }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("a naming slot takes precedence over an earlier chase mention", async () => {
    const temporary = await copyFixture("porchfest-virtual-slot-first-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[0].chase.push(
        "Please contact virtual-act-2 through this synthetic host.",
      );
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const act = core.seasons.getAct(
        core.importKeys.find(
          report.seasonId,
          "goal1:virtual-performer",
          "virtual-act-2",
        )!.recordId,
      );
      const slotHost = core.importKeys.find(
        report.seasonId,
        "goal1:host-contact",
        matches.venues[2].host_ts,
      )!;

      expect(act.reachViaContactId).toBe(slotHost.recordId);
      expect(report.placeholderActs).toContainEqual(
        expect.objectContaining({
          virtualPerformerKey: "virtual-act-2",
          reachVia: "slot",
        }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("an unassigned virtual performer without manual_contact is skipped with its key named", async () => {
    const temporary = await copyFixture("porchfest-virtual-unresolved-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[3].slots["7-8"] = { open: true };
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });

      expect(report.summary.placeholderActs).toBe(5);
      expect(report.records.act.skipped).toBe(1);
      expect(report.warnings).toContain(
        "Virtual performer reach-via did not resolve: virtual-act-3",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R16/AE2: canceled slots import assignment history, propagate through same_as, and disappear from the season listing", async () => {
    const matches = await readFixture<{
      venues: {
        id: string;
        host_ts?: string;
        virtual_venue?: string;
        slots: Record<
          string,
          {
            canceled?: { on: string; reason: string };
            same_as?: string;
          }
        >;
      }[];
    }>(fixtureArtifactFiles.slate);
    const report = runImport();
    const canceledSlots = matches.venues.flatMap((venue) =>
      Object.entries(venue.slots).flatMap(([slotLabel, slot]) =>
        slot.canceled ? [{ venue, slotLabel, canceled: slot.canceled }] : [],
      ),
    );

    expect(canceledSlots).toHaveLength(3);
    expect(report.records.assignment.created).toBe(38);
    for (const { venue, slotLabel, canceled } of canceledSlots) {
      const venueKey = venue.host_ts
        ? core.importKeys.find(
            report.seasonId,
            "goal1:host-venue",
            venue.host_ts,
          )
        : core.importKeys.find(
            report.seasonId,
            "goal1:virtual-venue",
            venue.virtual_venue!,
          );
      const slotIndex = slotLabel === "6-7" ? 0 : 1;
      const importedSlot = core.seasons.listVenueSlots(venueKey!.recordId)[
        slotIndex
      ]!;
      expect(importedSlot.state).toBe("open");
      expect(
        core.seasons
          .listAssignments(report.seasonId)
          .some(({ slotId }) => slotId === importedSlot.id),
      ).toBe(false);
      const canceledAnnotation = database.db
        .select()
        .from(annotations)
        .where(
          sql`${annotations.note} = ${`Canceled on ${canceled.on}: ${canceled.reason}`}`,
        )
        .get();
      expect(canceledAnnotation).toBeDefined();
      expect(core.seasons.getAct(canceledAnnotation!.recordId).status).toBe(
        "withdrawn",
      );

      const partner = Object.entries(venue.slots).find(
        ([, slot]) => slot.same_as === slotLabel,
      );
      expect(partner).toBeDefined();
      const partnerSlot = core.seasons.listVenueSlots(venueKey!.recordId)[
        partner![0] === "6-7" ? 0 : 1
      ]!;
      expect(partnerSlot.state).toBe("open");
    }
  });

  it("a canceled same_as continuation also cancels its source partner", async () => {
    const temporary = await copyFixture("porchfest-canceled-continuation-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const venue = matches.venues[4];
      venue.slots["7-8"].canceled = {
        on: "2026-08-18",
        reason: "Invented continuation cancellation.",
      };
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const venueId = core.importKeys.find(
        report.seasonId,
        "goal1:host-venue",
        venue.host_ts,
      )!.recordId;
      const venueSlots = core.seasons.listVenueSlots(venueId);

      expect(venueSlots.map(({ state }) => state)).toEqual(["open", "open"]);
      expect(
        core.seasons
          .listAssignments(report.seasonId)
          .filter(({ slotId }) => venueSlots.some(({ id }) => id === slotId)),
      ).toEqual([]);
      expect(
        core.annotations
          .listAnnotations(report.seasonId, "act")
          .some(({ note }) => note.includes("(same_as partner of 7-8)")),
      ).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("a canceled slot family preserves another live booking for the canonical act", async () => {
    const temporary = await copyFixture("porchfest-canceled-multi-venue-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8")) as {
        venues: {
          host_ts?: string;
          virtual_venue?: string;
          slots: Record<
            string,
            {
              open?: boolean;
              performer_ts?: string;
              canceled?: { on: string; reason: string };
            }
          >;
        }[];
      };
      const canceledVenue = matches.venues[0];
      const cancellation = canceledVenue!.slots["6-7"]!.canceled;
      delete canceledVenue!.slots["6-7"]!.canceled;
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const first = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const actId = core.importKeys.find(
        first.seasonId,
        "goal1:performer-act",
        canceledVenue!.slots["6-7"]!.performer_ts!,
      )!.recordId;
      const openEntry = matches.venues.find((venue) =>
        Object.values(venue.slots).some((slot) => slot.open === true),
      )!;
      const openLabel = Object.entries(openEntry.slots).find(
        ([, slot]) => slot.open === true,
      )![0];
      const openVenueSource = openEntry.host_ts
        ? "goal1:host-venue"
        : "goal1:virtual-venue";
      const openVenueKey = openEntry.host_ts ?? openEntry.virtual_venue;
      const openVenueId = core.importKeys.find(
        first.seasonId,
        openVenueSource,
        openVenueKey!,
      )!.recordId;
      const openSlot =
        core.seasons.listVenueSlots(openVenueId)[openLabel === "6-7" ? 0 : 1]!;
      const otherAssignment = database.db
        .insert(assignments)
        .values({
          seasonId: first.seasonId,
          actId,
          slotId: openSlot.id,
          continuationOfAssignmentId: null,
        })
        .returning()
        .get();
      database.db
        .update(slots)
        .set({ state: "assigned" })
        .where(eq(slots.id, openSlot.id))
        .run();
      const statusBefore = core.seasons.getAct(actId).status;

      canceledVenue!.slots["6-7"]!.canceled = cancellation;
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });

      expect(core.seasons.getAssignment(otherAssignment.id)).toMatchObject({
        actId,
        slotId: openSlot.id,
      });
      expect(core.seasons.getAct(actId).status).toBe(statusBefore);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("removing a cancellation recreates and rebinds its deleted assignment", async () => {
    const temporary = await copyFixture("porchfest-uncanceled-rerun-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const venue = matches.venues[0];
      const first = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const venueId = core.importKeys.find(
        first.seasonId,
        "goal1:host-venue",
        venue.host_ts,
      )!.recordId;
      const sourceSlot = core.seasons.listVenueSlots(venueId)[0]!;
      const staleKey = core.importKeys.find(
        first.seasonId,
        "goal1:assignment",
        `host:${venue.host_ts}:6-7`,
      )!;
      expect(() => core.seasons.getAssignment(staleKey.recordId)).toThrow(
        `assignment ${staleKey.recordId} does not exist`,
      );

      delete venue.slots["6-7"].canceled;
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const second = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const rebound = core.importKeys.find(
        first.seasonId,
        "goal1:assignment",
        `host:${venue.host_ts}:6-7`,
      )!;

      expect(rebound.recordId).not.toBe(staleKey.recordId);
      expect(core.seasons.getAssignment(rebound.recordId).slotId).toBe(
        sourceSlot.id,
      );
      expect(
        core.seasons.getAct(core.seasons.getAssignment(rebound.recordId).actId)
          .status,
      ).not.toBe("withdrawn");
      expect(second.records.assignment.created).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("canceled superseded performers remain canonical and idempotent on rerun", async () => {
    const temporary = await copyFixture("porchfest-canceled-superseded-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const [supersededKey, supersession] = Object.entries(
        matches.superseded.performers,
      )[0] as [string, { canonical: string }];
      matches.venues[0].slots["6-7"].performer_ts = supersededKey;
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const first = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const canonicalId = core.importKeys.find(
        first.seasonId,
        "goal1:performer-act",
        supersession.canonical,
      )!.recordId;
      const sourceId = core.importKeys.find(
        first.seasonId,
        "goal1:performer-act",
        supersededKey,
      )!.recordId;
      const cancellationCount = core.annotations
        .listAnnotations(first.seasonId, "act", canonicalId)
        .filter(({ note }) => note.startsWith("Canceled on ")).length;

      const second = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });

      expect(second.warnings).toEqual([]);
      expect(core.seasons.getAct(canonicalId).status).toBe("withdrawn");
      expect(core.seasons.getAct(sourceId).status).not.toBe("withdrawn");
      expect(core.seasons.resolveAct(sourceId).canonical.id).toBe(canonicalId);
      expect(
        core.annotations
          .listAnnotations(second.seasonId, "act", canonicalId)
          .filter(({ note }) => note.startsWith("Canceled on ")),
      ).toHaveLength(cancellationCount);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("a canceled same_as cycle fails explicitly and rolls back", async () => {
    const temporary = await copyFixture("porchfest-canceled-cycle-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const venue = matches.venues[4];
      venue.slots["6-7"] = {
        same_as: "7-8",
        canceled: {
          on: "2026-08-19",
          reason: "Invented cycle rejection.",
        },
      };
      venue.slots["7-8"] = { same_as: "6-7" };
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      expect(() =>
        importGoal1Season(core, {
          ...importOptions,
          artifactsDirectory: temporary,
        }),
      ).toThrow("Slot same_as cycle includes 7-8.");
      expect(database.db.select().from(seasons).all()).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("canceled slot dates reject impossible calendar days and roll back", async () => {
    const temporary = await copyFixture("porchfest-canceled-invalid-date-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[0].slots["6-7"].canceled.on = "2026-02-30";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      expect(() =>
        importGoal1Season(core, {
          ...importOptions,
          artifactsDirectory: temporary,
        }),
      ).toThrow("Slot cancellation on must use YYYY-MM-DD.");
      expect(database.db.select().from(seasons).all()).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("open slots remain deliberately empty", async () => {
    const matches = await readFixture<{
      venues: {
        host_ts?: string;
        virtual_venue?: string;
        slots: Record<string, { open?: boolean }>;
      }[];
    }>(fixtureArtifactFiles.slate);
    const report = runImport();
    const openSlots = matches.venues.flatMap((venue) =>
      Object.entries(venue.slots).flatMap(([slotLabel, slot]) =>
        slot.open === true ? [{ venue, slotLabel }] : [],
      ),
    );

    expect(openSlots).toHaveLength(5);
    for (const { venue, slotLabel } of openSlots) {
      const venueKey = venue.host_ts
        ? core.importKeys.find(
            report.seasonId,
            "goal1:host-venue",
            venue.host_ts,
          )
        : core.importKeys.find(
            report.seasonId,
            "goal1:virtual-venue",
            venue.virtual_venue!,
          );
      const importedSlot = core.seasons.listVenueSlots(venueKey!.recordId)[
        slotLabel === "6-7" ? 0 : 1
      ]!;
      expect(importedSlot.state).toBe("open");
    }
  });

  it("map_address replaces the public address and preserves the host-form address privately", async () => {
    const submissions = await readFixture<{
      hosts: { ts: string; address: string }[];
    }>(fixtureArtifactFiles.submissions);
    const matches = await readFixture<{
      venues: { id: string; host_ts: string; map_address?: string }[];
    }>(fixtureArtifactFiles.slate);
    const report = runImport();
    const mapped = matches.venues.filter(({ map_address }) => map_address);

    expect(mapped).toHaveLength(2);
    for (const entry of mapped) {
      const host = submissions.hosts.find(({ ts }) => ts === entry.host_ts)!;
      const venue = core.seasons.getVenue(
        core.importKeys.find(
          report.seasonId,
          "goal1:host-venue",
          entry.host_ts,
        )!.recordId,
      );
      const privateLine = `[host-form address] ${host.address}`;
      expect(venue.address).toBe(entry.map_address);
      expect(venue.notes).toContain(privateLine);
      expect(
        core.annotations
          .listAnnotations(report.seasonId, "venue", venue.id)
          .map(({ note }) => note),
      ).toContain(privateLine);
      expect(
        report.geocache.hits.some(
          ({ venueId, address }) =>
            venueId === venue.id && address === entry.map_address,
        ),
      ).toBe(true);
    }
  });

  it("R27: both supersession directions resolve to the right canonical record", () => {
    const { seasonId } = runImport();
    const cases = [
      {
        source: "goal1:host-venue",
        oldKey: "2026-05-02T10:00:00Z",
        canonicalKey: "2026-05-01T10:00:00Z",
        resolve: (id: number) => core.seasons.resolveVenue(id).canonical.id,
      },
      {
        source: "goal1:host-venue",
        oldKey: "2026-05-04T10:00:00Z",
        canonicalKey: "2026-05-03T10:00:00Z",
        resolve: (id: number) => core.seasons.resolveVenue(id).canonical.id,
      },
      {
        source: "goal1:performer-act",
        oldKey: "2026-05-02T11:00:00Z",
        canonicalKey: "2026-05-01T11:00:00Z",
        resolve: (id: number) => core.seasons.resolveAct(id).canonical.id,
      },
    ];
    for (const item of cases) {
      const oldRecord = core.importKeys.find(
        seasonId,
        item.source,
        item.oldKey,
      )!;
      const canonical = core.importKeys.find(
        seasonId,
        item.source,
        item.canonicalKey,
      )!;
      expect(item.resolve(oldRecord.recordId)).toBe(canonical.recordId);
      expect(item.resolve(canonical.recordId)).toBe(canonical.recordId);
    }
  });

  it("R27: a superseded venue can be withdrawn later in the same import", async () => {
    const temporary = await copyFixture("porchfest-superseded-withdrawal-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const supersededKey = "2026-05-02T10:00:00Z";
      matches.venues.push({
        id: "superseded-withdrawal",
        host_ts: supersededKey,
        basis: "Synthetic superseded withdrawal basis.",
        chase: [],
        email_notes: [],
        withdrawn: {
          on: "2026-08-20",
          reason: "Synthetic same-run withdrawal.",
        },
        slots: {
          "6-7": { open: true },
          "7-8": { open: true },
        },
      });
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const source = core.seasons.getVenue(
        core.importKeys.find(
          report.seasonId,
          "goal1:host-venue",
          supersededKey,
        )!.recordId,
      );

      expect(source).toMatchObject({
        status: "withdrawn",
        canonicalVenueId: expect.any(Number),
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R25/R26: the act-side hold preserves its placeholder venue, decide-by, and fallback", () => {
    const { seasonId } = runImport();
    const venueKey = core.importKeys.find(
      seasonId,
      "goal1:virtual-venue",
      "virtual-hold-venue",
    )!;
    const venue = core.seasons.getVenue(venueKey.recordId);
    const held = core.seasons
      .listVenueSlots(venue.id)
      .find(({ state }) => state === "held")!;

    expect(venue.placeholder).toBe(true);
    expect(held.heldForName).toBe("Paper Comet Collective");
    expect(held.heldDecideBy?.toISOString()).toBe("2026-09-02T04:59:59.000Z");
    expect(held.fallbackVenueId).not.toBeNull();
    expect(core.seasons.listReleasableHolds(seasonId)).toEqual([]);

    const atElevenLocal = createSeasonRepository(database.db, {
      now: () => new Date("2026-09-02T04:00:00.000Z"),
    });
    expect(atElevenLocal.listReleasableHolds(seasonId)).toEqual([]);

    const nextLocalDay = createSeasonRepository(database.db, {
      now: () => new Date("2026-09-02T05:00:00.000Z"),
    });
    expect(nextLocalDay.listReleasableHolds(seasonId)).toEqual([
      expect.objectContaining({ id: held.id }),
    ]);
  });

  it("R25/R26: an unresolved hold fallback is warned and never discarded into a null fallback", async () => {
    const temporary = await copyFixture("porchfest-missing-fallback-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      matches.venues[20].slots["6-7"].id_for_fallback = "missing-venue";
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);
      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      expect(report.holds).toEqual([]);
      expect(report.warnings).toContain(
        "Held slot fallback did not resolve: missing-venue",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R22: the synthetic fixture has no real contact data and regenerates byte-for-byte", async () => {
    const submissions = await readFixture<SubmissionsFixture>(
      fixtureArtifactFiles.submissions,
    );
    const matches = await readFixture<MatchesFixture>(
      fixtureArtifactFiles.slate,
    );
    const emails = [
      ...submissions.hosts.map((row) => row.contact_email),
      ...submissions.performers.map((row) => row.email),
      ...Object.values(matches.manual_contacts).map((row) => row.email),
    ];
    expect(emails.every((email) => email.endsWith("@example.invalid"))).toBe(
      true,
    );

    const temporary = await mkdtemp(
      join(tmpdir(), "porchfest-fixture-regenerate-"),
    );
    try {
      generateSeasonFixture(temporary);
      for (const path of [
        fixtureArtifactFiles.submissions,
        fixtureArtifactFiles.slate,
        fixtureArtifactFiles.geocache,
      ]) {
        expect(await readFile(join(temporary, path), "utf8")).toBe(
          await readFile(join(fixtureDirectory, path), "utf8"),
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: organizer prose survives for every venue basis and chase item", async () => {
    const { seasonId } = runImport();
    const matches = await readFixture<MatchesFixture>(
      fixtureArtifactFiles.slate,
    );
    for (const entry of matches.venues) {
      const venueKey = entry.host_ts
        ? core.importKeys.find(
            seasonId,
            "goal1:host-venue",
            String(entry.host_ts),
          )
        : core.importKeys.find(
            seasonId,
            "goal1:virtual-venue",
            String(entry.virtual_venue),
          );
      const notes = core.annotations
        .listAnnotations(seasonId, "venue", venueKey!.recordId)
        .map(({ note }) => note);
      expect(notes).toContain(`Basis: ${entry.basis}`);
      for (const chase of entry.chase as string[]) {
        expect(notes).toContain(`Chase: ${chase}`);
      }
      for (const emailNote of entry.email_notes) {
        expect(notes).toContain(`Email note: ${emailNote}`);
      }
    }
    expect(
      database.db
        .select()
        .from(annotations)
        .where(sql`${annotations.note} like 'Slot %: same assignment as %'`)
        .all(),
    ).toHaveLength(15);
    const continuationVenue = core.seasons.getVenue(
      core.importKeys.find(
        seasonId,
        "goal1:host-venue",
        "2026-05-08T10:00:00Z",
      )!.recordId,
    );
    const continuationSlots = core.seasons.listVenueSlots(continuationVenue.id);
    const continuationAssignments = core.seasons
      .listAssignments(seasonId)
      .filter(({ slotId }) =>
        continuationSlots.some(({ id }) => id === slotId),
      );
    expect(continuationSlots.map(({ state }) => state)).toEqual([
      "assigned",
      "assigned",
    ]);
    expect(continuationAssignments.map(({ actId }) => actId)).toEqual([
      continuationAssignments[0]!.actId,
      continuationAssignments[0]!.actId,
    ]);
    expect(continuationAssignments[0]!.continuationOfAssignmentId).toBeNull();
    expect(continuationAssignments[1]!.continuationOfAssignmentId).toBe(
      continuationAssignments[0]!.id,
    );
    expect(
      database.db
        .select()
        .from(annotations)
        .where(sql`${annotations.note} like 'Extra recipient: Synthetic %'`)
        .all(),
    ).toHaveLength(2);
    expect(
      database.db
        .select()
        .from(annotations)
        .where(sql`${annotations.note} like 'Withdrawn on %'`)
        .all(),
    ).toHaveLength(3);
  });

  it("band_check and extra_recipients become organizer annotations", async () => {
    const { seasonId } = runImport();
    const matches = await readFixture<{
      venues: {
        host_ts: string;
        slots: Record<string, { band_check?: string }>;
      }[];
    }>(fixtureArtifactFiles.slate);
    const bandCheckVenue = matches.venues.find(({ slots }) =>
      Object.values(slots).some(({ band_check }) => band_check),
    )!;
    const bandCheck = Object.values(bandCheckVenue.slots).find(
      ({ band_check }) => band_check,
    )!.band_check!;
    const venueId = core.importKeys.find(
      seasonId,
      "goal1:host-venue",
      bandCheckVenue.host_ts,
    )!.recordId;
    const notes = core.annotations
      .listAnnotations(seasonId, "venue", venueId)
      .map(({ note }) => note);

    expect(notes).toContain(`Band check: ${bandCheck}`);
    expect(
      core.annotations
        .listAnnotations(seasonId)
        .map(({ note }) => note)
        .filter((note) => note.startsWith("Extra recipient: ")),
    ).toEqual(
      expect.arrayContaining([
        "Extra recipient: Synthetic Extra Recipient One",
        "Extra recipient: Synthetic Extra Recipient Two",
      ]),
    );
  });

  it("supersession objects use canonical and reason fields independent of property order", async () => {
    const temporary = await copyFixture("porchfest-named-supersession-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const [sourceKey, value] = Object.entries(
        matches.superseded.performers,
      )[0] as [string, { canonical: string; reason: string }];
      matches.superseded.performers[sourceKey] = {
        reason: value.reason,
        canonical: value.canonical,
      };
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const source = core.importKeys.find(
        report.seasonId,
        "goal1:performer-act",
        sourceKey,
      )!;
      const canonical = core.importKeys.find(
        report.seasonId,
        "goal1:performer-act",
        value.canonical,
      )!;

      expect(core.seasons.resolveAct(source.recordId).canonical.id).toBe(
        canonical.recordId,
      );
      expect(
        core.annotations
          .listAnnotations(report.seasonId, "act", source.recordId)
          .some(({ note }) => note.endsWith(value.reason)),
      ).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("unmatched id_for_fallback remains an id override and never creates a slot hold", async () => {
    const matches = await readFixture<{
      unmatched_venues: {
        host_ts: string;
        id_for_fallback?: string;
      }[];
    }>(fixtureArtifactFiles.slate);
    const report = runImport();

    expect(matches.unmatched_venues).toEqual([
      expect.objectContaining({
        id_for_fallback: "unmatched-venue-override",
      }),
    ]);
    expect(report.holds).toHaveLength(1);
    expect(
      core.importKeys.find(
        report.seasonId,
        "goal1:hold",
        "unmatched-venue-override",
      ),
    ).toBeNull();
  });

  it("R23: a forward same_as pointer resolves after its direct source assignment", async () => {
    const temporary = await copyFixture("porchfest-forward-same-as-");
    try {
      const path = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(path, "utf8"));
      const venue = matches.venues[4];
      const direct = venue.slots["6-7"];
      venue.slots["6-7"] = { same_as: "7-8" };
      venue.slots["7-8"] = direct;
      await writeFile(path, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const venueId = core.importKeys.find(
        report.seasonId,
        "goal1:host-venue",
        venue.host_ts,
      )!.recordId;
      const venueSlots = core.seasons.listVenueSlots(venueId);
      const venueAssignments = core.seasons
        .listAssignments(report.seasonId)
        .filter(({ slotId }) => venueSlots.some(({ id }) => id === slotId));

      expect(venueAssignments).toHaveLength(2);
      expect(venueAssignments[0]!.actId).toBe(venueAssignments[1]!.actId);
      expect(report.warnings).not.toContain(
        `Continuation assignment did not resolve: ${venue.id} 6-7 -> 7-8`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: the three recognized geocache source labels map exactly and nominatim-house without cross-check enters review", async () => {
    const geocache = await readFixture<
      Record<string, { source: string; crosscheck_m: number | null }>
    >(fixtureArtifactFiles.geocache);
    const report = runImport();
    const coordinates = database.db.select().from(venueCoordinates).all();
    expect(
      new Set(Object.values(geocache).map(({ source }) => source)),
    ).toEqual(
      new Set(["osm-address-point", "nominatim-house", "us-census-unimproved"]),
    );
    expect(coordinates).toHaveLength(20);
    expect(
      coordinates.every(
        ({ source, provider, ref }) =>
          source === "geocoded" &&
          ["osm-address-point", "nominatim-house"].includes(provider) &&
          /^way\/\d+$/.test(ref ?? ""),
      ),
    ).toBe(true);
    expect(
      coordinates.filter(
        ({ status, rejectionCode }) =>
          status === "needs-review" && rejectionCode === "cross-check-missing",
      ),
    ).toHaveLength(3);
    expect(report.geocache.hits).toHaveLength(20);
    expect(report.geocache.misses).toHaveLength(3);
    expect(report.warnings).toEqual([]);
  });

  it("R29: unknown providers fail closed while nominatim without a cross-check needs review", async () => {
    const temporary = await copyFixture("porchfest-provider-kinds-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const unknownAddress = Object.keys(geocache)[2]!;
      const nominatimAddress = Object.keys(geocache)[3]!;
      geocache[unknownAddress].source = "synthetic-mystery-provider";
      geocache[nominatimAddress].source = "nominatim-house";
      geocache[nominatimAddress].crosscheck_m = null;
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const hits = new Map(
        report.geocache.hits.map((hit) => [hit.address, hit]),
      );

      expect(hits.get(unknownAddress)).toMatchObject({
        reviewStatus: "needs-review",
        rejectionCode: "refused",
      });
      expect(hits.get(nominatimAddress)).toMatchObject({
        reviewStatus: "needs-review",
        rejectionCode: "cross-check-missing",
      });
      expect(report.warnings).toContain(
        "Unknown geocache source label requires review: synthetic-mystery-provider",
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: OSM element refs import", async () => {
    const temporary = await copyFixture("porchfest-osm-geocache-ref-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const addresses = Object.keys(geocache).slice(5, 8);
      for (const [index, kind] of ["node", "way", "relation"].entries()) {
        geocache[addresses[index]!].ref = `${kind}/${123 + index}`;
      }
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const hits = new Map(
        report.geocache.hits.map((hit) => [hit.address, hit]),
      );

      for (const address of addresses) {
        expect(hits.get(address)).toMatchObject({
          reviewStatus: "verified",
          rejectionCode: null,
        });
      }
      expect(report.warnings).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: malformed geocache refs enter review with warnings", async () => {
    const temporary = await copyFixture("porchfest-malformed-geocache-ref-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const addresses = Object.keys(geocache).slice(5, 11);
      geocache[addresses[0]!].ref = "n/123";
      geocache[addresses[1]!].ref = "way/abc";
      delete geocache[addresses[2]!].ref;
      geocache[addresses[3]!].ref = 123;
      geocache[addresses[4]!].ref = "";
      geocache[addresses[5]!].ref = " way/123 ";
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const hits = new Map(
        report.geocache.hits.map((hit) => [hit.address, hit]),
      );

      for (const address of addresses) {
        expect(hits.get(address)).toMatchObject({
          reviewStatus: "needs-review",
          rejectionCode: "refused",
        });
      }
      expect(report.warnings).toContain(
        "Malformed geocache ref requires review: n/123",
      );
      expect(report.warnings).toContain(
        "Malformed geocache ref requires review: way/abc",
      );
      expect(
        report.warnings.filter((warning) =>
          warning.startsWith("Malformed geocache ref requires review:"),
        ),
      ).toHaveLength(addresses.length);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: us-census-unimproved imports as street/interpolated review evidence", async () => {
    const temporary = await copyFixture("porchfest-census-provider-");
    try {
      const path = join(temporary, fixtureArtifactFiles.geocache);
      const geocache = JSON.parse(await readFile(path, "utf8"));
      const address = Object.keys(geocache)[5]!;
      geocache[address].source = "us-census-unimproved";
      await writeFile(path, `${JSON.stringify(geocache, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const hit = report.geocache.hits.find(
        (candidate) => candidate.address === address,
      )!;
      const coordinate = database.db
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.id, hit.coordinateId))
        .get()!;

      expect(hit).toMatchObject({
        reviewStatus: "needs-review",
        rejectionCode: "interpolated",
      });
      expect(coordinate).toMatchObject({
        provider: "us-census-unimproved",
        precision: "street",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: one address collision geocodes both live venues and names both natural keys", async () => {
    const temporary = await copyFixture("porchfest-address-collision-");
    try {
      const submissionsPath = join(temporary, fixtureArtifactFiles.submissions);
      const matchesPath = join(temporary, fixtureArtifactFiles.slate);
      const submissions = JSON.parse(await readFile(submissionsPath, "utf8"));
      const matches = JSON.parse(await readFile(matchesPath, "utf8"));
      const firstEntry = matches.venues[4];
      const secondEntry = matches.venues[5];
      const firstHost = submissions.hosts.find(
        ({ ts }: { ts: string }) => ts === firstEntry.host_ts,
      );
      const secondHost = submissions.hosts.find(
        ({ ts }: { ts: string }) => ts === secondEntry.host_ts,
      );
      const firstKey = firstHost.ts;
      const secondKey = secondHost.ts;
      secondHost.address = firstHost.address;
      secondEntry.address_check = firstHost.address;
      await writeFile(
        submissionsPath,
        `${JSON.stringify(submissions, null, 2)}\n`,
      );
      await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const sharedAddressHits = report.geocache.hits.filter(
        ({ address }) => address === firstHost.address,
      );

      expect(sharedAddressHits).toHaveLength(2);
      expect(
        new Set(sharedAddressHits.map(({ venueId }) => venueId)).size,
      ).toBe(2);
      expect(report.warnings).toContain(
        `Live canonical venues share geocache address ${firstHost.address}: ${firstKey}, ${secondKey}`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R29: a withdrawn venue cannot shadow a live venue at the same address", async () => {
    const temporary = await copyFixture("porchfest-withdrawn-shadow-");
    try {
      const matchesPath = join(temporary, fixtureArtifactFiles.slate);
      const matches = JSON.parse(await readFile(matchesPath, "utf8"));
      const sharedAddress = matches.venues[4].address_check;
      matches.virtual_venues["virtual-withdrawn-venue"].address_display =
        sharedAddress;
      const withdrawnEntry = matches.venues.find(
        ({ virtual_venue }: { virtual_venue?: string }) =>
          virtual_venue === "virtual-withdrawn-venue",
      );
      withdrawnEntry.address_check = sharedAddress;
      await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const withdrawn = core.seasons.getVenue(
        core.importKeys.find(
          report.seasonId,
          "goal1:virtual-venue",
          "virtual-withdrawn-venue",
        )!.recordId,
      );

      expect(
        database.db
          .select()
          .from(venueCoordinates)
          .where(eq(venueCoordinates.venueId, withdrawn.id))
          .get(),
      ).toBeUndefined();
      expect(
        report.geocache.hits.filter(({ address }) => address === sharedAddress),
      ).toHaveLength(1);
      expect(
        report.warnings.some((warning) =>
          warning.includes("virtual-withdrawn-venue"),
        ),
      ).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: overrides apply with reasons and messy listen/websites values keep URLs plus residue", () => {
    const { seasonId } = runImport();
    const revisedAct = actFor(seasonId, "2026-05-03T11:00:00Z");
    const revisedContact = contactFor(seasonId, "2026-05-05T11:00:00Z");
    const linkAct = actFor(seasonId, "2026-05-07T11:00:00Z");
    const placeholderAct = actFor(seasonId, "2026-05-09T11:00:00Z");

    expect(revisedAct.name).toBe("Lantern Ensemble Three Revised");
    expect(revisedContact.email).toBe("performer-05-revised@example.invalid");
    expect(linkAct.links).toBe(
      "https://revised-audio.example.invalid/ensemble-07",
    );
    expect(linkAct.notes).toContain("Link note: revised demo note");
    expect(linkAct.notes).toContain(
      "Gear details: An invented crystal pickup.",
    );
    expect(placeholderAct.links).toBe(
      "https://audio.example.invalid/ensemble-09",
    );
    const mixedVenue = core.seasons.getVenue(
      core.importKeys.find(
        seasonId,
        "goal1:host-venue",
        "2026-05-01T10:00:00Z",
      )!.recordId,
    );
    expect(mixedVenue.notes).toContain("Unmapped gear: moon harp");
    expect(
      core.annotations
        .listAnnotations(seasonId, "act", revisedAct.id)
        .some(({ note }) => note.includes("Invented override reason 3.")),
    ).toBe(true);
    expect(
      database.db
        .select({ total: sql<number>`count(*)` })
        .from(annotations)
        .where(sql`${annotations.note} like 'Override%'`)
        .get()!.total,
    ).toBe(4);
  });

  it.each(["notes-first", "notes-last"] as const)(
    "R23: notes overrides preserve composite performer details when ordered %s",
    async (order) => {
      const temporary = await copyFixture("porchfest-notes-override-");
      try {
        const submissionsPath = join(
          temporary,
          fixtureArtifactFiles.submissions,
        );
        const matchesPath = join(temporary, fixtureArtifactFiles.slate);
        const submissions = JSON.parse(await readFile(submissionsPath, "utf8"));
        const matches = JSON.parse(await readFile(matchesPath, "utf8"));
        const naturalKey = "2026-05-07T11:00:00Z";
        const row = submissions.performers.find(
          ({ ts }: { ts: string }) => ts === naturalKey,
        );
        const listenOverride =
          matches.performer_overrides[naturalKey].fields.listen;
        const notesOverride = {
          original: row.notes,
          value: "Invented revised performer note.",
        };
        matches.performer_overrides[naturalKey].fields =
          order === "notes-first"
            ? { notes: notesOverride, listen: listenOverride }
            : { listen: listenOverride, notes: notesOverride };
        await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

        const report = importGoal1Season(core, {
          ...importOptions,
          artifactsDirectory: temporary,
        });
        const act = actFor(report.seasonId, naturalKey);

        expect(act.notes).toContain("Invented revised performer note.");
        expect(act.notes).toContain(
          "Gear details: An invented crystal pickup.",
        );
        expect(act.notes).toContain("Link note: revised demo note");
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  it("R23: an unmapped override field warns and retains its reason annotation", async () => {
    const temporary = await copyFixture("porchfest-unmapped-override-");
    try {
      const submissionsPath = join(temporary, fixtureArtifactFiles.submissions);
      const matchesPath = join(temporary, fixtureArtifactFiles.slate);
      const submissions = JSON.parse(await readFile(submissionsPath, "utf8"));
      const matches = JSON.parse(await readFile(matchesPath, "utf8"));
      const naturalKey = Object.keys(matches.performer_overrides)[0]!;
      const row = submissions.performers.find(
        ({ ts }: { ts: string }) => ts === naturalKey,
      );
      matches.performer_overrides[naturalKey].fields.slots = {
        original: row.slots,
        value: "7-8",
      };
      await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      const act = actFor(report.seasonId, naturalKey);
      const annotationsForAct = core.annotations.listAnnotations(
        report.seasonId,
        "act",
        act.id,
      );

      expect(report.warnings).toContain(
        `Performer override ${naturalKey} field slots has no importer mapping; the reason was retained as an annotation.`,
      );
      expect(
        annotationsForAct.some(({ note }) =>
          note.includes(matches.performer_overrides[naturalKey].reason),
        ),
      ).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: conservative negative phrases stay false and descriptive answers remain in notes", async () => {
    const temporary = await copyFixture("porchfest-content-answers-");
    try {
      const path = join(temporary, fixtureArtifactFiles.submissions);
      const submissions = JSON.parse(await readFile(path, "utf8"));
      const cases = [
        ["Not needed", false, true],
        ["Nope", false, true],
        ["None needed", false, true],
        ["We don't", false, true],
        ["Available with a small amp", true, true],
        ["Yes", true, false],
      ] as const;
      for (const [index, [answer]] of cases.entries()) {
        submissions.performers[index].amplification = answer;
        submissions.performers[index].lend_gear = answer;
      }
      await writeFile(path, `${JSON.stringify(submissions, null, 2)}\n`);

      const report = importGoal1Season(core, {
        ...importOptions,
        artifactsDirectory: temporary,
      });
      for (const [index, [answer, expected, keepsRaw]] of cases.entries()) {
        const naturalKey = submissions.performers[index].ts;
        const act = actFor(report.seasonId, naturalKey);
        expect(act.requiresAmplification, answer).toBe(expected);
        expect(act.canLendGear, answer).toBe(expected);
        if (keepsRaw) {
          expect(act.notes, answer).toContain(
            `Amplification response: ${answer}`,
          );
          expect(act.notes, answer).toContain(
            `Gear lending response: ${answer}`,
          );
        } else {
          expect(act.notes, answer).not.toContain(
            `Amplification response: ${answer}`,
          );
          expect(act.notes, answer).not.toContain(
            `Gear lending response: ${answer}`,
          );
        }
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("R23: reordered unmatched and floating rows keep natural-keyed annotations idempotent", async () => {
    const temporary = await copyFixture("porchfest-reordered-annotations-");
    try {
      const submissionsPath = join(temporary, fixtureArtifactFiles.submissions);
      const matchesPath = join(temporary, fixtureArtifactFiles.slate);
      const submissions = JSON.parse(await readFile(submissionsPath, "utf8"));
      const matches = JSON.parse(await readFile(matchesPath, "utf8"));
      const hostKey = submissions.hosts[21].ts;
      const performerKey = submissions.performers[25].ts;
      matches.unmatched_venues.push({
        host_ts: hostKey,
        status: "synthetic-second-unmatched",
        email_note: "Synthetic second unmatched note.",
      });
      matches.floating_performers.push({
        performer_ts: performerKey,
        status: "synthetic-second-floating",
        status_display: "Synthetic second floating detail.",
        email_notes: ["Synthetic second floating note."],
        action: "Synthetic second floating action.",
      });
      await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);

      const options = { ...importOptions, artifactsDirectory: temporary };
      const first = importGoal1Season(core, options);
      const annotationKeys = core.importKeys
        .list(first.seasonId)
        .filter(({ source }) => source === "goal1:annotation")
        .map(({ naturalKey }) => naturalKey);
      expect(annotationKeys).toContain(`unmatched:${hostKey}:status`);
      expect(annotationKeys).toContain(`floating:${performerKey}:status`);
      const before = versionSnapshot(database);

      matches.unmatched_venues.reverse();
      matches.floating_performers.reverse();
      await writeFile(matchesPath, `${JSON.stringify(matches, null, 2)}\n`);
      const second = importGoal1Season(core, options);

      expect(versionSnapshot(database)).toEqual(before);
      expect(second.records.annotation.created).toBe(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  function actFor(seasonId: number, naturalKey: string) {
    const key = core.importKeys.find(
      seasonId,
      "goal1:performer-act",
      naturalKey,
    )!;
    return core.seasons.getAct(key.recordId);
  }

  function contactFor(seasonId: number, naturalKey: string) {
    const key = core.importKeys.find(
      seasonId,
      "goal1:performer-contact",
      naturalKey,
    )!;
    return core.seasons.getContact(key.recordId);
  }
});

function makeCore(database: TestDatabase, now: () => Date): Goal1ImportCore {
  return {
    transaction: <T>(work: () => T): T => database.db.transaction(work),
    setup: createSeasonSetup(database.db, now),
    seasons: createSeasonRepository(database.db, { now }),
    geocoding: createGeocodingRepository(
      database.db,
      { geo: offlineGeo },
      { now },
    ),
    annotations: createAnnotationRepository(database.db, { now }),
    importKeys: createImportKeyRepository(database.db, { now }),
  };
}

interface SubmissionsFixture {
  readonly hosts: readonly { readonly contact_email: string }[];
  readonly performers: readonly { readonly email: string }[];
}

interface MatchesFixture {
  readonly manual_contacts: Readonly<
    Record<string, { readonly email: string }>
  >;
  readonly venues: readonly {
    readonly host_ts?: string;
    readonly virtual_venue?: string;
    readonly basis: string;
    readonly chase: readonly string[];
    readonly email_notes: readonly string[];
  }[];
}

async function readFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, path), "utf8")) as T;
}

function containsWholeToken(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(value);
}

async function copyFixture(prefix: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  await cp(fixtureDirectory, temporary, { recursive: true });
  return temporary;
}

function versionSnapshot(database: TestDatabase) {
  const snapshot = (table: string) =>
    database.sqlite
      .prepare(`select id, version from ${table} order by id`)
      .all();
  return {
    seasons: snapshot("seasons"),
    venues: snapshot("venues"),
    acts: snapshot("acts"),
    contacts: snapshot("contacts"),
    slots: snapshot("slots"),
    assignments: snapshot("assignments"),
    coordinates: snapshot("venue_coordinates"),
    annotations: snapshot("annotations"),
    importKeys: snapshot("import_keys"),
    counts: {
      seasons: database.db.select().from(seasons).all().length,
      venues: database.db.select().from(venues).all().length,
      acts: database.db.select().from(acts).all().length,
      contacts: database.db.select().from(contacts).all().length,
      slots: database.db.select().from(slots).all().length,
      assignments: database.db.select().from(assignments).all().length,
      coordinates: database.db.select().from(venueCoordinates).all().length,
      annotations: database.db.select().from(annotations).all().length,
      importKeys: database.db.select().from(importKeys).all().length,
    },
  };
}
