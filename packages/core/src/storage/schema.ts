import { getTableColumns, getTableName, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
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

export const venueGearValues = [
  "pa",
  "microphone",
  "microphone_stand",
  "instrument_amplifier",
  "drum_kit",
  "keyboard",
  "music_stand",
  "extension_cord",
  "power_strip",
  "other",
] as const;

export const venueDrinkValues = [
  "water",
  "non_alcoholic",
  "beer",
  "wine",
  "other",
] as const;

export const venueAmenityValues = [
  "seating",
  "shade",
  "restroom",
  "accessible_entry",
  "parking",
  "other",
] as const;

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
    // R34's first-run setup captures the festival's IANA timezone. Participant
    // availability arrives as a timezone-free wall clock, so this column is what
    // turns "2:00 PM" into an instant. It defaults to UTC rather than guessing a
    // locality: a season that never sets it stores exactly what was typed.
    timezone: text("timezone").notNull().default("UTC"),
    // --- R34 first-run configuration -------------------------------------
    // A deployment that installs successfully and still cannot open a season is
    // a failed install, so everything an organizer must decide to run a season
    // lives here and is captured in one flow.
    eventDate: text("event_date"), // YYYY-MM-DD in the season's own timezone
    signupOpensAt: integer("signup_opens_at", { mode: "timestamp" }),
    signupClosesAt: integer("signup_closes_at", { mode: "timestamp" }),
    // The locality R17 sanity-checks geocoded coordinates against. Stored as a
    // plain box because that is what the check needs and what an organizer can
    // read back; a null box means the check has nothing to assert yet.
    localityName: text("locality_name"),
    boundsNorth: real("bounds_north"),
    boundsSouth: real("bounds_south"),
    boundsEast: real("bounds_east"),
    boundsWest: real("bounds_west"),
    publicSiteUrl: text("public_site_url"),
    publicMapUrl: text("public_map_url"),
    senderName: text("sender_name"),
    senderEmail: text("sender_email"),
    // R35's deployer-configurable retention window.
    retentionDays: integer("retention_days"),
    ...mutableColumns(),
  },
  (table) => [
    check(
      "seasons_state_check",
      sql`${table.state} in ('setup', 'signups_open', 'signups_closed', 'assigning', 'locked', 'archived')`,
    ),
  ],
);

export const seasonTimeSlots = sqliteTable(
  "season_time_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    position: integer("position").notNull(),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
    ...mutableColumns(),
  },
  (table) => [
    index("season_time_slots_season_id_idx").on(table.seasonId),
    uniqueIndex("season_time_slots_season_position_uidx").on(
      table.seasonId,
      table.position,
    ),
    check(
      "season_time_slots_window_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

// --- Organizer access (U5, R9) -------------------------------------------
//
// Bootstrap and invite links are bearer credentials to the whole contact
// database, so they follow KTD8: high entropy, stored only as a hash, given a
// short expiry, and consumed atomically exactly once. Nothing here ever stores a
// token in the clear — a leaked database backup must not be a leaked login.

export const organizers = sqliteTable(
  "organizers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    // Deactivation is a state change rather than a delete, so an audit trail and
    // any annotations this organizer wrote survive them losing access.
    deactivatedAt: integer("deactivated_at", { mode: "timestamp" }),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    ...mutableColumns(),
  },
  (table) => [uniqueIndex("organizers_email_uidx").on(table.email)],
);

export const organizerSessions = sqliteTable(
  "organizer_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizerId: integer("organizer_id")
      .notNull()
      .references(() => organizers.id),
    tokenHash: text("token_hash").notNull(),
    // Two clocks on purpose. The absolute bound is the one the plan requires —
    // a session cannot live forever however active it is — and the idle bound
    // closes an unattended laptop faster than that.
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    idleExpiresAt: integer("idle_expires_at", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    ...mutableColumns(),
  },
  (table) => [
    uniqueIndex("organizer_sessions_token_hash_uidx").on(table.tokenHash),
    index("organizer_sessions_organizer_id_idx").on(table.organizerId),
  ],
);

export const organizerInviteKinds = ["bootstrap", "invite"] as const;

export const organizerInvites = sqliteTable(
  "organizer_invites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: organizerInviteKinds }).notNull(),
    tokenHash: text("token_hash").notNull(),
    // Null for a bootstrap link: the first organizer names themselves when they
    // redeem it, because there is nobody yet to have addressed it to them.
    email: text("email"),
    invitedByOrganizerId: integer("invited_by_organizer_id").references(
      () => organizers.id,
    ),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    redeemedAt: integer("redeemed_at", { mode: "timestamp" }),
    redeemedByOrganizerId: integer("redeemed_by_organizer_id").references(
      () => organizers.id,
    ),
    // Redemption is audited (R9): who took it, and from where.
    redeemedFromIp: text("redeemed_from_ip"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    ...mutableColumns(),
  },
  (table) => [
    uniqueIndex("organizer_invites_token_hash_uidx").on(table.tokenHash),
    index("organizer_invites_kind_idx").on(table.kind),
    check(
      "organizer_invites_kind_check",
      sql`${table.kind} in ('bootstrap', 'invite')`,
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
  (table) => [
    index("contacts_season_id_idx").on(table.seasonId),
    index("contacts_email_idx").on(table.email),
  ],
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
    spaceDescription: text("space_description"),
    hasPower: integer("has_power", { mode: "boolean" }),
    rainBackup: integer("rain_backup", { mode: "boolean" }),
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
    durationMinutes: integer("duration_minutes"),
    requiresAmplification: integer("requires_amplification", {
      mode: "boolean",
    }),
    housePreference: text("house_preference"),
    canLendGear: integer("can_lend_gear", { mode: "boolean" }),
    // The performer-side counterpart to venues.notes: free text the organizers
    // read and the public map never shows.
    notes: text("notes"),
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

export const venueGear = sqliteTable(
  "venue_gear",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venues.id),
    value: text("value", { enum: venueGearValues }).notNull(),
    ...mutableColumns(),
  },
  (table) => [
    index("venue_gear_season_id_idx").on(table.seasonId),
    uniqueIndex("venue_gear_venue_id_value_uidx").on(
      table.venueId,
      table.value,
    ),
    check(
      "venue_gear_value_check",
      sql`${table.value} in ('pa', 'microphone', 'microphone_stand', 'instrument_amplifier', 'drum_kit', 'keyboard', 'music_stand', 'extension_cord', 'power_strip', 'other')`,
    ),
  ],
);

export const venueDrinks = sqliteTable(
  "venue_drinks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venues.id),
    value: text("value", { enum: venueDrinkValues }).notNull(),
    ...mutableColumns(),
  },
  (table) => [
    index("venue_drinks_season_id_idx").on(table.seasonId),
    uniqueIndex("venue_drinks_venue_id_value_uidx").on(
      table.venueId,
      table.value,
    ),
    check(
      "venue_drinks_value_check",
      sql`${table.value} in ('water', 'non_alcoholic', 'beer', 'wine', 'other')`,
    ),
  ],
);

export const venueAmenities = sqliteTable(
  "venue_amenities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venues.id),
    value: text("value", { enum: venueAmenityValues }).notNull(),
    ...mutableColumns(),
  },
  (table) => [
    index("venue_amenities_season_id_idx").on(table.seasonId),
    uniqueIndex("venue_amenities_venue_id_value_uidx").on(
      table.venueId,
      table.value,
    ),
    check(
      "venue_amenities_value_check",
      sql`${table.value} in ('seating', 'shade', 'restroom', 'accessible_entry', 'parking', 'other')`,
    ),
  ],
);

