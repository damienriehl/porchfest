// R11's review-before-send outbox.
//
// Two rules shape everything here. Nothing transmits without an organizer
// asking for it by name: generation, staleness, editing and export never touch
// the email port, and `sendSelection` is the only function that does. And the
// stored payload is the payload (KTD5) - a message is rendered once, reviewed,
// and sent byte-for-byte as reviewed, never re-derived at send time.

import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { formatZonedWindow } from "./matching.js";
import type { EmailDeliveryResult, EmailPort } from "./ports/email.js";
import {
  acts,
  assignments,
  contacts,
  emailLog,
  outboxMessages,
  outboxRecipients,
  outboxWaves,
  seasons,
  seasonTimeSlots,
  slots,
  venueAmenities,
  venueDrinks,
  venueGear,
  venues,
  type Act,
  type Assignment,
  type Contact,
  type EmailLogEntry,
  type OutboxMessage,
  type OutboxMessageState,
  type OutboxRecipient,
  type OutboxRecipientRule,
  type OutboxRecordType,
  type OutboxWave,
  type OutboxWaveKind,
  type Season,
  type SeasonTimeSlot,
  type Slot,
  type Venue,
} from "./storage/schema.js";
import {
  conflict as repositoryConflict,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type CoreDatabase,
  type CoreExecutor,
  type RepositoryOptions,
} from "./storage/repository-errors.js";
import {
  renderEml,
  renderWave,
  textToHtml,
  waveTemplates,
  type RenderContext,
  type WaveTemplateKey,
} from "./waves.js";

export class OutboxLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("OutboxLifecycleError", message);
  }
}

export class OutboxConflictError extends RepositoryConflictError<
  "outbox_wave" | "outbox_message" | "outbox_recipient"
> {
  constructor(
    recordType: "outbox_wave" | "outbox_message" | "outbox_recipient",
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    super("OutboxConflictError", recordType, recordId, conflictingFields);
  }
}

export type OutboxRepositoryOptions = RepositoryOptions;

export interface OutboxPorts {
  readonly email: EmailPort;
}

export interface OutboxMessageView extends OutboxMessage {
  readonly recipients: readonly OutboxRecipient[];
}

export interface GeneratedWave {
  readonly wave: OutboxWave;
  readonly messages: readonly OutboxMessageView[];
}

export interface GenerateWaveInput {
  readonly seasonId: number;
  readonly kind: OutboxWaveKind;
  readonly label?: string;
  /** Overrides the kind's default audience, e.g. floating performers. */
  readonly recipientRule?: OutboxRecipientRule;
}

export interface EditMessageInput {
  readonly subject?: string;
  readonly text: string;
}

export interface AdHocWaveInput {
  readonly seasonId: number;
  readonly label: string;
  readonly subject: string;
  readonly text: string;
  readonly recipientContactIds: readonly number[];
}

export interface SendSelectionInput {
  readonly waveId: number;
  readonly messageIds: readonly number[];
  readonly expectedVersions: Readonly<Record<number, number>>;
}

export interface SendRecipientOutcome {
  readonly messageId: number;
  readonly recipientId: number;
  readonly contactId: number;
  readonly address: string;
  readonly status: EmailDeliveryResult["status"];
  readonly reason: string | null;
  readonly providerMessageId: string | null;
  /**
   * Whether this outcome reached the recipient row. False when the row moved
   * on under the send - the outcome happened, but nothing recorded it, and a
   * sweep must treat the recipient as still needing attention.
   */
  readonly recorded: boolean;
}

export interface SendReport {
  readonly waveId: number;
  readonly attempted: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly completedMessageIds: readonly number[];
  readonly recipients: readonly SendRecipientOutcome[];
}

export interface ExportedMessage {
  readonly messageId: number;
  readonly subject: string;
  readonly text: string;
  readonly eml: string;
}

export interface ContactAddressChange {
  readonly contactId: number;
  readonly previousAddress: string | null;
  readonly newAddress: string | null;
}

const DEFAULT_RECIPIENT_RULES: Readonly<
  Record<OutboxWaveKind, OutboxRecipientRule>
> = Object.freeze({
  match: "matched_venues",
  thank_you: "unmatched_venues",
  reminder_7day: "matched_venues",
  day_of: "matched_venues",
  post_event: "all_participants",
  ad_hoc: "manual",
});

const GEAR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pa: "PA",
  microphone: "microphone",
  microphone_stand: "microphone stand",
  instrument_amplifier: "instrument amplifier",
  drum_kit: "drum kit",
  keyboard: "keyboard",
  music_stand: "music stand",
  extension_cord: "extension cord",
  power_strip: "power strip",
  other: "other gear",
});

const DRINK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  water: "water",
  non_alcoholic: "non-alcoholic drinks",
  beer: "beer",
  wine: "wine",
  other: "other drinks",
});

const AMENITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  seating: "seating",
  shade: "shade",
  restroom: "restroom access",
  accessible_entry: "accessible entry",
  parking: "parking",
  other: "other amenities",
});

const MATCH_ASKS = [
  "- Reply-all to introduce yourselves and agree on arrival and setup time.",
  "- Hosts: confirm the space, the power, and any gear you can lend.",
  "- Performers: confirm your set length and anything you still need.",
  "- Tell us right away if anything about this match will not work.",
].join("\n");

const FLOATING_ASKS = [
  "- Tell us if you could play a different window than the one you listed.",
  "- Tell us if you can bring your own PA.",
  "- Reply if anything has changed since you signed up.",
].join("\n");

const DEFAULT_FOLLOWUP_LINES = [
  "- Tell us how your porch went - what worked, what we should fix.",
  "- Send us photos if you took any; we love seeing the day.",
].join("\n");

const NOT_PROVIDED = "Not provided";
const NOT_RECORDED = "Not recorded";

