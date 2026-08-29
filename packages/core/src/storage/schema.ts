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

/**
 * R6's organizer-set record status. "tentative" is the default because that is
 * what a fresh public submission actually is: received, not yet agreed.
 */
export const recordStatuses = ["tentative", "confirmed", "withdrawn"] as const;

export const coordinateSources = ["geocoded", "organizer-verified"] as const;
export const coordinatePrecisions = ["parcel", "house", "street"] as const;
export const coordinateStatuses = [
  "verified",
  "needs-review",
  "rejected",
  "pending",
] as const;
export const coordinateRejectionCodes = [
  "invalid-coordinate",
  "missing-ref",
  "interpolated",
  "imprecise",
  "out-of-bounds",
  "cross-check-missing",
  "cross-check-distance",
  "address-changed",
  "not-found",
  "refused",
] as const;

export const changeRequestRecordTypes = ["act", "venue"] as const;
export const changeRequestKinds = [
  "withdrawal",
  "availability",
  "address",
] as const;
export const changeRequestStatuses = [
  "pending",
  "applied",
  "rejected",
] as const;

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

// --- U7 outbox (R10-R13, R30, KTD5, KTD6, KTD8) ---------------------------

export const outboxWaveKinds = [
  "thank_you",
  "match",
  "reminder_7day",
  "day_of",
  "post_event",
  "ad_hoc",
] as const;

export const outboxRecipientRules = [
  "matched_venues",
  "unmatched_venues",
  "unmatched_acts",
  "all_participants",
  "manual",
] as const;

export const outboxWaveStatuses = ["open", "complete"] as const;

/**
 * KTD5's message lifecycle. The two `_stale` states exist so that changing data
 * behind an unsent message never rewrites it: the message is flagged, its
 * organizer edits survive, and the organizer decides what happens next.
 */
export const outboxMessageStates = [
  "generated",
  "edited",
  "sent",
  "generated_stale",
  "edited_stale",
] as const;

/**
 * A generated message belongs to the venue or act it is about. `contact` exists
 * only for organizer-authored ad-hoc waves, whose recipients are named directly
 * and may not correspond to a single record.
 */
export const outboxRecordTypes = ["venue", "act", "contact"] as const;

export const outboxSendOutcomes = ["sent", "skipped", "failed"] as const;

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
    // venues-map.v1 requires these as document-level event fields. They live
    // on the season rather than being guessed from a venue address or locality.
    eventCity: text("event_city").notNull().default("Unconfigured"),
    eventState: text("event_state").notNull().default("Unconfigured"),
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
    // R16: publication is an explicit organizer act, not a consequence of
    // locking assignments. Archival clears this timestamp in the domain layer.
    mapPublishedAt: integer("map_published_at", { mode: "timestamp" }),
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

export const queueRecordTypes = ["act", "venue", "contact"] as const;

/**
 * R5: "new" is per organizer, so one organizer working the queue never hides an
 * item from another.
 *
 * The dismissal remembers the record VERSION it was made against, not just that
 * it happened. That single column is what makes R15 true for free: when a
 * participant later edits the record its version moves past the dismissal and the
 * item returns to the queue, without anything having to notice the edit and
 * un-dismiss it.
 */
