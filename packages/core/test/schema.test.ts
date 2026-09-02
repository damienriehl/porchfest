import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getTableName, is } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

function constraintValues(migration: string, constraintName: string): string[] {
  const values = migration.match(
    new RegExp(
      `CONSTRAINT "${constraintName}" CHECK\\([^\\n]*? in \\(([^)]*)\\)\\)`,
    ),
  )?.[1];
  if (values === undefined) {
    throw new Error(`migration constraint ${constraintName} not found`);
  }
  return values.split(",").map((value) => value.trim().replaceAll("'", ""));
}

describe("core schema migration", () => {
  let database: TestDatabase;
  let sqlite: Database.Database;

  beforeAll(async () => {
    database = await openTestDatabase("porchfest-schema-");
    sqlite = database.sqlite;
  });

  afterAll(async () => {
    await database.close();
  });

  it("includes every exported schema table in canonical metadata", () => {
    const exportedTableNames = Object.values(schema)
      .filter((value) => is(value, SQLiteTable))
      .map((table) => getTableName(table))
      .sort();

    expect(schema.schemaTableNames).toEqual(exportedTableNames);
  });

  it("creates every domain table with its canonical columns", () => {
    const tableNames = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tableNames).toEqual(
      expect.arrayContaining([...schema.schemaTableNames]),
    );
    for (const table of schema.schemaTableDefinitions) {
      const columnNames = sqlite
        .prepare("select name from pragma_table_info(?) order by name")
        .all(table.name)
        .map((row) => (row as { name: string }).name);

      expect(columnNames, table.name).toEqual(table.columns);
    }
  });

  it("adds the U9 map publication and event metadata columns in migration 0015", async () => {
    const migration = await readFile(
      new URL("../drizzle/0015_map_publication.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("`map_published_at` integer");
    expect(migration).toContain("`event_city` text");
    expect(migration).toContain("`event_state` text");

    const seasonColumns = sqlite
      .prepare("select name from pragma_table_info('seasons') order by name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(seasonColumns).toEqual(
      expect.arrayContaining(["event_city", "event_state", "map_published_at"]),
    );
  });

  it("adds KTD13 season-scoped natural import keys in migration 0016", async () => {
    const migration = await readFile(
      new URL("../drizzle/0016_right_microbe.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("CREATE TABLE `import_keys`");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX `import_keys_season_source_natural_key_uidx`",
    );

    const columns = sqlite
      .prepare(
        "select name from pragma_table_info('import_keys') order by name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual([
      "created_at",
      "id",
      "natural_key",
      "record_id",
      "record_type",
      "season_id",
      "source",
      "updated_at",
      "version",
    ]);
  });

  it("marks continuation assignments in migration 0017", async () => {
    const migration = await readFile(
      new URL("../drizzle/0017_far_havok.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "ALTER TABLE `assignments` ADD `continuation_of_assignment_id` integer REFERENCES assignments(id)",
    );
    expect(migration).toContain(
      "CREATE INDEX `assignments_continuation_of_assignment_id_idx`",
    );

    const columns = sqlite
      .prepare(
        "select name from pragma_table_info('assignments') order by name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("continuation_of_assignment_id");
    expect(
      sqlite
        .prepare(
          "select `table`, `from`, `to` from pragma_foreign_key_list('assignments')",
        )
        .all(),
    ).toContainEqual({
      table: "assignments",
      from: "continuation_of_assignment_id",
      to: "id",
    });
  });

  it("upgrades complete and partial 0013 coordinates into explicit provenance", () => {
    const upgrade = new Database(":memory:");
    upgrade.pragma("foreign_keys = ON");
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const migration0014 = migrations.at(14);
    if (migration0014 === undefined) {
      throw new Error("migration 0014 was not loaded");
    }

    try {
      for (const migration of migrations.slice(0, 14)) {
        for (const statement of migration.sql) {
          if (statement.trim() !== "") upgrade.exec(statement);
        }
      }
      const season = upgrade
        .prepare(
          "insert into seasons (year, display_name) values (?, ?) returning id",
        )
        .get(2114, "Upgrade Sample") as { id: number };
      const insertVenue = upgrade.prepare(
        "insert into venues (season_id, title, address, latitude, longitude) values (?, ?, ?, ?, ?)",
      );
      insertVenue.run(
        season.id,
        "Complete Coordinate",
        "201 Aurora Way",
        10.5,
        20.5,
      );
      insertVenue.run(
        season.id,
        "Partial Coordinate",
        "202 Aurora Way",
        10.6,
        null,
      );
      insertVenue.run(season.id, "No Coordinate", "203 Aurora Way", null, null);

      for (const statement of migration0014.sql) {
        if (statement.trim() !== "") upgrade.exec(statement);
      }

      expect(
        upgrade
          .prepare(
            "select latitude, longitude, source, provider, status, rejection_code, address_at_geocode from venue_coordinates order by venue_id",
          )
          .all(),
      ).toEqual([
        {
          latitude: 10.5,
          longitude: 20.5,
          source: "organizer-verified",
          provider: "legacy",
          status: "pending",
          rejection_code: null,
          address_at_geocode: "201 Aurora Way",
        },
        {
          latitude: null,
          longitude: null,
          source: "organizer-verified",
          provider: "legacy",
          status: "needs-review",
          rejection_code: "invalid-coordinate",
          address_at_geocode: "202 Aurora Way",
        },
      ]);
      expect(
        upgrade
          .prepare("select name from pragma_table_info('venues')")
          .all()
          .map((row) => (row as { name: string }).name),
      ).not.toEqual(expect.arrayContaining(["latitude", "longitude"]));
      expect(upgrade.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgrade.close();
    }
  });

  it("adds nullable original-submission snapshots without changing existing rows", () => {
    const upgrade = new Database(":memory:");
    upgrade.pragma("foreign_keys = ON");
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const migration0019 = migrations.at(19);
    if (migration0019 === undefined) {
      throw new Error("migration 0019 was not loaded");
    }

    try {
      for (const migration of migrations.slice(0, 19)) {
        for (const statement of migration.sql) {
          if (statement.trim() !== "") upgrade.exec(statement);
        }
      }
      const season = upgrade
        .prepare(
          "insert into seasons (year, display_name) values (?, ?) returning id",
        )
        .get(2119, "Snapshot Upgrade") as { id: number };
      upgrade
        .prepare("insert into contacts (season_id, name) values (?, ?)")
        .run(season.id, "Existing Contact");
      upgrade
        .prepare("insert into acts (season_id, name) values (?, ?)")
        .run(season.id, "Existing Act");
      upgrade
        .prepare("insert into venues (season_id, title) values (?, ?)")
        .run(season.id, "Existing Venue");

      for (const statement of migration0019.sql) {
        if (statement.trim() !== "") upgrade.exec(statement);
      }

      for (const [table, labelColumn] of [
        ["contacts", "name"],
        ["acts", "name"],
        ["venues", "title"],
      ] as const) {
        expect(
          upgrade
            .prepare(
              `select ${labelColumn} as label, original_submission from ${table}`,
            )
            .get(),
        ).toMatchObject({ original_submission: null });
      }
      expect(upgrade.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgrade.close();
    }
  });

  it("rejects a slot state outside the supported state machine", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2099, "Sample Season") as { id: number };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(season.id, "Sample Venue") as { id: number };

    expect(() =>
      sqlite
        .prepare(
          "insert into slots (season_id, venue_id, starts_at, ends_at, state) values (?, ?, ?, ?, ?)",
        )
        .run(season.id, venue.id, 4_102_444_800, 4_102_448_400, "invalid"),
    ).toThrow();
  });

  it("stores R1 signup fields in typed columns and normalized child rows", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2102, "Signup Field Sample") as { id: number };
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(season.id, "Signup Contact") as { id: number };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title, space_description, has_power, rain_backup, host_contact_id, requested_act_names, genre_preferences) values (?, ?, ?, ?, ?, ?, ?, ?) returning id",
      )
      .get(
        season.id,
        "Signup Venue",
        "Front porch and yard",
        1,
        1,
        contact.id,
        "The Synthetic Notes",
        "folk / jazz",
      ) as { id: number };
    const act = sqlite
      .prepare(
        "insert into acts (season_id, name, duration_minutes, requires_amplification, house_preference, can_lend_gear, reach_via_contact_id, shared_member_note) values (?, ?, ?, ?, ?, ?, ?, ?) returning id",
      )
      .get(
        season.id,
        "Signup Act",
        45,
        1,
        "A shaded porch",
        1,
        contact.id,
        "A member also plays in The Other Act",
      ) as {
      id: number;
    };

    const gear = sqlite
      .prepare(
        "insert into venue_gear (season_id, venue_id, value) values (?, ?, ?) returning version",
      )
      .get(season.id, venue.id, "pa") as { version: number };
    const drink = sqlite
      .prepare(
        "insert into venue_drinks (season_id, venue_id, value) values (?, ?, ?) returning version",
      )
      .get(season.id, venue.id, "water") as { version: number };
    const amenity = sqlite
      .prepare(
        "insert into venue_amenities (season_id, venue_id, value) values (?, ?, ?) returning version",
      )
      .get(season.id, venue.id, "shade") as { version: number };
    const availability = sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?) returning version",
      )
      .get(season.id, act.id, 4_102_444_800, 4_102_448_400) as {
      version: number;
    };

    expect(
      sqlite
        .prepare(
          "select space_description, has_power, rain_backup, requested_act_names, genre_preferences from venues where id = ?",
        )
        .get(venue.id),
    ).toEqual({
      space_description: "Front porch and yard",
      has_power: 1,
      rain_backup: 1,
      requested_act_names: "The Synthetic Notes",
      genre_preferences: "folk / jazz",
    });
    expect(
      sqlite
        .prepare(
          "select duration_minutes, requires_amplification, house_preference, can_lend_gear, shared_member_note from acts where id = ?",
        )
        .get(act.id),
    ).toEqual({
      duration_minutes: 45,
      requires_amplification: 1,
      house_preference: "A shaded porch",
      can_lend_gear: 1,
      shared_member_note: "A member also plays in The Other Act",
    });
    expect([gear, drink, amenity, availability]).toEqual([
      { version: 1 },
      { version: 1 },
      { version: 1 },
      { version: 1 },
    ]);
  });

  it("stores only normalized unique shared-member act links", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2106, "Link Sample") as { id: number };
    const first = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(season.id, "First Linked Act") as { id: number };
    const second = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(season.id, "Second Linked Act") as { id: number };
    sqlite
      .prepare(
        "insert into act_links (season_id, act_id, linked_act_id, note) values (?, ?, ?, ?)",
      )
      .run(season.id, first.id, second.id, "shared musician");
    expect(() =>
      sqlite
        .prepare(
          "insert into act_links (season_id, act_id, linked_act_id) values (?, ?, ?)",
        )
        .run(season.id, first.id, second.id),
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          "insert into act_links (season_id, act_id, linked_act_id) values (?, ?, ?)",
        )
        .run(season.id, second.id, first.id),
    ).toThrow();
  });

  it("rejects unsupported signup set values and invalid availability windows", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2103, "Signup Constraint Sample") as { id: number };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(season.id, "Constraint Venue") as { id: number };
    const act = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(season.id, "Constraint Act") as { id: number };

    for (const table of ["venue_gear", "venue_drinks", "venue_amenities"]) {
      expect(() =>
        sqlite
          .prepare(
            `insert into ${table} (season_id, venue_id, value) values (?, ?, ?)`,
          )
          .run(season.id, venue.id, "unsupported"),
      ).toThrow();
    }
    expect(() =>
      sqlite
        .prepare(
          "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?)",
        )
        .run(season.id, act.id, 4_102_448_400, 4_102_444_800),
    ).toThrow();
  });

  it("rejects duplicate values in normalized signup sets", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2104, "Signup Set Sample") as { id: number };
    const venue = sqlite
      .prepare(
        "insert into venues (season_id, title) values (?, ?) returning id",
      )
      .get(season.id, "Set Venue") as { id: number };
    const act = sqlite
      .prepare("insert into acts (season_id, name) values (?, ?) returning id")
      .get(season.id, "Set Act") as { id: number };

    for (const table of ["venue_gear", "venue_drinks", "venue_amenities"]) {
      sqlite
        .prepare(
          `insert into ${table} (season_id, venue_id, value) values (?, ?, ?)`,
        )
        .run(
          season.id,
          venue.id,
          table === "venue_gear"
            ? "pa"
            : table === "venue_drinks"
              ? "water"
              : "shade",
        );
      expect(() =>
        sqlite
          .prepare(
            `insert into ${table} (season_id, venue_id, value) select season_id, venue_id, value from ${table} where venue_id = ?`,
          )
          .run(venue.id),
      ).toThrow();
    }
    sqlite
      .prepare(
        "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?)",
      )
      .run(season.id, act.id, 4_102_444_800, 4_102_448_400);
    expect(() =>
      sqlite
        .prepare(
          "insert into act_availabilities (season_id, act_id, starts_at, ends_at) values (?, ?, ?, ?)",
        )
        .run(season.id, act.id, 4_102_444_800, 4_102_448_400),
    ).toThrow();
  });

  it("keeps migration state checks aligned with the schema state lists", async () => {
    const migration = await readFile(
      new URL("../drizzle/0000_overconfident_joseph.sql", import.meta.url),
      "utf8",
    );
    expect(constraintValues(migration, "seasons_state_check")).toEqual(
      schema.seasonStates,
    );
    expect(constraintValues(migration, "slots_state_check")).toEqual(
      schema.slotStates,
    );
  });

  it("keeps generated migration set checks aligned with schema value lists", async () => {
    const migration = await readFile(
      new URL("../drizzle/0003_awesome_krista_starr.sql", import.meta.url),
      "utf8",
    );
    expect(constraintValues(migration, "venue_gear_value_check")).toEqual(
      schema.venueGearValues,
    );
    expect(constraintValues(migration, "venue_drinks_value_check")).toEqual(
      schema.venueDrinkValues,
    );
    expect(constraintValues(migration, "venue_amenities_value_check")).toEqual(
      schema.venueAmenityValues,
    );
  });

  it("keeps the outbox migration checks aligned with the schema value lists", async () => {
    const migration = await readFile(
      new URL("../drizzle/0013_youthful_falcon.sql", import.meta.url),
      "utf8",
    );
    expect(constraintValues(migration, "outbox_waves_kind_check")).toEqual(
      schema.outboxWaveKinds,
    );
    expect(
      constraintValues(migration, "outbox_waves_recipient_rule_check"),
    ).toEqual(schema.outboxRecipientRules);
    expect(constraintValues(migration, "outbox_waves_status_check")).toEqual(
      schema.outboxWaveStatuses,
    );
    expect(constraintValues(migration, "outbox_messages_state_check")).toEqual(
      schema.outboxMessageStates,
    );
    expect(
      constraintValues(migration, "outbox_messages_record_type_check"),
    ).toEqual(schema.outboxRecordTypes);
  });

  it("keeps coordinate provenance checks aligned with the schema value lists", async () => {
    const migration = await readFile(
      new URL("../drizzle/0014_venue_coordinates.sql", import.meta.url),
      "utf8",
    );
    expect(
      constraintValues(migration, "venue_coordinates_source_check"),
    ).toEqual(schema.coordinateSources);
    expect(
      constraintValues(migration, "venue_coordinates_precision_check"),
    ).toEqual(schema.coordinatePrecisions);
    expect(
      constraintValues(migration, "venue_coordinates_status_check"),
    ).toEqual(schema.coordinateStatuses);
    expect(
      constraintValues(migration, "venue_coordinates_rejection_code_check"),
    ).toEqual(schema.coordinateRejectionCodes);
  });

  it("keeps pre-outbox email_log rows valid and one row per recipient", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2107, "Send History Sample") as { id: number };
    const contact = sqlite
      .prepare(
        "insert into contacts (season_id, name) values (?, ?) returning id",
      )
      .get(season.id, "History Contact") as { id: number };
    // A row written before U7 named no address, outcome, or message.
    const legacy = sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id) values (?, ?, ?, ?, ?) returning address, outcome, message_id",
      )
      .get(season.id, "venue", 1, "wave1", contact.id);
    expect(legacy).toEqual({
      address: null,
      outcome: null,
      message_id: null,
    });

    sqlite
      .prepare(
        "insert into email_log (season_id, record_type, record_id, wave_label, recipient_contact_id, address, outcome, message_id) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        season.id,
        "venue",
        1,
        "match",
        contact.id,
        "history@example.invalid",
        "sent",
        7,
      );
    expect(
      sqlite
        .prepare("select count(*) as total from email_log where season_id = ?")
        .get(season.id),
    ).toEqual({ total: 2 });
  });

  it("defaults the optimistic-concurrency version to one", () => {
    const inserted = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning version",
      )
      .get(2100, "Version Sample") as { version: number };

    expect(inserted.version).toBe(1);
  });

  it("round-trips a season-scoped row", () => {
    const season = sqlite
      .prepare(
        "insert into seasons (year, display_name) values (?, ?) returning id",
      )
      .get(2101, "Scope Sample") as { id: number };

    const inserted = sqlite
      .prepare(
        "insert into acts (season_id, name, genre, description, links) values (?, ?, ?, ?, ?) returning id",
      )
      .get(
        season.id,
        "Sample Act",
        "Sample Genre",
        "Synthetic fixture",
        "https://example.invalid/sample",
      ) as { id: number };
    const selected = sqlite
      .prepare(
        "select season_id, name, version from acts where id = ? and season_id = ?",
      )
      .get(inserted.id, season.id);

    expect(selected).toEqual({
      season_id: season.id,
      name: "Sample Act",
      version: 1,
    });
  });
});