function firstName(name: string): string {
  const token = name.trim().split(/\s+/)[0];
  return token === undefined || token.length === 0 ? name.trim() : token;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

function yesNoUnknown(value: boolean | null): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function rainLine(value: boolean | null): string {
  if (value === true) return "The host has a covered or indoor backup space.";
  if (value === false) return "No indoor backup - the show runs rain or shine.";
  return NOT_RECORDED;
}

function label(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value.replaceAll("_", " ");
}

/** Ordering that is the same on every host, unlike a default-locale collation. */
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface SeasonSource {
  readonly season: Season;
  readonly timeSlots: readonly SeasonTimeSlot[];
  readonly venues: readonly Venue[];
  readonly acts: readonly Act[];
  readonly contactsById: ReadonlyMap<number, Contact>;
  readonly slotsById: ReadonlyMap<number, Slot>;
  readonly assignments: readonly Assignment[];
  readonly gearByVenue: ReadonlyMap<number, readonly string[]>;
  readonly drinksByVenue: ReadonlyMap<number, readonly string[]>;
  readonly amenitiesByVenue: ReadonlyMap<number, readonly string[]>;
}

interface ActScheduleSource {
  readonly assignments: readonly Assignment[];
  readonly slotsById: ReadonlyMap<number, Slot>;
  readonly venues: readonly Venue[];
}

interface ActSchedule {
  readonly bookings: readonly {
    readonly assignment: Assignment;
    readonly slot: Slot;
    readonly venue: Venue;
  }[];
  readonly slotLines: string;
  readonly slotSummary: string;
}

/** @internal Kept exported so schedule coverage has a focused regression seam. */
export function buildActSchedule(
  source: ActScheduleSource,
  actId: number,
  actName: string,
  timezone: string,
): ActSchedule {
  const bookings: {
    assignment: Assignment;
    slot: Slot;
    venue: Venue;
  }[] = [];
  for (const assignment of source.assignments) {
    if (assignment.actId !== actId) continue;
    const slot = source.slotsById.get(assignment.slotId);
    if (!slot) continue;
    const venue = source.venues.find(
      (candidate) => candidate.id === slot.venueId,
    );
    if (!venue) continue;
    bookings.push({ assignment, slot, venue });
  }
  bookings.sort(
    (left, right) =>
      left.slot.startsAt.getTime() - right.slot.startsAt.getTime() ||
      left.slot.id - right.slot.id,
  );

  const windows = bookings.map(({ slot }) => formatZonedWindow(slot, timezone));
  return {
    bookings,
    slotLines:
      bookings.length === 0
        ? "- Not scheduled yet."
        : bookings
            .map(
              ({ slot }) =>
                `- ${formatZonedWindow(slot, timezone)} — ${actName}`,
            )
            .join("\n"),
    slotSummary:
      windows.length === 0 ? "time to be confirmed" : windows.join(", "),
  };
}

type Target =
  | { readonly recordType: "venue"; readonly record: Venue }
  | { readonly recordType: "act"; readonly record: Act };

interface RenderedPayload {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly fingerprint: string;
  readonly contacts: readonly Contact[];
}

export function createOutboxRepository(
  db: CoreDatabase,
  ports: OutboxPorts,
  options: OutboxRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function conflict(
    recordType: "outbox_wave" | "outbox_message" | "outbox_recipient",
    recordId: number,
    fields: readonly string[],
  ): never {
    return repositoryConflict(
      OutboxConflictError,
      recordType,
      recordId,
      fields,
    );
  }

  // --- reading the world a message is rendered from ------------------------

  function loadSource(executor: CoreExecutor, seasonId: number): SeasonSource {
    const season = executor
      .select()
      .from(seasons)
      .where(eq(seasons.id, seasonId))
      .get();
    if (!season) {
      throw new OutboxLifecycleError(`season ${seasonId} does not exist`);
    }
    const seasonVenues = executor
      .select()
      .from(venues)
      .where(eq(venues.seasonId, seasonId))
      .orderBy(asc(venues.id))
      .all()
      .filter(
        (venue) =>
          venue.canonicalVenueId === null && venue.status !== "withdrawn",
      );
    const seasonActs = executor
      .select()
      .from(acts)
      .where(eq(acts.seasonId, seasonId))
      .orderBy(asc(acts.id))
      .all()
      .filter(
        (act) => act.canonicalActId === null && act.status !== "withdrawn",
      );
    const bucket = (
      rows: readonly { venueId: number; value: string }[],
    ): Map<number, string[]> => {
      const grouped = new Map<number, string[]>();
      for (const row of rows) {
        const existing = grouped.get(row.venueId);
        if (existing) existing.push(row.value);
        else grouped.set(row.venueId, [row.value]);
      }
      return grouped;
    };

    return {
      season,
      timeSlots: executor
        .select()
        .from(seasonTimeSlots)
        .where(eq(seasonTimeSlots.seasonId, seasonId))
        .orderBy(asc(seasonTimeSlots.startsAt), asc(seasonTimeSlots.id))
        .all(),
      venues: seasonVenues,
      acts: seasonActs,
      contactsById: new Map(
        executor
          .select()
          .from(contacts)
          .where(eq(contacts.seasonId, seasonId))
          .all()
          .map((contact) => [contact.id, contact]),
      ),
      slotsById: new Map(
        executor
          .select()
          .from(slots)
          .where(eq(slots.seasonId, seasonId))
          .all()
          .map((slot) => [slot.id, slot]),
      ),
      assignments: executor
        .select()
        .from(assignments)
        .where(eq(assignments.seasonId, seasonId))
        .orderBy(asc(assignments.id))
        .all(),
      gearByVenue: bucket(
        executor
          .select({ venueId: venueGear.venueId, value: venueGear.value })
          .from(venueGear)
          .where(eq(venueGear.seasonId, seasonId))
          .orderBy(asc(venueGear.id))
          .all(),
      ),
      drinksByVenue: bucket(
        executor
          .select({ venueId: venueDrinks.venueId, value: venueDrinks.value })
          .from(venueDrinks)
          .where(eq(venueDrinks.seasonId, seasonId))
          .orderBy(asc(venueDrinks.id))
          .all(),
      ),
      amenitiesByVenue: bucket(
        executor
          .select({
            venueId: venueAmenities.venueId,
            value: venueAmenities.value,
          })
          .from(venueAmenities)
          .where(eq(venueAmenities.seasonId, seasonId))
          .orderBy(asc(venueAmenities.id))
          .all(),
      ),
    };
  }

  function canonicalContact(
    source: SeasonSource,
    contactId: number | null,
  ): Contact | null {
    if (contactId === null) return null;
    let contact = source.contactsById.get(contactId) ?? null;
    const seen = new Set<number>();
    while (contact !== null && contact.canonicalContactId !== null) {
      if (seen.has(contact.id)) break;
      seen.add(contact.id);
      contact = source.contactsById.get(contact.canonicalContactId) ?? null;
    }
    return contact;
  }

  function sortContacts(list: readonly Contact[]): Contact[] {
    // Name then id, so the order a message lists people in never depends on the
    // order they happened to sign up in - and by code point, so it never
    // depends on the container's ICU default either. A host whose collation
    // ordered two accented names differently would otherwise change the
    // rendered bytes, and with them the fingerprint that decides staleness.
    return [...list].sort(
      (left, right) =>
        compareCodePoints(left.name, right.name) || left.id - right.id,
    );
  }

  function venueAssignments(
    source: SeasonSource,
    venueId: number,
  ): { assignment: Assignment; slot: Slot; act: Act }[] {
    const rows: { assignment: Assignment; slot: Slot; act: Act }[] = [];
    for (const assignment of source.assignments) {
      const slot = source.slotsById.get(assignment.slotId);
      if (!slot || slot.venueId !== venueId) continue;
      const act = source.acts.find(
        (candidate) => candidate.id === assignment.actId,
      );
      if (!act) continue;
      rows.push({ assignment, slot, act });
    }
    return rows.sort(
      (left, right) =>
        left.slot.startsAt.getTime() - right.slot.startsAt.getTime() ||
        left.slot.id - right.slot.id,
    );
  }

  function contactLine(contact: Contact): string {
    const parts = [contact.name, contact.email ?? "(no email on file)"];
    if (contact.phone) parts.push(contact.phone);
    return `- ${parts.join(" — ")}`;
  }

  function eventContext(source: SeasonSource): Record<string, string> {
    const { season, timeSlots } = source;
    const eventDate = season.eventDate;
    let dateDisplay = "";
    if (eventDate !== null) {
      // Noon avoids any chance of a midnight instant landing on the day before
      // when it is rendered back in the season's own zone.
      const instant = new Date(`${eventDate}T12:00:00.000Z`);
      dateDisplay = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(instant);
    }
    const timeDisplay =
      timeSlots.length === 0
        ? ""
        : formatZonedWindow(
            {
              startsAt: timeSlots[0]!.startsAt,
              endsAt: timeSlots[timeSlots.length - 1]!.endsAt,
            },
            season.timezone,
          );

    return {
      event_name: season.displayName,
      event_date_display: dateDisplay,
      event_time_display: timeDisplay,
      map_url: season.publicMapUrl ?? "",
      organizer_signature: season.senderName ?? "",
      organizer_name: season.senderName ?? "",
      // No sender phone is captured at setup, so this renders blank rather than
      // inventing a number the organizer never gave us.
      organizer_phone: "",
    };
  }

  function venueContext(
    source: SeasonSource,
    venue: Venue,
  ): { context: RenderContext; contacts: Contact[] } {
    const booked = venueAssignments(source, venue.id);
    const host =
      canonicalContact(source, venue.hostContactId) ??
      canonicalContact(source, venue.reachViaContactId);
    const performerContacts = booked
      .map(({ act }) => canonicalContact(source, act.reachViaContactId))
      .filter((contact): contact is Contact => contact !== null);
    const recipients = sortContacts(
      [...(host === null ? [] : [host]), ...performerContacts].filter(
        (contact, index, list) =>
          list.findIndex((other) => other.id === contact.id) === index,
      ),
    );

    const gear = source.gearByVenue.get(venue.id) ?? [];
    const drinks = source.drinksByVenue.get(venue.id) ?? [];
    const amenities = source.amenitiesByVenue.get(venue.id) ?? [];
    const logistics: string[] = [];
    if (gear.length > 0) {
      logistics.push(
        `- The host can provide: ${gear.map((value) => label(GEAR_LABELS, value)).join(", ")}`,
      );
    }
    if (drinks.length > 0) {
      logistics.push(
        `- Drinks on offer: ${drinks.map((value) => label(DRINK_LABELS, value)).join(", ")}`,
      );
    }
    if (amenities.length > 0) {
      logistics.push(
        `- On site: ${amenities.map((value) => label(AMENITY_LABELS, value)).join(", ")}`,
      );
    }
    for (const { act } of booked) {
      if (act.requiresAmplification === true) {
        logistics.push(
          `- ${act.name} need amplification; the porch reports power: ${yesNoUnknown(venue.hasPower)}.`,
        );
      }
      if (act.canLendGear === true) {
        logistics.push(`- ${act.name} can lend gear.`);
      }
    }
    if (logistics.length === 0) {
      logistics.push("- Nothing recorded yet - please coordinate directly.");
    }

    const windows = booked.map(({ slot }) =>
      formatZonedWindow(slot, source.season.timezone),
    );
    const address = venue.address ?? venue.title;
    const notes = venue.notes?.trim() ?? "";
    const greetingNames = recipients.map((contact) => firstName(contact.name));

    return {
      contacts: recipients,
      context: {
        ...eventContext(source),
        address_display: address,
        space_line: venue.spaceDescription ?? NOT_PROVIDED,
        electrical_line: yesNoUnknown(venue.hasPower),
        rain_line: rainLine(venue.rainBackup),
        notes_block: notes === "" ? "" : `NOTES FROM YOUR HOST\n${notes}`,
        status_note:
          notes === ""
            ? "We do not have a match for your porch yet - we are still pairing acts with porches."
            : `We do not have a match for your porch yet. You told us: ${notes}`,
        status_lines: "- We are still matching acts with porches.",
        host_first_name: host === null ? "there" : firstName(host.name),
        performer_greeting_names:
          performerContacts.length === 0
            ? "friends"
            : joinNames(
                sortContacts(performerContacts).map((contact) =>
                  firstName(contact.name),
                ),
              ),
        greeting_names:
          greetingNames.length === 0 ? "there" : joinNames(greetingNames),
        participation_line: `Your porch at ${address} was one of the stages that made it happen.`,
        band_name: booked.map(({ act }) => act.name).join(", "),
        slot_lines:
          booked.length === 0
            ? "- We are still matching acts with your porch."
            : booked
                .map(
                  ({ slot, act }) =>
                    `- ${formatZonedWindow(slot, source.season.timezone)} — ${act.name}`,
                )
                .join("\n"),
        slot_summary:
          windows.length === 0 ? "time to be confirmed" : windows.join(", "),
        contact_lines:
          recipients.length === 0
            ? "- No contact on file yet."
            : recipients.map(contactLine).join("\n"),
        logistics_lines: logistics.join("\n"),
        asks_lines: MATCH_ASKS,
        followup_lines: DEFAULT_FOLLOWUP_LINES,
      },
    };
  }

  function actContext(
    source: SeasonSource,
    act: Act,
  ): { context: RenderContext; contacts: Contact[] } {
    const contact = canonicalContact(source, act.reachViaContactId);
    const recipients = contact === null ? [] : [contact];
    const schedule = buildActSchedule(
      source,
      act.id,
      act.name,
      source.season.timezone,
    );
    const booked = schedule.bookings[0] ?? null;
    const status: string[] = [];
    if (act.housePreference?.trim()) {
      status.push(`- You asked for: ${act.housePreference.trim()}`);
    }
    if (act.notes?.trim()) {
      status.push(`- You told us: ${act.notes.trim()}`);
    }
    status.push(
      booked === null
        ? "- We are still looking for the right porch for you."
        : `- You are matched to ${booked.venue.address ?? booked.venue.title}.`,
    );

    const greetingNames = recipients.map((row) => firstName(row.name));
    return {
      contacts: recipients,
      context: {
        ...eventContext(source),
        address_display:
          booked === null
            ? "a porch we are still choosing"
            : (booked.venue.address ?? booked.venue.title),
        space_line: booked?.venue.spaceDescription ?? NOT_PROVIDED,
        electrical_line: yesNoUnknown(booked?.venue.hasPower ?? null),
        rain_line: rainLine(booked?.venue.rainBackup ?? null),
        notes_block: "",
        status_note: status.join("\n"),
        status_lines: status.join("\n"),
        host_first_name: "there",
        performer_greeting_names:
          greetingNames.length === 0 ? "there" : joinNames(greetingNames),
        greeting_names:
          greetingNames.length === 0 ? "there" : joinNames(greetingNames),
        participation_line: `${act.name} were one of the acts that made it happen.`,
        band_name: act.name,
        slot_lines: schedule.slotLines,
        slot_summary: schedule.slotSummary,
        contact_lines:
          recipients.length === 0
            ? "- No contact on file yet."
            : recipients.map(contactLine).join("\n"),
        logistics_lines:
          act.canLendGear === true
            ? `- ${act.name} can lend gear.`
            : "- Nothing recorded yet - please coordinate directly.",
        asks_lines: FLOATING_ASKS,
        followup_lines: DEFAULT_FOLLOWUP_LINES,
      },
    };
  }

  function fingerprint(templateKey: string, context: RenderContext): string {
    const canonical = Object.entries(context as Record<string, string>).sort(
      ([left], [right]) => compareCodePoints(left, right),
    );
    return createHash("sha256")
      .update(JSON.stringify([templateKey, canonical]))
      .digest("hex");
  }

  function templateKeyFor(
    kind: OutboxWaveKind,
    recordType: OutboxRecordType,
  ): WaveTemplateKey {
    if (kind === "post_event") return "post_event";
    if (recordType === "act") return "floating_performer";
    switch (kind) {
      case "match":
        return "match";
      case "thank_you":
        return "thank_you_venue";
      case "reminder_7day":
        return "reminder_7day";
      case "day_of":
        return "day_of";
      default:
        throw new OutboxLifecycleError(
          `wave kind ${kind} has no generated template`,
        );
    }
  }

  function renderTarget(
    source: SeasonSource,
    target: Target,
    templateKey: WaveTemplateKey,
  ): RenderedPayload {
    const built =
      target.recordType === "venue"
        ? venueContext(source, target.record)
        : actContext(source, target.record);
    const rendered = renderWave(templateKey, built.context);
    return {
      subject: rendered.subject,
      text: rendered.text,
      html: textToHtml(rendered.text),
      fingerprint: fingerprint(templateKey, built.context),
      contacts: built.contacts,
    };
  }

  /** The record a stored message was rendered from, if it still qualifies. */
  function targetFor(
    source: SeasonSource,
    recordType: OutboxRecordType,
    recordId: number,
  ): Target | null {
    if (recordType === "venue") {
      const venue = source.venues.find((row) => row.id === recordId);
      return venue === undefined
        ? null
        : { recordType: "venue", record: venue };
    }
    if (recordType === "act") {
      const act = source.acts.find((row) => row.id === recordId);
      return act === undefined ? null : { recordType: "act", record: act };
    }
    return null;
  }

  function targetsFor(
    source: SeasonSource,
    rule: OutboxRecipientRule,
  ): Target[] {
    const matchedVenueIds = new Set(
      source.assignments
        .map((assignment) => source.slotsById.get(assignment.slotId)?.venueId)
        .filter((venueId): venueId is number => venueId !== undefined),
    );
    const assignedActIds = new Set(
      source.assignments.map((assignment) => assignment.actId),
    );
    const venueTargets = (include: (venue: Venue) => boolean): Target[] =>
      source.venues
        .filter(include)
        .map((venue) => ({ recordType: "venue" as const, record: venue }));
    const unmatchedActs = (): Target[] =>
      source.acts
        .filter((act) => !assignedActIds.has(act.id))
        .map((act) => ({ recordType: "act" as const, record: act }));

    switch (rule) {
      case "matched_venues":
        return venueTargets((venue) => matchedVenueIds.has(venue.id));
      case "unmatched_venues":
        return venueTargets((venue) => !matchedVenueIds.has(venue.id));
      case "unmatched_acts":
        return unmatchedActs();
      case "all_participants":
        return [...venueTargets(() => true), ...unmatchedActs()];
      case "manual":
        return [];
    }
  }

  // --- rows ---------------------------------------------------------------

  function waveRow(executor: CoreExecutor, waveId: number): OutboxWave {
    const wave = executor
      .select()
      .from(outboxWaves)
      .where(eq(outboxWaves.id, waveId))
      .get();
    if (!wave) {
      throw new OutboxLifecycleError(`outbox wave ${waveId} does not exist`);
    }
    return wave;
  }

  function messageRow(
    executor: CoreExecutor,
    messageId: number,
  ): OutboxMessage {
    const message = executor
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, messageId))
      .get();
    if (!message) {
      throw new OutboxLifecycleError(
        `outbox message ${messageId} does not exist`,
      );
    }
    return message;
  }

  function recipientRows(
    executor: CoreExecutor,
    messageId: number,
  ): OutboxRecipient[] {
    return executor
      .select()
      .from(outboxRecipients)
      .where(eq(outboxRecipients.messageId, messageId))
      .orderBy(asc(outboxRecipients.id))
      .all();
  }

  function messageViews(
    executor: CoreExecutor,
    waveId: number,
  ): OutboxMessageView[] {
    return executor
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.waveId, waveId))
      .orderBy(asc(outboxMessages.id))
      .all()
      .map((message) => ({
        ...message,
        recipients: recipientRows(executor, message.id),
      }));
  }

  // --- KTD8's purge -------------------------------------------------------

  function purgeIn(executor: CoreExecutor, seasonId: number): void {
    const stamp = now();
    for (const wave of executor
      .select()
      .from(outboxWaves)
      .where(eq(outboxWaves.seasonId, seasonId))
      .all()) {
      const rows = executor
        .select({ state: outboxMessages.state, sentAt: outboxMessages.sentAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.waveId, wave.id))
        .all();
      const complete =
        rows.length > 0 &&
        rows.every((row) => row.state === "sent" && row.sentAt !== null);
      // A wave that completed at any point has bodies to purge, even if a
      // regeneration has since reopened it: those bodies belong to rows that
      // are already terminal, and their lifetime ended when the wave finished.
      if (complete || wave.status === "complete") {
        // Narrowed to terminal rows on purpose: a regeneration that landed in
        // this wave between the completion check and this statement is not
        // sent, so it cannot be caught by it.
        executor
          .update(outboxMessages)
          .set({ textBody: null, htmlBody: null, updatedAt: stamp })
          .where(
            and(
              eq(outboxMessages.waveId, wave.id),
              eq(outboxMessages.state, "sent"),
              isNotNull(outboxMessages.sentAt),
              or(
                isNotNull(outboxMessages.textBody),
                isNotNull(outboxMessages.htmlBody),
              ),
            ),
          )
          .run();
      }
      if (complete === (wave.status === "complete")) continue;
      executor
        .update(outboxWaves)
        .set({
          status: complete ? "complete" : "open",
          version: sql`${outboxWaves.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(outboxWaves.id, wave.id),
            eq(outboxWaves.version, wave.version),
          ),
        )
        .run();
    }
  }

  // --- R30's staleness ----------------------------------------------------

  function refreshIn(executor: CoreExecutor, seasonId: number): void {
    const source = loadSource(executor, seasonId);
    const stamp = now();
    for (const wave of executor
      .select()
      .from(outboxWaves)
      .where(eq(outboxWaves.seasonId, seasonId))
      .all()) {
      // An organizer-authored wave has no generated source to drift from.
      if (wave.recipientRule === "manual") continue;
      const rows = executor
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.waveId, wave.id),
            isNull(outboxMessages.sentAt),
            ne(outboxMessages.state, "sent"),
          ),
        )
        .all();
      for (const message of rows) {
        const target = targetFor(source, message.recordType, message.recordId);
        if (target === null) continue;
        const fresh = renderTarget(
          source,
          target,
          templateKeyFor(wave.kind, message.recordType),
        ).fingerprint;
        const drifted = fresh !== message.sourceFingerprint;
        const next: OutboxMessageState = drifted
          ? message.state === "generated"
            ? "generated_stale"
            : message.state === "edited"
              ? "edited_stale"
              : message.state
          : message.state === "generated_stale"
            ? "generated"
            : message.state === "edited_stale"
              ? "edited"
              : message.state;
        if (next === message.state) continue;
        // Staleness is derived, not an organizer edit, so it deliberately does
        // NOT bump `version`: a caller holding a version read a moment ago must
        // still be able to edit the message it just looked at. The state it was
        // read in is the concurrency token instead.
        executor
          .update(outboxMessages)
          .set({ state: next, updatedAt: stamp })
          .where(
            and(
              eq(outboxMessages.id, message.id),
              eq(outboxMessages.state, message.state),
              isNull(outboxMessages.sentAt),
            ),
          )
          .run();
      }
    }
  }

  function settle(executor: CoreExecutor, seasonId: number): void {
    purgeIn(executor, seasonId);
    refreshIn(executor, seasonId);
  }

  // --- generation ---------------------------------------------------------

  function ensureWave(
    executor: CoreExecutor,
    input: {
      seasonId: number;
      kind: OutboxWaveKind;
      label: string;
      recipientRule: OutboxRecipientRule;
      subjectTemplate: string;
      bodyTemplate: string;
    },
    stamp: Date,
  ): OutboxWave {
    const existing = executor
      .select()
      .from(outboxWaves)
      .where(
        and(
          eq(outboxWaves.seasonId, input.seasonId),
          eq(outboxWaves.label, input.label),
        ),
      )
      .get();
    if (existing) {
      if (existing.kind !== input.kind) {
        throw new OutboxLifecycleError(
          `wave ${input.label} already exists as a ${existing.kind} wave`,
        );
      }
      // The caller builds its targets from the rule it passed in; returning a
      // row that names a different one would leave the wave describing an
      // audience its own messages were never generated for, and `refreshIn`
      // would then check them against that wrong rule.
      if (existing.recipientRule !== input.recipientRule) {
        throw new OutboxLifecycleError(
          `wave ${input.label} already exists for ${existing.recipientRule}, not ${input.recipientRule}`,
        );
      }
      return existing;
    }
    return executor
      .insert(outboxWaves)
      .values({
        seasonId: input.seasonId,
        kind: input.kind,
        label: input.label,
        subjectTemplate: input.subjectTemplate,
        bodyTemplate: input.bodyTemplate,
        recipientRule: input.recipientRule,
        status: "open",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
  }

  function splitTemplate(templateKey: WaveTemplateKey): {
    subjectTemplate: string;
    bodyTemplate: string;
  } {
    const template = waveTemplates[templateKey];
    const firstBreak = template.indexOf("\n");
    return {
      subjectTemplate: template.slice("Subject: ".length, firstBreak).trim(),
      bodyTemplate: template.slice(firstBreak + 1).trim(),
    };
  }

  function syncRecipients(
    executor: CoreExecutor,
    message: Pick<OutboxMessage, "id" | "seasonId">,
    people: readonly Contact[],
    stamp: Date,
  ): void {
    const wanted = new Map(
      people
        .filter((contact) => (contact.email ?? "").trim().length > 0)
        .map((contact) => [contact.id, contact.email!.trim()]),
    );
    for (const row of recipientRows(executor, message.id)) {
      const address = wanted.get(row.contactId);
      if (address === undefined) {
        // A recipient who is no longer part of this message keeps their row if
        // they were already written to; the history is not ours to rewrite.
        if (row.sentAt === null) {
          executor
            .delete(outboxRecipients)
            .where(
              and(
                eq(outboxRecipients.id, row.id),
                isNull(outboxRecipients.sentAt),
              ),
            )
            .run();
        }
        continue;
      }
      wanted.delete(row.contactId);
      if (row.sentAt !== null || row.address === address) continue;
      executor
        .update(outboxRecipients)
        .set({
          address,
          version: sql`${outboxRecipients.version} + 1`,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(outboxRecipients.id, row.id),
            eq(outboxRecipients.version, row.version),
            isNull(outboxRecipients.sentAt),
          ),
        )
        .run();
    }
    for (const [contactId, address] of wanted) {
      executor
        .insert(outboxRecipients)
        .values({
          seasonId: message.seasonId,
          messageId: message.id,
          contactId,
          address,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run();
    }
  }

  function generateWave(input: GenerateWaveInput): GeneratedWave {
    return db.transaction(
      (tx) => {
        settle(tx, input.seasonId);
        const rule = input.recipientRule ?? DEFAULT_RECIPIENT_RULES[input.kind];
        if (rule === "manual") {
          throw new OutboxLifecycleError(
            "an ad-hoc wave is created with createAdHocWave",
          );
        }
        const waveLabel =
          input.label ??
          (rule === DEFAULT_RECIPIENT_RULES[input.kind]
            ? input.kind
            : `${input.kind}_${rule}`);
        const primaryRecordType: OutboxRecordType =
          rule === "unmatched_acts" ? "act" : "venue";
        // One stamp for the whole generation: every row it writes carries the
        // same `updatedAt`, so a single call cannot look like several.
        const stamp = now();
        const wave = ensureWave(
          tx,
          {
            seasonId: input.seasonId,
            kind: input.kind,
            label: waveLabel,
            recipientRule: rule,
            ...splitTemplate(templateKeyFor(input.kind, primaryRecordType)),
          },
          stamp,
        );

        const source = loadSource(tx, input.seasonId);
        const targets = targetsFor(source, rule);
        const existing = tx
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.waveId, wave.id))
          .all();
        const keep = new Set<string>();

        for (const target of targets) {
          keep.add(`${target.recordType}:${target.record.id}`);
          const payload = renderTarget(
            source,
            target,
            templateKeyFor(wave.kind, target.recordType),
          );
          const current = existing.find(
            (row) =>
              row.recordType === target.recordType &&
              row.recordId === target.record.id,
          );
          let messageId: number;
          if (current === undefined) {
            messageId = tx
              .insert(outboxMessages)
              .values({
                seasonId: input.seasonId,
                waveId: wave.id,
                recordType: target.recordType,
                recordId: target.record.id,
                state: "generated",
                subject: payload.subject,
                textBody: payload.text,
                htmlBody: payload.html,
                sourceFingerprint: payload.fingerprint,
                createdAt: stamp,
                updatedAt: stamp,
              })
              .returning({ id: outboxMessages.id })
              .get().id;
          } else {
            messageId = current.id;
            // R30: regeneration replaces generated messages and never touches
            // an edited or sent one.
            if (
              current.state === "generated" ||
              current.state === "generated_stale"
            ) {
              const unchanged =
                current.sourceFingerprint === payload.fingerprint &&
                current.state === "generated" &&
                current.textBody === payload.text &&
                current.htmlBody === payload.html &&
                current.subject === payload.subject;
              if (!unchanged) {
                const result = tx
                  .update(outboxMessages)
                  .set({
                    state: "generated",
                    subject: payload.subject,
                    textBody: payload.text,
                    htmlBody: payload.html,
                    sourceFingerprint: payload.fingerprint,
                    version: sql`${outboxMessages.version} + 1`,
                    updatedAt: stamp,
                  })
                  .where(
                    and(
                      eq(outboxMessages.id, current.id),
                      eq(outboxMessages.version, current.version),
                      isNull(outboxMessages.sentAt),
                    ),
                  )
                  .run();
                if (result.changes !== 1) {
                  conflict("outbox_message", current.id, ["state"]);
                }
              }
            }
          }
          const stored = messageRow(tx, messageId);
          if (stored.sentAt === null) {
            syncRecipients(tx, stored, payload.contacts, stamp);
          }
        }

        for (const row of existing) {
          if (keep.has(`${row.recordType}:${row.recordId}`)) continue;
          if (
            row.sentAt !== null ||
            (row.state !== "generated" && row.state !== "generated_stale")
          ) {
            continue;
          }
          // KTD6/R13: a message stays unsent while any one recipient failed, so
          // an unsent message can still own stamped recipient rows. Dropping it
          // out of the wave must never take that send history with it - the
          // people who were written to would be re-mailed on the next send.
          const current = messageRow(tx, row.id);
          if (current.sentAt !== null) continue;
          const recipients = recipientRows(tx, row.id);
          if (recipients.some((recipient) => recipient.sentAt !== null)) {
            continue;
          }
          // The child rows go first because they hold the foreign key, and the
          // parent delete's own guard is checked: a message the guard refuses
          // would otherwise outlive the recipients that were already removed.
          // Raising here rolls the whole generation back rather than leaving
          // that orphan behind.
          tx.delete(outboxRecipients)
            .where(
              and(
                eq(outboxRecipients.messageId, row.id),
                isNull(outboxRecipients.sentAt),
              ),
            )
            .run();
          const removed = tx
            .delete(outboxMessages)
            .where(
              and(eq(outboxMessages.id, row.id), isNull(outboxMessages.sentAt)),
            )
            .run();
          if (removed.changes !== 1) {
            conflict("outbox_message", row.id, ["sentAt"]);
          }
        }

        purgeIn(tx, input.seasonId);
        return {
          wave: waveRow(tx, wave.id),
          messages: messageViews(tx, wave.id),
        };
      },
      { behavior: "immediate" },
    );
  }

  function createAdHocWave(input: AdHocWaveInput): GeneratedWave {
    return db.transaction(
      (tx) => {
        settle(tx, input.seasonId);
        const source = loadSource(tx, input.seasonId);
        const stamp = now();
        const wave = ensureWave(
          tx,
          {
            seasonId: input.seasonId,
            kind: "ad_hoc",
            label: input.label,
            recipientRule: "manual",
            subjectTemplate: input.subject,
            bodyTemplate: input.text,
          },
          stamp,
        );
        const html = textToHtml(input.text);
        const stored = createHash("sha256")
          .update(JSON.stringify(["ad_hoc", input.subject, input.text]))
          .digest("hex");

        for (const contactId of input.recipientContactIds) {
          const contact = canonicalContact(source, contactId);
          if (contact === null) {
            throw new OutboxLifecycleError(
              `contact ${contactId} does not exist in season ${input.seasonId}`,
            );
          }
          const existing = tx
            .select()
            .from(outboxMessages)
            .where(
              and(
                eq(outboxMessages.waveId, wave.id),
                eq(outboxMessages.recordType, "contact"),
                eq(outboxMessages.recordId, contact.id),
              ),
            )
            .get();
          const messageId =
            existing?.id ??
            tx
              .insert(outboxMessages)
              .values({
                seasonId: input.seasonId,
                waveId: wave.id,
                recordType: "contact",
                recordId: contact.id,
                state: "generated",
                subject: input.subject,
                textBody: input.text,
                htmlBody: html,
                sourceFingerprint: stored,
                createdAt: stamp,
                updatedAt: stamp,
              })
              .returning({ id: outboxMessages.id })
              .get().id;
          const message = messageRow(tx, messageId);
          if (message.sentAt === null) {
            syncRecipients(tx, message, [contact], stamp);
          }
        }

        purgeIn(tx, input.seasonId);
        return {
          wave: waveRow(tx, wave.id),
          messages: messageViews(tx, wave.id),
        };
      },
      { behavior: "immediate" },
    );
  }

  function editMessage(
    messageId: number,
    expectedVersion: number,
    changes: EditMessageInput,
  ): OutboxMessageView {
    return db.transaction(
      (tx) => {
        const seasonId = messageRow(tx, messageId).seasonId;
        settle(tx, seasonId);
        const message = messageRow(tx, messageId);
        if (message.state === "sent" || message.sentAt !== null) {
          throw new OutboxLifecycleError(
            `outbox message ${messageId} was sent on ${message.sentAt?.toISOString() ?? "an earlier date"} and is immutable`,
          );
        }
        const state: OutboxMessageState =
          message.state === "generated_stale" ||
          message.state === "edited_stale"
            ? "edited_stale"
            : "edited";
        const result = tx
          .update(outboxMessages)
          .set({
            state,
            subject: changes.subject ?? message.subject,
            textBody: changes.text,
            htmlBody: textToHtml(changes.text),
            version: sql`${outboxMessages.version} + 1`,
            updatedAt: now(),
          })
          .where(
            and(
              eq(outboxMessages.id, messageId),
              eq(outboxMessages.version, expectedVersion),
              isNull(outboxMessages.sentAt),
            ),
          )
          .run();
        if (result.changes !== 1) {
          conflict("outbox_message", messageId, ["subject", "text"]);
        }
        return {
          ...messageRow(tx, messageId),
          recipients: recipientRows(tx, messageId),
        };
      },
      { behavior: "immediate" },
    );
  }

  // --- sending ------------------------------------------------------------

  interface SendPlanItem {
    readonly message: OutboxMessage;
    readonly recipients: readonly OutboxRecipient[];
  }

  async function sendSelection(input: SendSelectionInput): Promise<SendReport> {
    // R12/AE1: with no provider the outbox is copy-paste only, and says so
    // rather than pretending a send happened.
    if (!ports.email.configured) {
      throw new OutboxLifecycleError(
        `no email provider is configured (${ports.email.name}); export this wave instead of sending it`,
      );
    }

    const plan = db.transaction(
      (tx) => {
        const wave = waveRow(tx, input.waveId);
        settle(tx, wave.seasonId);
        const items: SendPlanItem[] = [];
        for (const messageId of input.messageIds) {
          const message = messageRow(tx, messageId);
          if (message.waveId !== wave.id) {
            throw new OutboxLifecycleError(
              `outbox message ${messageId} does not belong to wave ${wave.id}`,
            );
          }
          // KTD7: sending is a mutation of the message, so the organizer must
          // name the version they reviewed. An absent entry used to mean "no
          // check at all", which let a selection built from a stale screen
          // transmit bytes nobody approved.
          const expected = input.expectedVersions[messageId];
          if (expected === undefined) {
            throw new OutboxLifecycleError(
              `outbox message ${messageId} was selected without the version it was reviewed at`,
            );
          }
          if (expected !== message.version) {
            conflict("outbox_message", messageId, ["send"]);
          }
          if (message.sentAt !== null) continue;
          if (message.textBody === null || message.htmlBody === null) {
            throw new OutboxLifecycleError(
              `outbox message ${messageId} has no stored body; regenerate it before sending`,
            );
          }
          items.push({
            message,
            recipients: recipientRows(tx, messageId).filter(
              (row) => row.sentAt === null,
            ),
          });
        }
        return { wave, items };
      },
      { behavior: "immediate" },
    );

    const outcomes: SendRecipientOutcome[] = [];
    const completed: number[] = [];
    for (const item of plan.items) {
      // Deterministic order: message by message, recipient by recipient, one
      // delivery per address (KTD6) so a per-recipient stamp is always exact.
      for (const recipient of item.recipients) {
        let result: EmailDeliveryResult;
        try {
          result = await ports.email.deliver({
            recipients: [recipient.address],
            subject: item.message.subject,
            html: item.message.htmlBody!,
            text: item.message.textBody!,
          });
        } catch (error) {
          result = {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          };
        }

        const recorded = db.transaction(
          (tx) => {
            const stamp = now();
            if (result.status === "sent") {
              const stamped = tx
                .update(outboxRecipients)
                .set({
                  sentAt: stamp,
                  outcome: "sent",
                  providerMessageId: result.providerMessageId ?? null,
                  reason: null,
                  version: sql`${outboxRecipients.version} + 1`,
                  updatedAt: stamp,
                })
                .where(
                  and(
                    eq(outboxRecipients.id, recipient.id),
                    eq(outboxRecipients.version, recipient.version),
                    isNull(outboxRecipients.sentAt),
                  ),
                )
                .run();
              if (stamped.changes !== 1) {
                conflict("outbox_recipient", recipient.id, ["sentAt"]);
              }
              // R13: the per-recipient history entry is written in the same
              // transaction as the stamp, so the two can never disagree.
              tx.insert(emailLog)
                .values({
                  seasonId: item.message.seasonId,
                  recordType: item.message.recordType,
                  recordId: item.message.recordId,
                  waveLabel: plan.wave.label,
                  recipientContactId: recipient.contactId,
                  sentAt: stamp,
                  address: recipient.address,
                  outcome: "sent",
                  messageId: item.message.id,
                })
                .run();
              return true;
            }
            const noted = tx
              .update(outboxRecipients)
              .set({
                outcome: result.status,
                reason: result.reason ?? null,
                version: sql`${outboxRecipients.version} + 1`,
                updatedAt: stamp,
              })
              .where(
                and(
                  eq(outboxRecipients.id, recipient.id),
                  eq(outboxRecipients.version, recipient.version),
                  isNull(outboxRecipients.sentAt),
                ),
              )
              .run();
            // The row moved on under us - stamped or corrected elsewhere. The
            // outcome is real and belongs in the report, but claiming it was
            // written down when it was not is how a skipped person disappears.
            return noted.changes === 1;
          },
          { behavior: "immediate" },
        );

        outcomes.push({
          messageId: item.message.id,
          recipientId: recipient.id,
          contactId: recipient.contactId,
          address: recipient.address,
          status: result.status,
          reason: result.reason ?? null,
          providerMessageId: result.providerMessageId ?? null,
          recorded,
        });
      }

      const finished = db.transaction(
        (tx) => {
          const message = messageRow(tx, item.message.id);
          if (message.sentAt !== null) return false;
          const rows = recipientRows(tx, message.id);
          if (rows.length === 0) return false;
          if (rows.some((row) => row.sentAt === null)) return false;
          const stamp = now();
          const result = tx
            .update(outboxMessages)
            .set({
              state: "sent",
              sentAt: stamp,
              // AE9 needs to know where a message came from if a corrected
              // address later pulls it back out of `sent`.
              preSendState: message.state,
              version: sql`${outboxMessages.version} + 1`,
              updatedAt: stamp,
            })
            .where(
              and(
                eq(outboxMessages.id, message.id),
                // KTD5: the version the transmitted bytes came from, not the
                // one just read - an edit that landed mid-send would otherwise
                // be frozen as `sent` around text nobody received.
                eq(outboxMessages.version, item.message.version),
                isNull(outboxMessages.sentAt),
              ),
            )
            .run();
          return result.changes === 1;
        },
        { behavior: "immediate" },
      );
      if (finished) completed.push(item.message.id);
    }

    db.transaction((tx) => purgeIn(tx, plan.wave.seasonId), {
      behavior: "immediate",
    });

    return {
      waveId: plan.wave.id,
      attempted: outcomes.length,
      sent: outcomes.filter((row) => row.status === "sent").length,
      skipped: outcomes.filter((row) => row.status === "skipped").length,
      failed: outcomes.filter((row) => row.status === "failed").length,
      completedMessageIds: completed,
      recipients: outcomes,
    };
  }

  function exportSelection(input: {
    readonly waveId: number;
    readonly messageIds: readonly number[];
  }): ExportedMessage[] {
    return db.transaction(
      (tx) => {
        const wave = waveRow(tx, input.waveId);
        settle(tx, wave.seasonId);
        const season = loadSource(tx, wave.seasonId).season;
        const stamp = now();
        return input.messageIds.map((messageId) => {
          const message = messageRow(tx, messageId);
          if (message.waveId !== wave.id) {
            throw new OutboxLifecycleError(
              `outbox message ${messageId} does not belong to wave ${wave.id}`,
            );
          }
          if (message.textBody === null || message.htmlBody === null) {
            throw new OutboxLifecycleError(
              `outbox message ${messageId} has no stored body; its wave was completed and purged`,
            );
          }
          const to = recipientRows(tx, messageId).map((row) => row.address);
          return {
            messageId,
            subject: message.subject,
            text: message.textBody,
            eml: renderEml({
              from: season.senderEmail ?? "",
              to,
              subject: message.subject,
              text: message.textBody,
              html: message.htmlBody,
              date: stamp,
              messageId: `outbox-${message.id}.wave-${wave.id}@porchfest.invalid`,
            }),
          };
        });
      },
      { behavior: "immediate" },
    );
  }

  function onContactAddressChanged(
    contactId: number,
    previousAddress: string | null,
    newAddress: string | null,
  ): void {
    db.transaction(
      (tx) =>
        applyContactAddressChange(
          tx,
          { contactId, previousAddress, newAddress },
          now,
        ),
      { behavior: "immediate" },
    );
  }

  function purgeCompletedWaves(seasonId: number): void {
    db.transaction((tx) => purgeIn(tx, seasonId), { behavior: "immediate" });
  }

  function refreshStaleness(seasonId: number): void {
    db.transaction((tx) => refreshIn(tx, seasonId), { behavior: "immediate" });
  }

  function listWaves(seasonId: number): OutboxWave[] {
    return db.transaction(
      (tx) => {
        settle(tx, seasonId);
        return tx
          .select()
          .from(outboxWaves)
          .where(eq(outboxWaves.seasonId, seasonId))
          .orderBy(asc(outboxWaves.id))
          .all();
      },
      { behavior: "immediate" },
    );
  }

  function listMessages(waveId: number): OutboxMessageView[] {
    return db.transaction(
      (tx) => {
        const wave = waveRow(tx, waveId);
        settle(tx, wave.seasonId);
        return messageViews(tx, waveId);
      },
      { behavior: "immediate" },
    );
  }

  function getMessage(messageId: number): OutboxMessageView {
    return db.transaction(
      (tx) => {
        settle(tx, messageRow(tx, messageId).seasonId);
        return {
          ...messageRow(tx, messageId),
          recipients: recipientRows(tx, messageId),
        };
      },
      { behavior: "immediate" },
    );
  }

  function listSendHistory(seasonId: number): EmailLogEntry[] {
    return db
      .select()
      .from(emailLog)
      .where(eq(emailLog.seasonId, seasonId))
      .orderBy(asc(emailLog.id))
      .all();
  }

  return Object.freeze({
    generateWave,
    createAdHocWave,
    editMessage,
    sendSelection,
    exportSelection,
    onContactAddressChanged,
    purgeCompletedWaves,
    refreshStaleness,
    listWaves,
    listMessages,
    getMessage,
    listSendHistory,
  });
}

export type OutboxRepository = ReturnType<typeof createOutboxRepository>;

/**
 * KTD6/AE9. Correcting a contact's address is the one participant edit that
 * must reach back into send state: the person at the new address has not been
 * written to, so their send state is cleared and the message they belong to
 * leaves `sent`. The `email_log` row naming the old address is history and is
 * never touched, and `previous_address` keeps the correction visible to a sweep
 * so nobody is silently skipped.
 *
 * Exported as a plain function because `season.ts` calls it inside the same
 * transaction as the contact update.
 */
export function applyContactAddressChange(
  executor: CoreExecutor,
  change: ContactAddressChange,
  now: () => Date = () => new Date(),
): void {
  const address = (change.newAddress ?? "").trim();
  if ((change.previousAddress ?? "").trim() === address) return;

  for (const row of executor
    .select()
    .from(outboxRecipients)
    .where(eq(outboxRecipients.contactId, change.contactId))
    .orderBy(asc(outboxRecipients.id))
    .all()) {
    if (row.address === address) continue;
    const stamp = now();
    executor
      .update(outboxRecipients)
      .set({
        address,
        previousAddress: row.address,
        sentAt: null,
        outcome: null,
        providerMessageId: null,
        reason: null,
        version: sql`${outboxRecipients.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(outboxRecipients.id, row.id),
          eq(outboxRecipients.version, row.version),
        ),
      )
      .run();

    const message = executor
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.id, row.messageId))
      .get();
    if (!message || message.sentAt === null) continue;
    // A purged body cannot be re-sent as it was, so the message goes back as
    // stale: regeneration is what makes it sendable again.
    const restored: OutboxMessageState =
      message.textBody === null
        ? "generated_stale"
        : message.preSendState === null || message.preSendState === "sent"
          ? "generated"
          : message.preSendState;
    executor
      .update(outboxMessages)
      .set({
        state: restored,
        sentAt: null,
        preSendState: null,
        version: sql`${outboxMessages.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(outboxMessages.id, message.id),
          eq(outboxMessages.version, message.version),
        ),
      )
      .run();
  }
}