export const queueDismissals = sqliteTable(
  "queue_dismissals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizerId: integer("organizer_id")
      .notNull()
      .references(() => organizers.id),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    recordType: text("record_type", { enum: queueRecordTypes }).notNull(),
    recordId: integer("record_id").notNull(),
    dismissedVersion: integer("dismissed_version").notNull(),
    ...mutableColumns(),
  },
  (table) => [
    uniqueIndex("queue_dismissals_organizer_record_uidx").on(
      table.organizerId,
      table.recordType,
      table.recordId,
    ),
    index("queue_dismissals_season_idx").on(table.seasonId),
    check(
      "queue_dismissals_record_type_check",
      sql`${table.recordType} in ('act', 'venue', 'contact')`,
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

export const deletionReceiptActions = ["organizer", "retention"] as const;
export const deletionReceiptBackupStatuses = ["pending", "completed"] as const;

/**
 * R35's durable, non-identifying handoff to off-host backup rotation.
 *
 * The contact id remains useful only as a structural key after that contact is
 * scrubbed. No copied name, address, or delivery field belongs here: a backup
 * containing this receipt must not become a second source of the data removed.
 * Status compatibility is enforced in the retention module so this additive
 * table does not trigger SQLite's migration-rebuild trap.
 */
export const deletionReceipts = sqliteTable(
  "deletion_receipts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    action: text("action", { enum: deletionReceiptActions }).notNull(),
    applicationAnonymizedAt: integer("application_anonymized_at", {
      mode: "timestamp",
    }).notNull(),
    backupStatus: text("backup_status", {
      enum: deletionReceiptBackupStatuses,
    })
      .notNull()
      .default("pending"),
    backupCompletedAt: integer("backup_completed_at", { mode: "timestamp" }),
    ...mutableColumns(),
  },
  (table) => [
    uniqueIndex("deletion_receipts_contact_id_uidx").on(table.contactId),
    index("deletion_receipts_backup_status_idx").on(table.backupStatus),
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
    requestedActNames: text("requested_act_names"),
    genrePreferences: text("genre_preferences"),
    rainBackup: integer("rain_backup", { mode: "boolean" }),
    notes: text("notes"),
    status: text("status", { enum: recordStatuses })
      .notNull()
      .default("tentative"),
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

/**
 * KTD11/R29: coordinates have a lifecycle independent of venue record edits.
 * A one-to-one row keeps provider attempts, provenance, organizer attribution,
 * and review state together without making ordinary venue CAS writes own them.
 * Nullable point/ref fields let not-found and refused attempts retain their
 * address/provider provenance without pretending a coordinate was produced.
 */
export const venueCoordinates = sqliteTable(
  "venue_coordinates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venues.id),
    latitude: real("latitude"),
    longitude: real("longitude"),
    source: text("source", { enum: coordinateSources }).notNull(),
    precision: text("precision", { enum: coordinatePrecisions }),
    provider: text("provider").notNull(),
    ref: text("ref"),
    crossCheckDistanceM: real("cross_check_distance_m"),
    status: text("status", { enum: coordinateStatuses }).notNull(),
    rejectionCode: text("rejection_code", {
      enum: coordinateRejectionCodes,
    }),
    addressAtGeocode: text("address_at_geocode").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedBy: integer("updated_by").references(() => organizers.id),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("venue_coordinates_venue_id_uidx").on(table.venueId),
    index("venue_coordinates_status_idx").on(table.status),
    check(
      "venue_coordinates_source_check",
      sql`${table.source} in ('geocoded', 'organizer-verified')`,
    ),
    check(
      "venue_coordinates_precision_check",
      sql`${table.precision} is null or ${table.precision} in ('parcel', 'house', 'street')`,
    ),
    check(
      "venue_coordinates_status_check",
      sql`${table.status} in ('verified', 'needs-review', 'rejected', 'pending')`,
    ),
    check(
      "venue_coordinates_rejection_code_check",
      sql`${table.rejectionCode} is null or ${table.rejectionCode} in ('invalid-coordinate', 'missing-ref', 'interpolated', 'imprecise', 'out-of-bounds', 'cross-check-missing', 'cross-check-distance', 'address-changed', 'not-found', 'refused')`,
    ),
    check(
      "venue_coordinates_point_pair_check",
      sql`(${table.latitude} is null and ${table.longitude} is null) or (${table.latitude} is not null and ${table.longitude} is not null)`,
    ),
  ],
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
    sharedMemberNote: text("shared_member_note"),
    canLendGear: integer("can_lend_gear", { mode: "boolean" }),
    // The performer-side counterpart to venues.notes: free text the organizers
    // read and the public map never shows.
    notes: text("notes"),
    status: text("status", { enum: recordStatuses })
      .notNull()
      .default("tentative"),
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

/**
 * R33 keeps schedule-breaking participant edits as proposals. The captured
 * record version is the KTD7 token apply must consume; proposed_value is null
 * for withdrawal, an ISO-window JSON array for availability, and text for an
 * address. Kind/target/value compatibility is enforced by the core API so this
 * additive table does not trigger SQLite's migration-rebuild trap.
 */
export const changeRequests = sqliteTable(
  "change_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    recordType: text("record_type", {
      enum: changeRequestRecordTypes,
    }).notNull(),
    recordId: integer("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
    kind: text("kind", { enum: changeRequestKinds }).notNull(),
    proposedValue: text("proposed_value"),
    status: text("status", { enum: changeRequestStatuses })
      .notNull()
      .default("pending"),
    ...mutableColumns(),
  },
  (table) => [
    index("change_requests_season_status_idx").on(table.seasonId, table.status),
    index("change_requests_target_idx").on(table.recordType, table.recordId),
  ],
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

export const actLinks = sqliteTable(
  "act_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    actId: integer("act_id")
      .notNull()
      .references(() => acts.id),
    linkedActId: integer("linked_act_id")
      .notNull()
      .references(() => acts.id),
    note: text("note"),
    ...mutableColumns(),
  },
  (table) => [
    index("act_links_season_id_idx").on(table.seasonId),
    uniqueIndex("act_links_act_id_linked_act_id_uidx").on(
      table.actId,
      table.linkedActId,
    ),
    check(
      "act_links_normalized_check",
      sql`${table.actId} < ${table.linkedActId}`,
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
    sharedMemberOverride: text("shared_member_override"),
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
    // R13/KTD6: the send is recorded against the address it actually went to,
    // so correcting a contact later cannot rewrite what was already delivered.
    // All three are nullable because rows written before U7 predate them.
    address: text("address"),
    outcome: text("outcome"),
    messageId: integer("message_id"),
  },
  (table) => [
    index("email_log_season_id_idx").on(table.seasonId),
    index("email_log_record_idx").on(table.recordType, table.recordId),
    index("email_log_recipient_contact_id_idx").on(table.recipientContactId),
  ],
);

/**
 * R10/R11: a wave is the organizer-visible unit of generation. Its templates are
 * stored on the row rather than only in code so a season keeps the wording it
 * was generated with, and so an organizer-authored ad-hoc wave has somewhere to
 * put its own subject and body.
 */
export const outboxWaves = sqliteTable(
  "outbox_waves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    kind: text("kind", { enum: outboxWaveKinds }).notNull(),
    label: text("label").notNull(),
    subjectTemplate: text("subject_template").notNull(),
    bodyTemplate: text("body_template").notNull(),
    recipientRule: text("recipient_rule", {
      enum: outboxRecipientRules,
    }).notNull(),
    status: text("status", { enum: outboxWaveStatuses })
      .notNull()
      .default("open"),
    ...mutableColumns(),
  },
  (table) => [
    index("outbox_waves_season_id_idx").on(table.seasonId),
    uniqueIndex("outbox_waves_season_label_uidx").on(
      table.seasonId,
      table.label,
    ),
    check(
      "outbox_waves_kind_check",
      sql`${table.kind} in ('thank_you', 'match', 'reminder_7day', 'day_of', 'post_event', 'ad_hoc')`,
    ),
    check(
      "outbox_waves_recipient_rule_check",
      sql`${table.recipientRule} in ('matched_venues', 'unmatched_venues', 'unmatched_acts', 'all_participants', 'manual')`,
    ),
    check(
      "outbox_waves_status_check",
      sql`${table.status} in ('open', 'complete')`,
    ),
  ],
);

/**
 * KTD5: the outbox stores the exact payload that will be sent. Nothing is
 * re-derived at send time, so what an organizer reviewed is what transmits.
 *
 * `sourceFingerprint` is the hash of the values the body was rendered from; a
 * mismatch against a freshly built context is what makes a message stale.
 * `preSendState` remembers which lifecycle state a message left when it was
 * sent, so AE9's address correction can put it back exactly where it was.
 * Bodies are nullable because KTD8 purges them once a wave completes.
 */
export const outboxMessages = sqliteTable(
  "outbox_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    waveId: integer("wave_id")
      .notNull()
      .references(() => outboxWaves.id),
    recordType: text("record_type", { enum: outboxRecordTypes }).notNull(),
    recordId: integer("record_id").notNull(),
    state: text("state", { enum: outboxMessageStates })
      .notNull()
      .default("generated"),
    subject: text("subject").notNull(),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    sourceFingerprint: text("source_fingerprint").notNull(),
    preSendState: text("pre_send_state", { enum: outboxMessageStates }),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    ...mutableColumns(),
  },
  (table) => [
    index("outbox_messages_season_id_idx").on(table.seasonId),
    index("outbox_messages_wave_id_idx").on(table.waveId),
    uniqueIndex("outbox_messages_wave_record_uidx").on(
      table.waveId,
      table.recordType,
      table.recordId,
    ),
    check(
      "outbox_messages_record_type_check",
      sql`${table.recordType} in ('venue', 'act', 'contact')`,
    ),
    check(
      "outbox_messages_state_check",
      sql`${table.state} in ('generated', 'edited', 'sent', 'generated_stale', 'edited_stale')`,
    ),
  ],
);

