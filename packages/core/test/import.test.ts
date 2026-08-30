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
const beforeDecideBy = new Date("2026-08-31T12:00:00.000Z");
const importOptions = {
  artifactsDirectory: fixtureDirectory,
  localityName: "Synthetic Lantern District",
  bounds: { north: 10.205, south: 9.5, east: 20.5, west: 19.5 },
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

  it("R23: importing the 2026 artifacts yields 22 active slate venues and 26 approved act-side entries", () => {
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

    expect(activeVenues).toBe(22);
    expect(approvedActs + holds).toBe(26);
    expect(database.db.select().from(assignments).all()).toHaveLength(36);
    expect(database.db.select().from(venues).all()).toHaveLength(25);
    expect(database.db.select().from(acts).all()).toHaveLength(33);
    expect(database.db.select().from(contacts).all()).toHaveLength(53);
    expect(report.records.venue.created).toBe(25);
    expect(report.records.act.created).toBe(33);
    expect(report.records.assignment.created).toBe(36);
    expect(report.summary).toEqual({
      slateVenues: 22,
      approvedActEntries: 26,
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
    expect(second.records.coordinate.found).toBe(22);
    expect(second.records.annotation.found).toBe(before.counts.annotations);
    expect(second.annotationCount).toBe(before.counts.annotations);
    expect(second.supersessions.every(({ status }) => status === "found")).toBe(
      true,
    );
    expect(second.holds).toEqual([
      expect.objectContaining({ status: "found" }),
    ]);
  });

  it("R23: fidelity summary counts only venue entries that resolve", async () => {
    const temporary = await copyFixture("porchfest-unresolved-venue-");
    try {
      const path = join(temporary, "private/matches-2026.json");
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

  it("R26: the six placeholder acts carry their reach-via through the contact graph", () => {
    const { seasonId } = runImport();
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
    expect(held.heldDecideBy?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(held.fallbackVenueId).not.toBeNull();
    expect(core.seasons.listReleasableHolds(seasonId)).toEqual([]);

    const afterDeadline = createSeasonRepository(database.db, {
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });
    expect(afterDeadline.listReleasableHolds(seasonId)).toEqual([
      expect.objectContaining({ id: held.id }),
    ]);
  });

  it("R25/R26: an unresolved hold fallback is warned and never discarded into a null fallback", async () => {
    const temporary = await copyFixture("porchfest-missing-fallback-");
    try {
      const path = join(temporary, "private/matches-2026.json");
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
      "out/submissions.json",
    );
    const matches = await readFixture<MatchesFixture>(
      "private/matches-2026.json",
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
        "out/submissions.json",
        "private/matches-2026.json",
        "private/geocache.json",
        "tools/geocode.py",
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
      "private/matches-2026.json",
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
    ).toHaveLength(11);
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
    ).toHaveLength(1);
  });

  it("R29: geocache provenance imports offline and an out-of-box entry needs review", () => {
    const report = runImport();
    const coordinates = database.db.select().from(venueCoordinates).all();
    expect(coordinates).toHaveLength(22);
    expect(
      coordinates.every(
        ({ source, provider, ref }) =>
          source === "geocoded" &&
          provider === "synthetic-parcel" &&
          ref?.startsWith("synthetic/ref/") === true,
      ),
    ).toBe(true);
    expect(
      coordinates.filter(
        ({ status, rejectionCode }) =>
          status === "needs-review" && rejectionCode === "out-of-bounds",
      ),
    ).toHaveLength(1);
    expect(report.geocache.hits).toHaveLength(22);
    expect(report.geocache.misses).toHaveLength(1);
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
