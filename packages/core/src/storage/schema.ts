import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const seasonStates = [
  "setup",
  "signups_open",
  "signups_closed",
  "assigning",
  "locked",
  "archived",
] as const;

export const slotStates = ["open", "held", "assigned"] as const;

function mutableColumns() {
  return {
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  };
}

export const seasons = sqliteTable(
  "seasons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    year: integer("year").notNull(),
    displayName: text("display_name").notNull(),
    state: text("state", { enum: seasonStates }).notNull().default("setup"),
    ...mutableColumns(),
  },
  (table) => [
    check(
      "seasons_state_check",
      sql`${table.state} in ('setup', 'signups_open', 'signups_closed', 'assigning', 'locked', 'archived')`,
    ),
  ],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // A contact may be deliberately reused by another season; this identifies
    // the season in which the contact record first entered the system.
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    canonicalContactId: integer("canonical_contact_id").references(
      (): AnySQLiteColumn => contacts.id,
    ),
    ...mutableColumns(),
  },
  (table) => [index("contacts_season_id_idx").on(table.seasonId)],
);

export const venues = sqliteTable(
  "venues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    title: text("title").notNull(),
    address: text("address"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    notes: text("notes"),
    hostContactId: integer("host_contact_id").references(() => contacts.id),
    placeholder: integer("placeholder", { mode: "boolean" })
      .notNull()
      .default(false),
    reachViaContactId: integer("reach_via_contact_id").references(
      () => contacts.id,
    ),
    canonicalVenueId: integer("canonical_venue_id").references(
      (): AnySQLiteColumn => venues.id,
    ),
    ...mutableColumns(),
  },
  (table) => [index("venues_season_id_idx").on(table.seasonId)],
);

export const acts = sqliteTable(
  "acts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    name: text("name").notNull(),
    genre: text("genre"),
    description: text("description"),
    links: text("links"),
    placeholder: integer("placeholder", { mode: "boolean" })
      .notNull()
      .default(false),
    reachViaContactId: integer("reach_via_contact_id").references(
      () => contacts.id,
    ),
    canonicalActId: integer("canonical_act_id").references(
      (): AnySQLiteColumn => acts.id,
    ),
    ...mutableColumns(),
  },
  (table) => [index("acts_season_id_idx").on(table.seasonId)],
);

export const slots = sqliteTable(
  "slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venues.id),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
    state: text("state", { enum: slotStates }).notNull().default("open"),
    heldDecideBy: integer("held_decide_by", { mode: "timestamp" }),
    heldForName: text("held_for_name"),
    fallbackVenueId: integer("fallback_venue_id").references(() => venues.id),
    ...mutableColumns(),
  },
  (table) => [
    index("slots_season_id_idx").on(table.seasonId),
    check(
      "slots_state_check",
      sql`${table.state} in ('open', 'held', 'assigned')`,
    ),
    check(
      "slots_held_details_check",
      sql`${table.state} <> 'held' or (${table.heldDecideBy} is not null and ${table.heldForName} is not null)`,
    ),
    check("slots_window_check", sql`${table.endsAt} > ${table.startsAt}`),
  ],
);

export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    actId: integer("act_id")
      .notNull()
      .references(() => acts.id),
    slotId: integer("slot_id")
      .notNull()
      .references(() => slots.id),
    ...mutableColumns(),
  },
  (table) => [
    index("assignments_season_id_idx").on(table.seasonId),
    index("assignments_act_id_idx").on(table.actId),
    index("assignments_slot_id_idx").on(table.slotId),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    recordType: text("record_type").notNull(),
    recordId: integer("record_id").notNull(),
    note: text("note").notNull(),
    ...mutableColumns(),
  },
  (table) => [index("annotations_season_id_idx").on(table.seasonId)],
);

export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type Act = typeof acts.$inferSelect;
export type NewAct = typeof acts.$inferInsert;
export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type Annotation = typeof annotations.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;