/**
 * KTD6: send state is per recipient and keyed to the address it was sent to.
 * `previousAddress` keeps the address a correction replaced so a sweep can
 * report "corrected - needs resend" rather than silently skipping the person.
 */
export const outboxRecipients = sqliteTable(
  "outbox_recipients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    messageId: integer("message_id")
      .notNull()
      .references(() => outboxMessages.id),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id),
    address: text("address").notNull(),
    previousAddress: text("previous_address"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    outcome: text("outcome", { enum: outboxSendOutcomes }),
    providerMessageId: text("provider_message_id"),
    reason: text("reason"),
    ...mutableColumns(),
  },
  (table) => [
    index("outbox_recipients_season_id_idx").on(table.seasonId),
    index("outbox_recipients_message_id_idx").on(table.messageId),
    uniqueIndex("outbox_recipients_message_contact_uidx").on(
      table.messageId,
      table.contactId,
    ),
    check(
      "outbox_recipients_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in ('sent', 'skipped', 'failed')`,
    ),
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
  deletionReceipts,
  venues,
  venueCoordinates,
  acts,
  changeRequests,
  venueGear,
  venueDrinks,
  venueAmenities,
  actAvailabilities,
  actLinks,
  slots,
  assignments,
  emailLog,
  outboxWaves,
  outboxMessages,
  outboxRecipients,
  annotations,
  organizers,
  organizerSessions,
  organizerInvites,
  seasonTimeSlots,
  queueDismissals,
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
export type QueueDismissal = typeof queueDismissals.$inferSelect;
export type QueueRecordType = (typeof queueRecordTypes)[number];
export type RecordStatus = (typeof recordStatuses)[number];
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type ChangeRequestKind = (typeof changeRequestKinds)[number];
export type ChangeRequestRecordType = (typeof changeRequestRecordTypes)[number];
export type ChangeRequestStatus = (typeof changeRequestStatuses)[number];

export type Organizer = typeof organizers.$inferSelect;
export type NewOrganizer = typeof organizers.$inferInsert;
export type OrganizerSession = typeof organizerSessions.$inferSelect;
export type OrganizerInvite = typeof organizerInvites.$inferSelect;
export type OrganizerInviteKind = (typeof organizerInviteKinds)[number];

export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type DeletionReceipt = typeof deletionReceipts.$inferSelect;
export type DeletionReceiptAction = (typeof deletionReceiptActions)[number];
export type DeletionReceiptBackupStatus =
  (typeof deletionReceiptBackupStatuses)[number];
export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type VenueCoordinate = typeof venueCoordinates.$inferSelect;
export type NewVenueCoordinate = typeof venueCoordinates.$inferInsert;
export type CoordinateSource = (typeof coordinateSources)[number];
export type CoordinatePrecision = (typeof coordinatePrecisions)[number];
export type CoordinateStatus = (typeof coordinateStatuses)[number];
export type CoordinateRejectionCode = (typeof coordinateRejectionCodes)[number];
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
export type ActLink = typeof actLinks.$inferSelect;
export type NewActLink = typeof actLinks.$inferInsert;
export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type EmailLogEntry = typeof emailLog.$inferSelect;
export type NewEmailLogEntry = typeof emailLog.$inferInsert;
export type OutboxWave = typeof outboxWaves.$inferSelect;
export type NewOutboxWave = typeof outboxWaves.$inferInsert;
export type OutboxMessage = typeof outboxMessages.$inferSelect;
export type NewOutboxMessage = typeof outboxMessages.$inferInsert;
export type OutboxRecipient = typeof outboxRecipients.$inferSelect;
export type NewOutboxRecipient = typeof outboxRecipients.$inferInsert;
export type OutboxWaveKind = (typeof outboxWaveKinds)[number];
export type OutboxRecipientRule = (typeof outboxRecipientRules)[number];
export type OutboxWaveStatus = (typeof outboxWaveStatuses)[number];
export type OutboxMessageState = (typeof outboxMessageStates)[number];
export type OutboxRecordType = (typeof outboxRecordTypes)[number];
export type OutboxSendOutcome = (typeof outboxSendOutcomes)[number];
export type Annotation = typeof annotations.$inferSelect;
export type NewAnnotation = typeof annotations.$inferInsert;