export const actAvailabilities = sqliteTable(
  "act_availabilities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    actId: integer("act_id")
      .notNull()
      .references(() => acts.id),
    startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
    ...mutableColumns(),
  },
  (table) => [
    index("act_availabilities_season_id_idx").on(table.seasonId),
    index("act_availabilities_act_id_idx").on(table.actId),
    uniqueIndex("act_availabilities_act_id_window_uidx").on(
      table.actId,
      table.startsAt,
      table.endsAt,
    ),
    check(
      "act_availabilities_window_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
  ],
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
    index("slots_season_id_state_idx").on(table.seasonId, table.state),
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

export const emailLog = sqliteTable(
  "email_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    recordType: text("record_type").notNull(),
    recordId: integer("record_id").notNull(),
    waveLabel: text("wave_label").notNull(),
    recipientContactId: integer("recipient_contact_id")
      .notNull()
      .references(() => contacts.id),
    sentAt: integer("sent_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    index("email_log_season_id_idx").on(table.seasonId),
    index("email_log_record_idx").on(table.recordType, table.recordId),
    index("email_log_recipient_contact_id_idx").on(table.recipientContactId),
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

const schemaTables = [
  seasons,
  contacts,
  venues,
  acts,
  venueGear,
  venueDrinks,
  venueAmenities,
  actAvailabilities,
  slots,
  assignments,
  emailLog,
  annotations,
  organizers,
  organizerSessions,
  organizerInvites,
  seasonTimeSlots,
] as const;

export const schemaTableDefinitions = Object.freeze(
  schemaTables
    .map((table) =>
      Object.freeze({
        name: getTableName(table),
        columns: Object.freeze(
          Object.values(getTableColumns(table))
            .map((column) => column.name)
            .sort(),
        ),
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name)),
);

export const schemaTableNames = Object.freeze(
  schemaTableDefinitions.map(({ name }) => name),
);

export type SeasonTimeSlot = typeof seasonTimeSlots.$inferSelect;

export type Organizer = typeof organizers.$inferSelect;
export type NewOrganizer = typeof organizers.$inferInsert;
export type OrganizerSession = typeof organizerSessions.$inferSelect;
export type OrganizerInvite = typeof organizerInvites.$inferSelect;
export type OrganizerInviteKind = (typeof organizerInviteKinds)[number];

export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type Act = typeof acts.$inferSelect;
export type NewAct = typeof acts.$inferInsert;
export type VenueGear = typeof venueGear.$inferSelect;
export type NewVenueGear = typeof venueGear.$inferInsert;
export type VenueDrink = typeof venueDrinks.$inferSelect;
export type NewVenueDrink = typeof venueDrinks.$inferInsert;
export type VenueAmenity = typeof venueAmenities.$inferSelect;
export type NewVenueAmenity = typeof venueAmenities.$inferInsert;
export type ActAvailability = typeof actAvailabilities.$inferSelect;
export type NewActAvailability = typeof actAvailabilities.$inferInsert;
export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type EmailLogEntry = typeof emailLog.$inferSelect;
export type NewEmailLogEntry = typeof emailLog.$inferInsert;
export type Annotation = typeof annotations.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;
