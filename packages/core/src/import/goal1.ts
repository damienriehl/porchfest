import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnnotationRepository } from "../annotations.js";
import type { GeocodingRepository } from "../geocoding.js";
import { normalizeVenueAddress } from "../geocoding.js";
import type {
  BindImportKeyInput,
  ImportKeyRepository,
} from "../import-keys.js";
import type { BoundingBox } from "../ports/geo.js";
import type {
  HostSignupInput,
  PerformerSignupInput,
  SignupContactInput,
} from "../records.js";
import type { createSeasonRepository } from "../season.js";
import type { SeasonSetupRepository } from "../setup.js";
import { endOfDateInTimeZone, parseWallClock } from "../time.js";
import type {
  Act,
  Contact,
  CoordinatePrecision,
  CoordinateRejectionCode,
  CoordinateStatus,
  ImportRecordType,
  ImportKey,
  Season,
  SeasonTimeSlot,
  Venue,
  VenueAmenity,
  VenueDrink,
  VenueGear,
} from "../storage/schema.js";

const SOURCE = {
  season: "goal1:season",
  hostVenue: "goal1:host-venue",
  hostContact: "goal1:host-contact",
  performerAct: "goal1:performer-act",
  performerContact: "goal1:performer-contact",
  virtualAct: "goal1:virtual-performer",
  virtualVenue: "goal1:virtual-venue",
  manualContact: "goal1:manual-contact",
  slot: "goal1:slot",
  assignment: "goal1:assignment",
  hold: "goal1:hold",
  coordinate: "goal1:coordinate",
  annotation: "goal1:annotation",
  override: "goal1:performer-override",
} as const;

const GOAL1_SLOT_DEFINITIONS = Object.freeze([
  { artifactLabel: "6-7", startsAt: "18:00", endsAt: "19:00" },
  { artifactLabel: "7-8", startsAt: "19:00", endsAt: "20:00" },
]);

export interface Goal1ArtifactFileMap {
  readonly submissions: string;
  readonly slate: string;
  readonly geocache: string;
}

export const goal1ArtifactFiles: Goal1ArtifactFileMap = Object.freeze({
  submissions: "out/submissions.json",
  slate: "private/matches-2026.json",
  geocache: "private/geocache.json",
});

type SeasonRepository = ReturnType<typeof createSeasonRepository>;

export interface Goal1ImportCore {
  readonly transaction: <T>(work: () => T) => T;
  readonly setup: SeasonSetupRepository;
  readonly seasons: SeasonRepository;
  readonly geocoding: GeocodingRepository;
  readonly annotations: AnnotationRepository;
  readonly importKeys: ImportKeyRepository;
}

export interface Goal1ImportOptions {
  readonly artifactsDirectory: string;
  readonly artifactFiles?: Goal1ArtifactFileMap;
  readonly localityName: string;
  readonly bounds: BoundingBox;
  readonly eventYear?: number;
  readonly timezone?: string;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
}

export interface ImportCounts {
  created: number;
  found: number;
  skipped: number;
}

export interface ImportSupersession {
  readonly recordType: "venue" | "act";
  readonly sourceNaturalKey: string;
  readonly canonicalNaturalKey: string;
  readonly sourceId: number;
  readonly canonicalId: number;
  readonly status: "created" | "found";
}

export interface ImportHold {
  readonly venueNaturalKey: string;
  readonly slot: string;
  readonly slotId: number;
  readonly heldForName: string;
  readonly decideBy: string;
  readonly fallbackVenueId: number | null;
  readonly status: "created" | "found";
}

export interface ImportGeocacheHit {
  readonly address: string;
  readonly venueId: number;
  readonly coordinateId: number;
  readonly status: "created" | "found" | "preserved";
  readonly reviewStatus: CoordinateStatus;
  readonly rejectionCode: CoordinateRejectionCode | null;
}

export type ImportPlaceholderReachVia =
  "slot" | "chase" | "timestamp" | "manual_contact";

export interface ImportPlaceholderAct {
  readonly virtualPerformerKey: string;
  readonly actId: number;
  readonly reachVia: ImportPlaceholderReachVia;
  readonly status: "created" | "found";
}

export interface ImportReport {
  readonly seasonId: number;
  readonly records: Readonly<Record<ImportRecordType, ImportCounts>>;
  readonly supersessions: readonly ImportSupersession[];
  readonly holds: readonly ImportHold[];
  readonly placeholderActs: readonly ImportPlaceholderAct[];
  readonly geocache: {
    readonly hits: readonly ImportGeocacheHit[];
    readonly misses: readonly string[];
  };
  readonly annotationCount: number;
  readonly summary: {
    readonly slateVenues: number;
    readonly approvedActEntries: number;
    readonly placeholderActs: number;
    readonly placeholderVenues: number;
    readonly unmatchedVenues: number;
    readonly floatingPerformers: number;
  };
  readonly warnings: readonly string[];
}

type JsonObject = Record<string, unknown>;

interface Goal1Artifacts {
  readonly hosts: readonly JsonObject[];
  readonly performers: readonly JsonObject[];
  readonly matches: JsonObject;
  readonly geocache: JsonObject;
}

interface ImportState {
  readonly core: Goal1ImportCore;
  readonly report: MutableImportReport;
  readonly season: Season;
  readonly timeSlots: readonly SeasonTimeSlot[];
  readonly hostRows: ReadonlyMap<string, JsonObject>;
  readonly performerRows: ReadonlyMap<string, JsonObject>;
  readonly hostVenues: Map<string, Venue>;
  readonly hostContacts: Map<string, Contact>;
  readonly performerActs: Map<string, Act>;
  readonly performerContacts: Map<string, Contact>;
  readonly virtualActs: Map<string, Act>;
  readonly virtualVenues: Map<string, Venue>;
  readonly manualContacts: Map<string, Contact>;
  readonly venueNaturalKeys: Map<number, string>;
  readonly matchedVenueIds: Map<string, number>;
  readonly importKeys: Map<string, ImportKey>;
  readonly reportedAnnotationKeys: Set<string>;
}

interface MutableImportReport {
  seasonId: number;
  records: Record<ImportRecordType, ImportCounts>;
  supersessions: ImportSupersession[];
  holds: ImportHold[];
  placeholderActs: ImportPlaceholderAct[];
  geocache: { hits: ImportGeocacheHit[]; misses: string[] };
  summary: ImportReport["summary"];
  warnings: string[];
}

export function importGoal1Season(
  core: Goal1ImportCore,
  options: Goal1ImportOptions,
): ImportReport {
  try {
    return core.transaction(() => {
      const report = importGoal1SeasonInTransaction(core, options);
      if (options.dryRun) throw new Goal1DryRunRollback(report);
      return report;
    });
  } catch (error) {
    if (error instanceof Goal1DryRunRollback) return error.report;
    throw error;
  }
}

class Goal1DryRunRollback extends Error {
  override readonly name = "Goal1DryRunRollback";

  constructor(readonly report: ImportReport) {
    super("Roll back Goal-1 dry run.");
  }
}

function importGoal1SeasonInTransaction(
  core: Goal1ImportCore,
  options: Goal1ImportOptions,
): ImportReport {
  const artifacts = readArtifacts(
    options.artifactsDirectory,
    options.artifactFiles ?? goal1ArtifactFiles,
  );
  const event = object(artifacts.matches.event, "matches event");
  const timezone = options.timezone ?? "America/Chicago";
  const eventDate = eventDateValue(event, options.eventYear);
  const seasonNaturalKey = `${eventDate}:${requiredString(event.name, "event name")}`;
  const report = emptyReport();
  const seasonKey = core.importKeys.findSeason(SOURCE.season, seasonNaturalKey);
  let season: Season;
  if (seasonKey === null) {
    season = core.setup.createSeason({
      year: Number(eventDate.slice(0, 4)),
      displayName: requiredString(event.name, "event name"),
      timezone,
      eventDate,
      eventCity: optionalString(event.city) ?? "Unconfigured",
      eventState: optionalString(event.state) ?? "Unconfigured",
      timeSlots: GOAL1_SLOT_DEFINITIONS,
      localityName: options.localityName,
      bounds: options.bounds,
      publicSiteUrl: optionalString(event.website),
      publicMapUrl: optionalString(event.map_url),
      senderName: optionalString(event.organizer_name),
      openSignups: true,
    }).season;
    core.importKeys.bind({
      seasonId: season.id,
      source: SOURCE.season,
      naturalKey: seasonNaturalKey,
      recordType: "season",
      recordId: season.id,
    });
    increment(report, "season", "created");
  } else {
    season = core.seasons.getSeason(seasonKey.recordId);
    increment(report, "season", "found");
  }
  report.seasonId = season.id;
  const timeSlots = core.setup.listTimeSlots(season.id);
  if (timeSlots.length !== GOAL1_SLOT_DEFINITIONS.length) {
    throw new Error(
      `Goal-1 season requires ${GOAL1_SLOT_DEFINITIONS.length} time slots; found ${timeSlots.length}.`,
    );
  }

  const hostRows = keyedRows(artifacts.hosts, "host");
  const performerRows = keyedRows(artifacts.performers, "performer");
  const state: ImportState = {
    core,
    report,
    season,
    timeSlots,
    hostRows,
    performerRows,
    hostVenues: new Map(),
    hostContacts: new Map(),
    performerActs: new Map(),
    performerContacts: new Map(),
    virtualActs: new Map(),
    virtualVenues: new Map(),
    manualContacts: new Map(),
    venueNaturalKeys: new Map(),
    matchedVenueIds: new Map(),
    importKeys: new Map(
      core.importKeys
        .list(season.id)
        .map((key) => [importKeyCacheKey(key.source, key.naturalKey), key]),
    ),
    reportedAnnotationKeys: new Set(),
  };

  importHosts(state, artifacts.matches);
  importPerformers(state);
  applyPerformerOverrides(state, artifacts.matches);
  importManualContacts(state, artifacts.matches);
  importVirtualActs(state, artifacts.matches);
  importVirtualVenues(state, artifacts.matches);
  applySupersessions(state, artifacts.matches);
  bindVenueSlots(state);
  importVenueSlate(state, artifacts.matches);
  annotateUnmatchedAndFloating(state, artifacts.matches);
  importCoordinates(state, artifacts.geocache);
  const approvedActs = new Set(
    core.seasons
      .listAssignments(season.id)
      .map(
        (assignment) => core.seasons.resolveAct(assignment.actId).canonical.id,
      ),
  );
  report.summary = {
    slateVenues: new Set(state.matchedVenueIds.values()).size,
    approvedActEntries: approvedActs.size + report.holds.length,
    placeholderActs: report.placeholderActs.length,
    placeholderVenues: state.virtualVenues.size,
    unmatchedVenues: array(artifacts.matches.unmatched_venues).length,
    floatingPerformers: array(artifacts.matches.floating_performers).length,
  };

  return freezeReport(report);
}

function importHosts(state: ImportState, matches: JsonObject): void {
  const matchVenues = array(matches.venues);
  const titleByHost = new Map<string, string>();
  for (const value of matchVenues) {
    const entry = object(value, "venue entry");
    const hostKey = optionalString(entry.host_ts);
    const override = optionalString(entry.host_name_override);
    if (hostKey && override) titleByHost.set(hostKey, override);
  }

  for (const [naturalKey, row] of state.hostRows) {
    const venueKey = findImportKey(state, SOURCE.hostVenue, naturalKey);
    const contactKey = findImportKey(state, SOURCE.hostContact, naturalKey);
    if (venueKey !== null) {
      const venue = state.core.seasons.getVenue(venueKey.recordId);
      const contactId =
        contactKey?.recordId ?? venue.hostContactId ?? venue.reachViaContactId;
      if (contactId === null) {
        throw new Error(`Imported host ${naturalKey} has no contact.`);
      }
      const contact = state.core.seasons.getContact(contactId);
      if (contactKey === null) {
        bindImportKey(state, {
          source: SOURCE.hostContact,
          naturalKey,
          recordType: "contact",
          recordId: contact.id,
        });
      }
      state.hostVenues.set(naturalKey, venue);
      state.hostContacts.set(naturalKey, contact);
      state.venueNaturalKeys.set(venue.id, `host:${naturalKey}`);
      increment(state.report, "venue", "found");
      increment(state.report, "contact", "found");
      continue;
    }

    const mapped = mapHost(row);
    const signup = state.core.seasons.createHostSignup({
      seasonId: state.season.id,
      contact: mapped.contact,
      venue: {
        ...mapped.venue,
        title:
          titleByHost.get(naturalKey) ??
          `${mapped.contact.name.trim() || "Imported host"} venue`,
      },
      gear: mapped.gear,
      drinks: mapped.drinks,
      amenities: mapped.amenities,
    });
    bindImportKey(state, {
      source: SOURCE.hostVenue,
      naturalKey,
      recordType: "venue",
      recordId: signup.venue.id,
    });
    bindImportKey(state, {
      source: SOURCE.hostContact,
      naturalKey,
      recordType: "contact",
      recordId: signup.contact.id,
    });
    state.hostVenues.set(naturalKey, signup.venue);
    state.hostContacts.set(naturalKey, signup.contact);
    state.venueNaturalKeys.set(signup.venue.id, `host:${naturalKey}`);
    increment(state.report, "venue", "created");
    increment(state.report, "contact", "created");
  }
}

function importPerformers(state: ImportState): void {
  for (const [naturalKey, row] of state.performerRows) {
    const actKey = findImportKey(state, SOURCE.performerAct, naturalKey);
    const contactKey = findImportKey(
      state,
      SOURCE.performerContact,
      naturalKey,
    );
    if (actKey !== null) {
      const act = state.core.seasons.getAct(actKey.recordId);
      const contactId = contactKey?.recordId ?? act.reachViaContactId;
      if (contactId === null) {
        throw new Error(`Imported performer ${naturalKey} has no contact.`);
      }
      const contact = state.core.seasons.getContact(contactId);
      if (contactKey === null) {
        bindImportKey(state, {
          source: SOURCE.performerContact,
          naturalKey,
          recordType: "contact",
          recordId: contact.id,
        });
      }
      state.performerActs.set(naturalKey, act);
      state.performerContacts.set(naturalKey, contact);
      increment(state.report, "act", "found");
      increment(state.report, "contact", "found");
      continue;
    }

    const mapped = mapPerformer(row, state.timeSlots);
    const signup = state.core.seasons.createPerformerSignup({
      seasonId: state.season.id,
      ...mapped,
    });
    bindImportKey(state, {
      source: SOURCE.performerAct,
      naturalKey,
      recordType: "act",
      recordId: signup.act.id,
    });
    bindImportKey(state, {
      source: SOURCE.performerContact,
      naturalKey,
      recordType: "contact",
      recordId: signup.contact.id,
    });
    state.performerActs.set(naturalKey, signup.act);
    state.performerContacts.set(naturalKey, signup.contact);
    increment(state.report, "act", "created");
    increment(state.report, "contact", "created");
  }
}

function applyPerformerOverrides(
  state: ImportState,
  matches: JsonObject,
): void {
  for (const [naturalKey, rawOverride] of entries(
    matches.performer_overrides,
  )) {
    const act = state.performerActs.get(naturalKey);
    const contact = state.performerContacts.get(naturalKey);
    if (!act || !contact) {
      state.report.warnings.push(
        `Performer override target did not resolve: ${naturalKey}`,
      );
      continue;
    }
    const existing = findImportKey(state, SOURCE.override, naturalKey);
    const override = object(rawOverride, `performer override ${naturalKey}`);
    const overrideDate = requiredIsoDate(
      override.on,
      `Performer override ${naturalKey} on`,
    );
    const fields = object(
      override.fields,
      `performer override fields ${naturalKey}`,
    );
    const effectiveRow = { ...state.performerRows.get(naturalKey)! };
    for (const [field, rawChange] of Object.entries(fields)) {
      if (field === "timestamp" || field === "ts" || field === "_row") {
        throw new Error(
          `Performer override ${naturalKey} cannot change ${field}.`,
        );
      }
      const change = object(rawChange, `override field ${field}`);
      const changeKeys = Object.keys(change).sort();
      if (changeKeys.join(",") !== "original,value") {
        throw new Error(
          `Performer override ${naturalKey} field ${field} must contain exactly original and value.`,
        );
      }
      if (!(field in effectiveRow)) {
        throw new Error(
          `Performer override ${naturalKey} targets unsupported field ${field}.`,
        );
      }
      if (change.original !== effectiveRow[field]) {
        throw new Error(
          `Performer override ${naturalKey} field ${field} no longer matches its recorded original.`,
        );
      }
      if (typeof change.value !== "string") {
        throw new Error(
          `Performer override ${naturalKey} field ${field} value must be a string.`,
        );
      }
      effectiveRow[field] = change.value;
      if (!isMappedOverrideField(field)) {
        state.report.warnings.push(
          `Performer override ${naturalKey} field ${field} has no importer mapping; the reason was retained as an annotation.`,
        );
      }
    }
    const annotationNote = `Override on ${overrideDate}: ${requiredString(override.reason, "override reason")}`;
    if (existing !== null) {
      addAnnotation(
        state,
        "act",
        act.id,
        `override:${naturalKey}`,
        annotationNote,
      );
      continue;
    }
    const actChanges: Record<string, unknown> = {};
    const contactChanges: Record<string, unknown> = {};
    for (const field of Object.keys(fields)) {
      mapOverrideField(field, effectiveRow, actChanges, contactChanges);
    }
    if (Object.keys(fields).some(isPerformerNoteSourceField)) {
      actChanges.notes = performerNotes(
        effectiveRow,
        extractLinksAndResidue(effectiveRow.listen, effectiveRow.websites)
          .residue,
      );
    }
    let updatedAct = act;
    let updatedContact = contact;
    if (Object.keys(actChanges).length > 0) {
      updatedAct = state.core.seasons.updateAct(
        act.id,
        act.version,
        actChanges,
      );
      state.performerActs.set(naturalKey, updatedAct);
    }
    if (Object.keys(contactChanges).length > 0) {
      updatedContact = state.core.seasons.updateContact(
        contact.id,
        contact.version,
        contactChanges,
      );
      state.performerContacts.set(naturalKey, updatedContact);
    }
    bindImportKey(state, {
      source: SOURCE.override,
      naturalKey,
      recordType: "act",
      recordId: updatedAct.id,
    });
    addAnnotation(
      state,
      "act",
      updatedAct.id,
      `override:${naturalKey}`,
      annotationNote,
    );
  }
}

function importManualContacts(state: ImportState, matches: JsonObject): void {
  for (const [manualKey, rawManual] of entries(matches.manual_contacts)) {
    const found = findImportKey(state, SOURCE.manualContact, manualKey);
    let contact: Contact;
    if (found !== null) {
      contact = state.core.seasons.getContact(found.recordId);
      increment(state.report, "contact", "found");
    } else {
      const manual = object(rawManual, `manual contact ${manualKey}`);
      contact = state.core.seasons.createManualContact({
        seasonId: state.season.id,
        contact: {
          name: requiredString(
            manual.display_name,
            "manual contact display_name",
          ),
          email: requiredString(manual.email, "manual contact email"),
          phone: optionalString(manual.phone),
        },
      });
      bindImportKey(state, {
        source: SOURCE.manualContact,
        naturalKey: manualKey,
        recordType: "contact",
        recordId: contact.id,
      });
      increment(state.report, "contact", "created");
    }
    state.manualContacts.set(manualKey, contact);
    const manual = object(rawManual, `manual contact ${manualKey}`);
    const source = optionalString(manual.source);
    if (source && /\b2025\b/i.test(source)) {
      addAnnotation(
        state,
        "contact",
        contact.id,
        `manual-contact-source:${manualKey}`,
        `Contact sourced from 2025 ${source.replace(/\b2025\b\s*/i, "").trim() || "source"}`,
      );
    }
  }
}

function importVirtualActs(state: ImportState, matches: JsonObject): void {
  const matchVenues = array(matches.venues).map((value) =>
    object(value, "venue entry"),
  );
  for (const [virtualKey, rawVirtual] of entries(matches.virtual_performers)) {
    const virtual = object(rawVirtual, `virtual performer ${virtualKey}`);
    const reachVia = requiredString(
      virtual.reach_via,
      "virtual performer reach_via",
    );
    const manualKey =
      reachVia === "manual_contact"
        ? requiredString(
            virtual.manual_contact,
            "virtual performer manual_contact",
          )
        : optionalString(virtual.manual_contact);
    const manual = manualKey ? state.manualContacts.get(manualKey) : null;
    let resolution: VirtualActReachResolution | null;
    if (reachVia === "manual_contact") {
      resolution = manual
        ? { contact: manual, reachVia: "manual_contact" }
        : null;
    } else {
      resolution = resolveVirtualActReach(
        state,
        virtualKey,
        reachVia,
        matchVenues,
        matches,
      );
      if (resolution === null) {
        state.report.warnings.push(
          `Virtual performer reach-via did not resolve: ${virtualKey}`,
        );
        resolution = manual
          ? { contact: manual, reachVia: "manual_contact" }
          : null;
      }
    }
    if (!resolution) {
      if (reachVia === "manual_contact") {
        state.report.warnings.push(
          `Virtual performer reach-via did not resolve: ${virtualKey}`,
        );
      }
      increment(state.report, "act", "skipped");
      continue;
    }
    const found = findImportKey(state, SOURCE.virtualAct, virtualKey);
    let act: Act;
    let status: ImportPlaceholderAct["status"];
    if (found !== null) {
      act = state.core.seasons.getAct(found.recordId);
      status = "found";
    } else {
      act = state.core.seasons.createPlaceholderAct({
        seasonId: state.season.id,
        reach: { reachViaContactId: resolution.contact.id },
        act: {
          name: requiredString(
            virtual.display_name,
            "virtual performer display_name",
          ),
          notes: null,
        },
      });
      bindImportKey(state, {
        source: SOURCE.virtualAct,
        naturalKey: virtualKey,
        recordType: "act",
        recordId: act.id,
      });
      status = "created";
    }
    state.virtualActs.set(virtualKey, act);
    increment(state.report, "act", status);
    state.report.placeholderActs.push({
      virtualPerformerKey: virtualKey,
      actId: act.id,
      reachVia: resolution.reachVia,
      status,
    });
    const note = optionalString(virtual.note);
    if (note)
      addAnnotation(state, "act", act.id, `virtual-act:${virtualKey}`, note);
  }
}

function importVirtualVenues(state: ImportState, matches: JsonObject): void {
  for (const [virtualKey, rawVirtual] of entries(matches.virtual_venues)) {
    const found = findImportKey(state, SOURCE.virtualVenue, virtualKey);
    let venue: Venue;
    if (found !== null) {
      venue = state.core.seasons.getVenue(found.recordId);
      increment(state.report, "venue", "found");
    } else {
      const virtual = object(rawVirtual, `virtual venue ${virtualKey}`);
      const performerKey = requiredString(
        virtual.reach_via_performer_ts,
        "virtual venue reach_via_performer_ts",
      );
      const contact = state.performerContacts.get(performerKey);
      if (!contact) {
        state.report.warnings.push(
          `Virtual venue reach-via did not resolve: ${virtualKey}`,
        );
        increment(state.report, "venue", "skipped");
        continue;
      }
      venue = state.core.seasons.createPlaceholderVenue({
        seasonId: state.season.id,
        reach: { reachViaContactId: contact.id },
        venue: {
          title: requiredString(
            virtual.host_display_name,
            "virtual venue host_display_name",
          ),
          address: optionalString(virtual.address_display),
          notes: null,
        },
      });
      bindImportKey(state, {
        source: SOURCE.virtualVenue,
        naturalKey: virtualKey,
        recordType: "venue",
        recordId: venue.id,
      });
      increment(state.report, "venue", "created");
    }
    state.virtualVenues.set(virtualKey, venue);
    state.venueNaturalKeys.set(venue.id, `virtual:${virtualKey}`);
    const virtual = object(rawVirtual, `virtual venue ${virtualKey}`);
    const note = optionalString(virtual.note);
    if (note)
      addAnnotation(
        state,
        "venue",
        venue.id,
        `virtual-venue:${virtualKey}`,
        note,
      );
    venue = applyVenueWithdrawal(state, venue, virtual.withdrawn);
    state.virtualVenues.set(virtualKey, venue);
  }
}

function applySupersessions(state: ImportState, matches: JsonObject): void {
  const superseded = objectOrEmpty(matches.superseded);
  applySupersessionGroup(state, "venue", objectOrEmpty(superseded.hosts));
  applySupersessionGroup(state, "act", objectOrEmpty(superseded.performers));
}

function applySupersessionGroup(
  state: ImportState,
  recordType: "venue" | "act",
  group: JsonObject,
): void {
  for (const [sourceKey, rawEntry] of Object.entries(group)) {
    const entry = object(rawEntry, `${recordType} supersession ${sourceKey}`);
    const canonicalKey = requiredString(
      entry.canonical,
      "canonical natural key",
    );
    const source =
      recordType === "venue"
        ? state.hostVenues.get(sourceKey)
        : state.performerActs.get(sourceKey);
    const canonical =
      recordType === "venue"
        ? state.hostVenues.get(canonicalKey)
        : state.performerActs.get(canonicalKey);
    const sourceContact =
      recordType === "venue"
        ? state.hostContacts.get(sourceKey)
        : state.performerContacts.get(sourceKey);
    const canonicalContact =
      recordType === "venue"
        ? state.hostContacts.get(canonicalKey)
        : state.performerContacts.get(canonicalKey);
    if (!source || !canonical || !sourceContact || !canonicalContact) {
      state.report.warnings.push(
        `${recordType} supersession did not resolve: ${sourceKey} -> ${canonicalKey}`,
      );
      continue;
    }
    const alreadySuperseded =
      recordType === "venue"
        ? state.core.seasons.resolveVenue(source.id).canonical.id ===
          canonical.id
        : state.core.seasons.resolveAct(source.id).canonical.id ===
          canonical.id;
    if (!alreadySuperseded) {
      if (recordType === "venue") {
        const supersededVenue = state.core.seasons.supersedeVenue(
          source.id,
          source.version,
          canonical.id,
        );
        state.hostVenues.set(sourceKey, supersededVenue);
      } else {
        const supersededAct = state.core.seasons.supersedeAct(
          source.id,
          source.version,
          canonical.id,
        );
        state.performerActs.set(sourceKey, supersededAct);
      }
    }
    const currentContact = state.core.seasons.getContact(sourceContact.id);
    if (
      state.core.seasons.resolveContact(currentContact.id).canonical.id !==
      canonicalContact.id
    ) {
      const supersededContact = state.core.seasons.supersedeContact(
        currentContact.id,
        currentContact.version,
        canonicalContact.id,
      );
      if (recordType === "venue") {
        state.hostContacts.set(sourceKey, supersededContact);
      } else {
        state.performerContacts.set(sourceKey, supersededContact);
      }
    }
    const status = alreadySuperseded ? "found" : "created";
    state.report.supersessions.push({
      recordType,
      sourceNaturalKey: sourceKey,
      canonicalNaturalKey: canonicalKey,
      sourceId: source.id,
      canonicalId: canonical.id,
      status,
    });
    const reason = optionalString(entry.reason);
    if (reason) {
      addAnnotation(
        state,
        recordType,
        source.id,
        `supersession:${recordType}:${sourceKey}`,
        `Superseded by ${canonicalKey}: ${reason}`,
      );
    }
  }
}

function bindVenueSlots(state: ImportState): void {
  for (const venue of [
    ...state.hostVenues.values(),
    ...state.virtualVenues.values(),
  ]) {
    const natural = state.venueNaturalKeys.get(venue.id);
    if (!natural) continue;
    const slots = state.core.seasons.ensureVenueSlots(venue.id);
    for (const [index, slot] of slots.entries()) {
      const slotLabel = GOAL1_SLOT_DEFINITIONS[index]?.artifactLabel;
      if (!slotLabel) continue;
      const naturalKey = `${natural}:${slotLabel}`;
      const found = findImportKey(state, SOURCE.slot, naturalKey);
      if (found === null) {
        bindImportKey(state, {
          source: SOURCE.slot,
          naturalKey,
          recordType: "slot",
          recordId: slot.id,
        });
        increment(state.report, "slot", "created");
      } else {
        increment(state.report, "slot", "found");
      }
    }
  }
}

function importVenueSlate(state: ImportState, matches: JsonObject): void {
  const virtualPerformers = objectOrEmpty(matches.virtual_performers);
  for (const rawVenue of array(matches.venues)) {
    const venueEntry = object(rawVenue, "venue entry");
    const entryId = requiredString(venueEntry.id, "venue id");
    const hostKey = optionalString(venueEntry.host_ts);
    const virtualKey = optionalString(venueEntry.virtual_venue);
    let venue = hostKey
      ? state.hostVenues.get(hostKey)
      : virtualKey
        ? state.virtualVenues.get(virtualKey)
        : undefined;
    if (!venue) {
      state.report.warnings.push(`Venue entry did not resolve: ${entryId}`);
      continue;
    }
    const mapAddress = optionalString(venueEntry.map_address);
    if (mapAddress) {
      const hostFormAddress = hostKey
        ? optionalString(state.hostRows.get(hostKey)?.address)
        : null;
      const privateAddressLine =
        hostFormAddress &&
        normalizeVenueAddress(hostFormAddress) !==
          normalizeVenueAddress(mapAddress)
          ? `[host-form address] ${hostFormAddress}`
          : null;
      const addressChanged =
        normalizeVenueAddress(venue.address) !==
        normalizeVenueAddress(mapAddress);
      const notesChanged =
        privateAddressLine !== null &&
        !venue.notes?.split("\n").includes(privateAddressLine);
      if (addressChanged || notesChanged) {
        venue = state.core.seasons.updateVenue(venue.id, venue.version, {
          ...(addressChanged ? { address: mapAddress } : {}),
          ...(notesChanged
            ? { notes: joinedNotes([venue.notes, privateAddressLine]) }
            : {}),
        });
      }
      if (privateAddressLine) {
        addAnnotation(
          state,
          "venue",
          venue.id,
          `${entryId}:host-form-address`,
          privateAddressLine,
        );
      }
      if (hostKey) state.hostVenues.set(hostKey, venue);
      if (virtualKey) state.virtualVenues.set(virtualKey, venue);
    }
    venue = applyVenueWithdrawal(state, venue, venueEntry.withdrawn);
    if (hostKey) state.hostVenues.set(hostKey, venue);
    if (virtualKey) state.virtualVenues.set(virtualKey, venue);
    state.matchedVenueIds.set(entryId, venue.id);
    annotateVenueEntry(state, venue, entryId, venueEntry);
  }

  for (const rawVenue of array(matches.venues)) {
    const venueEntry = object(rawVenue, "venue entry");
    const entryId = requiredString(venueEntry.id, "venue id");
    const venueId = state.matchedVenueIds.get(entryId);
    if (venueId === undefined) continue;
    const natural = state.venueNaturalKeys.get(venueId) ?? entryId;
    const slots = state.core.seasons.listVenueSlots(venueId);
    const configuredSlots = object(venueEntry.slots, `slots for ${entryId}`);
    for (const [index, definition] of GOAL1_SLOT_DEFINITIONS.entries()) {
      const slotLabel = definition.artifactLabel;
      const slot = slots[index];
      if (!slot) {
        state.report.warnings.push(
          `Venue ${entryId} has no ${slotLabel} slot.`,
        );
        continue;
      }
      const configuration = object(
        configuredSlots[slotLabel],
        `${entryId} ${slotLabel} slot`,
      );
      annotateSlotProse(state, venueId, entryId, slotLabel, configuration);
      const assignmentNaturalKey = `${natural}:${slotLabel}`;
      if (configuration.open === true) {
        increment(state.report, "assignment", "skipped");
        continue;
      }
      if ("same_as" in configuration) {
        const sameAs = requiredString(
          configuration.same_as,
          `${entryId} ${slotLabel} same_as`,
        );
        addAnnotation(
          state,
          "venue",
          venueId,
          `${entryId}:${slotLabel}:same-as`,
          `Slot ${slotLabel}: same assignment as ${sameAs}`,
        );
        continue;
      }
      const heldVirtualKey = optionalString(
        configuration.held_for_virtual_performer,
      );
      if (heldVirtualKey) {
        const existingHold = findImportKey(
          state,
          SOURCE.hold,
          assignmentNaturalKey,
        );
        const virtual = object(
          virtualPerformers[heldVirtualKey],
          `held virtual performer ${heldVirtualKey}`,
        );
        const heldForName = requiredString(
          virtual.display_name,
          "held virtual performer display_name",
        );
        const decideByText =
          optionalString(configuration.decide_by) ??
          optionalString(configuration.decideBy) ??
          optionalString(venueEntry.decide_by);
        if (!decideByText) {
          state.report.warnings.push(
            `Held slot has no decide-by date: ${entryId} ${slotLabel}`,
          );
          increment(state.report, "assignment", "skipped");
          continue;
        }
        const decideBy = endOfDateInTimeZone(
          decideByText,
          state.season.timezone,
        );
        if (decideBy === null) {
          state.report.warnings.push(
            `Held slot has an invalid decide-by date: ${entryId} ${slotLabel}`,
          );
          increment(state.report, "assignment", "skipped");
          continue;
        }
        const fallbackKey =
          optionalString(configuration.id_for_fallback) ??
          optionalString(venueEntry.id_for_fallback);
        const fallbackVenueId = fallbackKey
          ? (state.matchedVenueIds.get(fallbackKey) ?? null)
          : null;
        if (fallbackKey && fallbackVenueId === null) {
          state.report.warnings.push(
            `Held slot fallback did not resolve: ${fallbackKey}`,
          );
          increment(state.report, "assignment", "skipped");
          continue;
        }
        let heldSlot = slot;
        let status: "created" | "found" = "found";
        if (existingHold === null) {
          heldSlot = state.core.seasons.holdSlot(slot.id, slot.version, {
            heldForName,
            decideBy,
            fallbackVenueId,
          });
          bindImportKey(state, {
            source: SOURCE.hold,
            naturalKey: assignmentNaturalKey,
            recordType: "slot",
            recordId: slot.id,
          });
          status = "created";
        }
        state.report.holds.push({
          venueNaturalKey: natural,
          slot: slotLabel,
          slotId: heldSlot.id,
          heldForName,
          decideBy: decideByText,
          fallbackVenueId,
          status,
        });
        continue;
      }

      const existingAssignment = findImportKey(
        state,
        SOURCE.assignment,
        assignmentNaturalKey,
      );
      if (existingAssignment !== null) {
        increment(state.report, "assignment", "found");
        continue;
      }
      const performerKey = optionalString(configuration.performer_ts);
      const assignedVirtualKey = optionalString(
        configuration.virtual_performer,
      );
      const act = performerKey
        ? state.performerActs.get(performerKey)
        : assignedVirtualKey
          ? state.virtualActs.get(assignedVirtualKey)
          : undefined;
      if (!act) {
        state.report.warnings.push(
          `Slot assignment did not resolve: ${entryId} ${slotLabel}`,
        );
        increment(state.report, "assignment", "skipped");
        continue;
      }
      const assignment = state.core.seasons.assignSlot(
        slot.id,
        slot.version,
        act.id,
      );
      bindImportKey(state, {
        source: SOURCE.assignment,
        naturalKey: assignmentNaturalKey,
        recordType: "assignment",
        recordId: assignment.id,
      });
      increment(state.report, "assignment", "created");
    }

    for (const [index, definition] of GOAL1_SLOT_DEFINITIONS.entries()) {
      const slotLabel = definition.artifactLabel;
      const slot = slots[index];
      if (!slot) continue;
      const configuration = object(
        configuredSlots[slotLabel],
        `${entryId} ${slotLabel} slot`,
      );
      if (!("same_as" in configuration)) continue;
      const sameAs = requiredString(
        configuration.same_as,
        `${entryId} ${slotLabel} same_as`,
      );
      const assignmentNaturalKey = `${natural}:${slotLabel}`;
      const existingAssignment = findImportKey(
        state,
        SOURCE.assignment,
        assignmentNaturalKey,
      );
      if (existingAssignment !== null) {
        increment(state.report, "assignment", "found");
        continue;
      }
      const sourceIndex = GOAL1_SLOT_DEFINITIONS.findIndex(
        ({ artifactLabel }) => artifactLabel === sameAs,
      );
      const sourceSlot = slots[sourceIndex];
      const sourceAssignment = sourceSlot
        ? state.core.seasons
            .listAssignments(state.season.id)
            .find((assignment) => assignment.slotId === sourceSlot.id)
        : undefined;
      if (!sourceSlot || !sourceAssignment) {
        state.report.warnings.push(
          `Continuation assignment did not resolve: ${entryId} ${slotLabel} -> ${sameAs}`,
        );
        increment(state.report, "assignment", "skipped");
        continue;
      }
      const assignment = state.core.seasons.assignSlot(
        slot.id,
        slot.version,
        sourceAssignment.actId,
        { continuesAssignmentFromSlotId: sourceSlot.id },
      );
      bindImportKey(state, {
        source: SOURCE.assignment,
        naturalKey: assignmentNaturalKey,
        recordType: "assignment",
        recordId: assignment.id,
      });
      increment(state.report, "assignment", "created");
    }
  }
  applySlotCancellations(state, matches);
}

function applySlotCancellations(state: ImportState, matches: JsonObject): void {
  const cancellationsByAct = new Map<
    number,
    {
      act: Act;
      cancellations: {
        entryId: string;
        slotLabel: string;
        on: string;
        reason: string;
        propagatedFrom?: string;
      }[];
    }
  >();
  const assignmentsBySlot = new Map(
    state.core.seasons
      .listAssignments(state.season.id)
      .map((assignment) => [assignment.slotId, assignment]),
  );

  for (const rawVenue of array(matches.venues)) {
    const venueEntry = object(rawVenue, "venue entry");
    const entryId = requiredString(venueEntry.id, "venue id");
    const venueId = state.matchedVenueIds.get(entryId);
    if (venueId === undefined) continue;
    const slots = state.core.seasons.listVenueSlots(venueId);
    const configuredSlots = object(venueEntry.slots, `slots for ${entryId}`);
    for (const [index, definition] of GOAL1_SLOT_DEFINITIONS.entries()) {
      const slotLabel = definition.artifactLabel;
      const configuration = object(
        configuredSlots[slotLabel],
        `${entryId} ${slotLabel} slot`,
      );
      if (!("canceled" in configuration)) continue;
      const cancellation = object(
        configuration.canceled,
        `${entryId} ${slotLabel} cancellation`,
      );
      const on = requiredIsoDate(cancellation.on, "Slot cancellation on");
      const reason = requiredString(
        cancellation.reason,
        "slot cancellation reason",
      );
      const slot = slots[index];
      if (!slot) continue;
      const assignment = assignmentsBySlot.get(slot.id);
      const assignedAct = assignment
        ? state.core.seasons.getAct(assignment.actId)
        : null;
      const act = assignedAct
        ? state.core.seasons.resolveAct(assignedAct.id).canonical
        : resolveConfiguredSlotAct(state, configuration, configuredSlots);
      if (!act) {
        state.report.warnings.push(
          `Canceled slot assignment did not resolve: ${entryId} ${slotLabel}`,
        );
        continue;
      }
      const grouped = cancellationsByAct.get(act.id) ?? {
        act,
        cancellations: [],
      };
      grouped.cancellations.push({ entryId, slotLabel, on, reason });
      const partnerLabels = new Set<string>();
      const sourceLabel = optionalString(configuration.same_as);
      if (sourceLabel) partnerLabels.add(sourceLabel);
      for (const [partnerLabel, rawPartner] of Object.entries(
        configuredSlots,
      )) {
        const partner = object(rawPartner, `${entryId} ${partnerLabel} slot`);
        if (optionalString(partner.same_as) === slotLabel) {
          partnerLabels.add(partnerLabel);
        }
      }
      for (const partnerLabel of partnerLabels) {
        grouped.cancellations.push({
          entryId,
          slotLabel: partnerLabel,
          on,
          reason,
          propagatedFrom: slotLabel,
        });
      }
      cancellationsByAct.set(act.id, grouped);
      const sourceIndex = sourceLabel
        ? GOAL1_SLOT_DEFINITIONS.findIndex(
            ({ artifactLabel }) => artifactLabel === sourceLabel,
          )
        : -1;
      const sourceSlot = sourceIndex >= 0 ? slots[sourceIndex] : undefined;
      const assignmentToUnassign =
        (sourceSlot ? assignmentsBySlot.get(sourceSlot.id) : undefined) ??
        assignment;
      if (assignmentToUnassign) {
        state.core.seasons.unassignSlot(
          assignmentToUnassign.id,
          assignmentToUnassign.version,
        );
        for (const [assignedSlotId, candidate] of assignmentsBySlot) {
          if (
            candidate.id === assignmentToUnassign.id ||
            candidate.continuationOfAssignmentId === assignmentToUnassign.id
          ) {
            assignmentsBySlot.delete(assignedSlotId);
          }
        }
      }
    }
  }

  for (const {
    act: importedAct,
    cancellations,
  } of cancellationsByAct.values()) {
    for (const cancellation of cancellations) {
      addAnnotation(
        state,
        "act",
        importedAct.id,
        `cancellation:${cancellation.entryId}:${cancellation.slotLabel}`,
        `Canceled on ${cancellation.on}: ${cancellation.reason}${
          cancellation.propagatedFrom
            ? ` (same_as partner of ${cancellation.propagatedFrom})`
            : ""
        }`,
      );
    }
    const act = state.core.seasons.getAct(importedAct.id);
    if (act.status !== "withdrawn") {
      state.core.seasons.setRecordStatus(
        "act",
        act.id,
        act.version,
        "withdrawn",
      );
    }
  }
}

function resolveConfiguredSlotAct(
  state: ImportState,
  configuration: JsonObject,
  configuredSlots: JsonObject,
  seenLabels: Set<string> = new Set(),
): Act | null {
  const performerKey = optionalString(configuration.performer_ts);
  if (performerKey) {
    const act = state.performerActs.get(performerKey);
    return act ? state.core.seasons.resolveAct(act.id).canonical : null;
  }
  const virtualKey = optionalString(configuration.virtual_performer);
  if (virtualKey) {
    const act = state.virtualActs.get(virtualKey);
    return act ? state.core.seasons.resolveAct(act.id).canonical : null;
  }
  const sameAs = optionalString(configuration.same_as);
  if (!sameAs) return null;
  if (seenLabels.has(sameAs)) {
    throw new Error(`Slot same_as cycle includes ${sameAs}.`);
  }
  seenLabels.add(sameAs);
  const source = object(configuredSlots[sameAs], `${sameAs} source slot`);
  return resolveConfiguredSlotAct(state, source, configuredSlots, seenLabels);
}

function applyVenueWithdrawal(
  state: ImportState,
  venue: Venue,
  rawWithdrawal: unknown,
): Venue {
  if (
    rawWithdrawal === undefined ||
    rawWithdrawal === null ||
    rawWithdrawal === false
  ) {
    return venue;
  }
  let note = "Withdrawn";
  if (rawWithdrawal !== true) {
    const withdrawal = object(rawWithdrawal, "venue withdrawal");
    const on = requiredIsoDate(withdrawal.on, "Venue withdrawal on");
    note = `Withdrawn on ${on}: ${requiredString(withdrawal.reason, "venue withdrawal reason")}`;
  }
  addAnnotation(state, "venue", venue.id, `venue:${venue.id}:withdrawal`, note);
  if (venue.status === "withdrawn") return venue;
  state.core.seasons.setRecordStatus(
    "venue",
    venue.id,
    venue.version,
    "withdrawn",
  );
  return state.core.seasons.getVenue(venue.id);
}

function annotateVenueEntry(
  state: ImportState,
  venue: Venue,
  entryId: string,
  entry: JsonObject,
): void {
  const basis = optionalString(entry.basis);
  if (basis)
    addAnnotation(
      state,
      "venue",
      venue.id,
      `${entryId}:basis`,
      `Basis: ${basis}`,
    );
  for (const [index, chase] of stringList(entry.chase).entries()) {
    addAnnotation(
      state,
      "venue",
      venue.id,
      `${entryId}:chase:${index}`,
      `Chase: ${chase}`,
    );
  }
  for (const [index, note] of stringList(entry.email_notes).entries()) {
    addAnnotation(
      state,
      "venue",
      venue.id,
      `${entryId}:email-note:${index}`,
      `Email note: ${note}`,
    );
  }
  for (const [index, reference] of stringList(
    entry.extra_recipients,
  ).entries()) {
    const manualKey = manualContactKey(reference);
    const contact = manualKey ? state.manualContacts.get(manualKey) : null;
    if (!contact) {
      state.report.warnings.push(
        `Extra recipient did not resolve: ${entryId} recipient ${index + 1}`,
      );
      continue;
    }
    addAnnotation(
      state,
      "venue",
      venue.id,
      `${entryId}:extra-recipient:${index}`,
      `Extra recipient: ${contact.name}`,
    );
  }
  const addressCheck = optionalString(entry.address_check);
  if (addressCheck) {
    addAnnotation(
      state,
      "venue",
      venue.id,
      `${entryId}:address-check`,
      `Address check: ${addressCheck}`,
    );
  }
}

function annotateSlotProse(
  state: ImportState,
  venueId: number,
  entryId: string,
  slotLabel: string,
  slot: JsonObject,
): void {
  const note = optionalString(slot.note) ?? optionalString(slot.email_note);
  if (note) {
    addAnnotation(
      state,
      "venue",
      venueId,
      `${entryId}:${slotLabel}:note`,
      `Slot ${slotLabel}: ${note}`,
    );
  }
  for (const [index, chase] of stringList(slot.chase).entries()) {
    addAnnotation(
      state,
      "venue",
      venueId,
      `${entryId}:${slotLabel}:chase:${index}`,
      `Slot ${slotLabel} chase: ${chase}`,
    );
  }
  const bandCheck = optionalString(slot.band_check);
  if (bandCheck) {
    addAnnotation(
      state,
      "venue",
      venueId,
      `${entryId}:${slotLabel}:band-check`,
      `Band check: ${bandCheck}`,
    );
  }
}

function annotateUnmatchedAndFloating(
  state: ImportState,
  matches: JsonObject,
): void {
  for (const raw of array(matches.unmatched_venues)) {
    const entry = object(raw, "unmatched venue");
    const naturalKey = requiredString(entry.host_ts, "unmatched venue host_ts");
    const venue = state.hostVenues.get(naturalKey);
    if (!venue) {
      state.report.warnings.push(
        `Unmatched venue did not resolve: ${naturalKey}`,
      );
      continue;
    }
    for (const [field, label] of [
      ["status", "Status"],
      ["email_note", "Email note"],
      ["address_check", "Address check"],
    ] as const) {
      const value = optionalString(entry[field]);
      if (value) {
        addAnnotation(
          state,
          "venue",
          venue.id,
          `unmatched:${naturalKey}:${field}`,
          `${label}: ${value}`,
        );
      }
    }
  }
  for (const raw of array(matches.floating_performers)) {
    const entry = object(raw, "floating performer");
    const naturalKey = requiredString(
      entry.performer_ts,
      "floating performer performer_ts",
    );
    const act = state.performerActs.get(naturalKey);
    if (!act) {
      state.report.warnings.push(
        `Floating performer did not resolve: ${naturalKey}`,
      );
      continue;
    }
    for (const [field, label] of [
      ["status", "Status"],
      ["status_display", "Status detail"],
      ["action", "Action"],
    ] as const) {
      const value = optionalString(entry[field]);
      if (value) {
        addAnnotation(
          state,
          "act",
          act.id,
          `floating:${naturalKey}:${field}`,
          `${label}: ${value}`,
        );
      }
    }
    for (const [noteIndex, note] of stringList(entry.email_notes).entries()) {
      addAnnotation(
        state,
        "act",
        act.id,
        `floating:${naturalKey}:email-note:${noteIndex}`,
        `Email note: ${note}`,
      );
    }
  }
}

function importCoordinates(state: ImportState, geocache: JsonObject): void {
  const canonicalByAddress = new Map<string, Venue[]>();
  const canonicalVenues = state.core.seasons
    .listSeasonVenues(state.season.id)
    .filter(
      (venue) =>
        venue.canonicalVenueId === null && venue.status !== "withdrawn",
    );
  for (const venue of canonicalVenues) {
    const normalized = normalizeVenueAddress(venue.address);
    if (!normalized) continue;
    const venuesAtAddress = canonicalByAddress.get(normalized) ?? [];
    venuesAtAddress.push(venue);
    canonicalByAddress.set(normalized, venuesAtAddress);
  }
  for (const [address, venuesAtAddress] of canonicalByAddress) {
    if (venuesAtAddress.length < 2) continue;
    const naturalKeys = venuesAtAddress.map(
      (venue) =>
        state.venueNaturalKeys
          .get(venue.id)
          ?.replace(/^(?:host|virtual):/, "") ?? `venue:${venue.id}`,
    );
    state.report.warnings.push(
      `Live canonical venues share geocache address ${address}: ${naturalKeys.join(", ")}`,
    );
  }
  const hitVenueIds = new Set<number>();
  for (const [address, rawCoordinate] of Object.entries(geocache)) {
    const coordinate = object(rawCoordinate, `geocache entry ${address}`);
    const provider = requiredString(coordinate.source, "geocache source");
    const providerKind = goal1ProviderKind(provider);
    const rawRef = coordinate.ref;
    const ref = typeof rawRef === "string" ? rawRef : "";
    const validRef = /^(node|way|relation)\/\d+$/.test(ref);
    if (!validRef) {
      const warningRef =
        typeof rawRef === "string" && rawRef.length > 0
          ? rawRef
          : (JSON.stringify(rawRef) ?? "<missing>");
      state.report.warnings.push(
        `Malformed geocache ref requires review: ${warningRef}`,
      );
    }
    if (providerKind.warning) state.report.warnings.push(providerKind.warning);
    const normalizedAddress = normalizeVenueAddress(address);
    const venuesAtAddress = canonicalByAddress.get(normalizedAddress);
    if (!venuesAtAddress) {
      state.report.geocache.misses.push(address);
      continue;
    }
    for (const venue of venuesAtAddress) {
      const natural =
        state.venueNaturalKeys.get(venue.id) ?? `venue:${venue.id}`;
      const naturalKey = `${natural}:${normalizedAddress}`;
      const found = findImportKey(state, SOURCE.coordinate, naturalKey);
      const imported = state.core.geocoding.importGeocodedCoordinate(venue.id, {
        latitude: requiredNumber(coordinate.lat, "geocache latitude"),
        longitude: requiredNumber(coordinate.lng, "geocache longitude"),
        provider,
        ref,
        crossCheckDistanceM: nullableNumber(
          coordinate.crosscheck_m,
          "geocache crosscheck_m",
        ),
        precision: providerKind.precision,
        interpolated: providerKind.interpolated,
        forcedRejectionCode: validRef
          ? providerKind.forcedRejectionCode
          : "refused",
      });
      const stored = imported.coordinate;
      const status =
        imported.kind === "preserved"
          ? "preserved"
          : found === null
            ? "created"
            : "found";
      if (found === null) {
        bindImportKey(state, {
          source: SOURCE.coordinate,
          naturalKey,
          recordType: "coordinate",
          recordId: stored.id,
        });
      } else if (found.recordId !== stored.id) {
        throw new Error(
          `Coordinate import key ${naturalKey} no longer resolves to venue ${venue.id}.`,
        );
      }
      increment(
        state.report,
        "coordinate",
        status === "preserved" ? "found" : status,
      );
      state.report.geocache.hits.push({
        address,
        venueId: venue.id,
        coordinateId: stored.id,
        status,
        reviewStatus: stored.status,
        rejectionCode: stored.rejectionCode,
      });
      hitVenueIds.add(venue.id);
    }
  }
  for (const venue of canonicalVenues) {
    if (!venue.address || hitVenueIds.has(venue.id)) continue;
    state.report.geocache.misses.push(venue.address);
    state.report.warnings.push(
      `Canonical venue has no geocache entry: ${venue.address}`,
    );
  }
}

function goal1ProviderKind(provider: string): {
  readonly precision: CoordinatePrecision;
  readonly interpolated: boolean;
  readonly forcedRejectionCode?: CoordinateRejectionCode;
  readonly warning?: string;
} {
  switch (provider) {
    case "osm-address-point":
      return { precision: "parcel", interpolated: false };
    case "nominatim-house":
      return { precision: "house", interpolated: false };
    case "us-census-unimproved":
      return { precision: "street", interpolated: true };
  }
  return {
    precision: "parcel",
    interpolated: false,
    forcedRejectionCode: "refused",
    warning: `Unknown geocache source label requires review: ${provider}`,
  };
}

function addAnnotation(
  state: ImportState,
  recordType: "venue" | "act" | "contact",
  recordId: number,
  naturalKey: string,
  note: string,
): void {
  if (state.reportedAnnotationKeys.has(naturalKey)) return;
  state.reportedAnnotationKeys.add(naturalKey);
  const found = findImportKey(state, SOURCE.annotation, naturalKey);
  if (found !== null) {
    increment(state.report, "annotation", "found");
    return;
  }
  const result = state.core.annotations.annotate({
    seasonId: state.season.id,
    recordType,
    recordId,
    note,
  });
  bindImportKey(state, {
    source: SOURCE.annotation,
    naturalKey,
    recordType: "annotation",
    recordId: result.annotation.id,
  });
  increment(state.report, "annotation", result.created ? "created" : "found");
}

interface VirtualActReachResolution {
  readonly contact: Contact;
  readonly reachVia: ImportPlaceholderReachVia;
}

function resolveVirtualActReach(
  state: ImportState,
  virtualKey: string,
  reachVia: string,
  venues: readonly JsonObject[],
  matches: JsonObject,
): VirtualActReachResolution | null {
  if (reachVia !== "host") {
    const contact =
      state.hostContacts.get(reachVia) ?? state.performerContacts.get(reachVia);
    return contact ? { contact, reachVia: "timestamp" } : null;
  }
  const slotVenue = venues.find((entry) =>
    Object.values(objectOrEmpty(entry.slots)).some((rawSlot) => {
      const slot = object(rawSlot, "virtual performer slot");
      return (
        slot.virtual_performer === virtualKey ||
        slot.held_for_virtual_performer === virtualKey
      );
    }),
  );
  if (slotVenue) {
    const contact = resolveVenueEntryContact(state, slotVenue, matches);
    if (contact) return { contact, reachVia: "slot" };
  }

  const keyPattern = new RegExp(`\\b${escapeRegex(virtualKey)}\\b`, "i");
  const chaseVenues = venues.filter((entry) =>
    stringList(entry.chase).some((chase) => keyPattern.test(chase)),
  );
  if (chaseVenues.length > 1) {
    state.report.warnings.push(
      `Virtual performer chase matched multiple venues; using first: ${virtualKey}`,
    );
  }
  const chaseVenue = chaseVenues[0];
  if (chaseVenue) {
    const contact = resolveVenueEntryContact(state, chaseVenue, matches);
    if (contact) return { contact, reachVia: "chase" };
  }

  const timestampContact =
    state.hostContacts.get(reachVia) ?? state.performerContacts.get(reachVia);
  return timestampContact
    ? { contact: timestampContact, reachVia: "timestamp" }
    : null;
}

function resolveVenueEntryContact(
  state: ImportState,
  venueEntry: JsonObject,
  matches: JsonObject,
): Contact | null {
  const hostKey = optionalString(venueEntry.host_ts);
  if (hostKey) return state.hostContacts.get(hostKey) ?? null;
  const virtualVenueKey = optionalString(venueEntry.virtual_venue);
  if (!virtualVenueKey) return null;
  const virtualVenue = object(
    objectOrEmpty(matches.virtual_venues)[virtualVenueKey],
    `virtual venue ${virtualVenueKey}`,
  );
  const performerKey = optionalString(virtualVenue.reach_via_performer_ts);
  return performerKey
    ? (state.performerContacts.get(performerKey) ?? null)
    : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapHost(row: JsonObject) {
  const contact: SignupContactInput = {
    name: requiredString(row.contact_name, "host contact_name"),
    email: optionalString(row.contact_email),
    phone: optionalString(row.contact_phone),
  };
  const gear = mapSelections<VenueGear["value"]>(
    optionalString(row.gear),
    [
      ["microphone stand", "microphone_stand"],
      ["music stand", "music_stand"],
      ["power strip", "power_strip"],
      ["extension", "extension_cord"],
      ["keyboard", "keyboard"],
      ["drum", "drum_kit"],
      ["amplifier", "instrument_amplifier"],
      [" amp", "instrument_amplifier"],
      ["microphone", "microphone"],
      [" pa", "pa"],
      ["sound system", "pa"],
    ],
    "other",
  );
  const drinks = mapSelections<VenueDrink["value"]>(
    optionalString(row.drinks),
    [
      ["non-alcohol", "non_alcoholic"],
      ["soda", "non_alcoholic"],
      ["water", "water"],
      ["beer", "beer"],
      ["wine", "wine"],
    ],
    "other",
  );
  const amenities = mapSelections<VenueAmenity["value"]>(
    optionalString(row.amenities),
    [
      ["accessible", "accessible_entry"],
      ["restroom", "restroom"],
      ["bathroom", "restroom"],
      ["seating", "seating"],
      ["chair", "seating"],
      ["shade", "shade"],
      ["parking", "parking"],
    ],
    "other",
  );
  const secondary = [
    optionalString(row.secondary_contact_name),
    optionalString(row.secondary_contact_phone),
  ].filter((value): value is string => value !== null);
  const noteParts = [
    optionalString(row.notes),
    optionalString(row.gear_details)
      ? `Gear details: ${optionalString(row.gear_details)}`
      : null,
    secondary.length > 0 ? `Secondary contact: ${secondary.join(" — ")}` : null,
    gear.unmapped ? `Unmapped gear: ${gear.unmapped}` : null,
    drinks.unmapped ? `Unmapped drinks: ${drinks.unmapped}` : null,
    amenities.unmapped ? `Unmapped amenities: ${amenities.unmapped}` : null,
  ];
  return {
    contact,
    venue: {
      title: "",
      address: requiredString(row.address, "host address"),
      spaceDescription: [
        optionalString(row.property_part),
        optionalString(row.space_type),
      ]
        .filter((value): value is string => value !== null)
        .join(" — "),
      hasPower: positiveAnswer(row.electrical),
      rainBackup: positiveAnswer(row.enclosed) || positiveAnswer(row.canopy),
      notes: joinedNotes(noteParts),
      requestedActNames: optionalString(row.wanted_bands),
      genrePreferences: null,
    },
    gear: gear.values,
    drinks: drinks.values,
    amenities: amenities.values,
  } satisfies Omit<HostSignupInput, "seasonId">;
}

function mapPerformer(
  row: JsonObject,
  timeSlots: readonly SeasonTimeSlot[],
): Omit<PerformerSignupInput, "seasonId"> {
  const extracted = extractLinksAndResidue(row.listen, row.websites);
  return {
    contact: {
      name: requiredString(row.contact_name, "performer contact_name"),
      email: optionalString(row.email),
      phone: optionalString(row.phone),
    },
    act: {
      name: requiredString(row.band, "performer band"),
      durationMinutes: durationMinutes(row.duration),
      requiresAmplification: positiveContent(row.amplification),
      genre: optionalString(row.genres) ?? "Unspecified",
      description: optionalString(row.description) ?? "",
      links: extracted.links.join("\n"),
      housePreference: optionalString(row.house_pref),
      canLendGear: positiveContent(row.lend_gear),
      sharedMemberNote: optionalString(row.overlaps),
      notes: performerNotes(row, extracted.residue),
    },
    availabilities: availabilityWindows(row.slots, timeSlots),
  };
}

function mapOverrideField(
  field: string,
  row: JsonObject,
  actChanges: Record<string, unknown>,
  contactChanges: Record<string, unknown>,
): void {
  const directActFields: Record<string, string> = {
    band: "name",
    genres: "genre",
    description: "description",
    house_pref: "housePreference",
    overlaps: "sharedMemberNote",
  };
  const directContactFields: Record<string, string> = {
    contact_name: "name",
    email: "email",
    phone: "phone",
  };
  if (field in directActFields) {
    actChanges[directActFields[field]!] = optionalString(row[field]);
  } else if (field in directContactFields) {
    contactChanges[directContactFields[field]!] = optionalString(row[field]);
  } else if (field === "duration") {
    actChanges.durationMinutes = durationMinutes(row.duration);
  } else if (field === "amplification") {
    actChanges.requiresAmplification = positiveContent(row.amplification);
  } else if (field === "lend_gear") {
    actChanges.canLendGear = positiveContent(row.lend_gear);
  } else if (field === "listen" || field === "websites") {
    const extracted = extractLinksAndResidue(row.listen, row.websites);
    actChanges.links = extracted.links.join("\n");
  }
}

function isMappedOverrideField(field: string): boolean {
  return [
    "band",
    "genres",
    "description",
    "house_pref",
    "overlaps",
    "notes",
    "contact_name",
    "email",
    "phone",
    "duration",
    "amplification",
    "lend_gear",
    "listen",
    "websites",
  ].includes(field);
}

function isPerformerNoteSourceField(field: string): boolean {
  return ["notes", "amplification", "lend_gear", "listen", "websites"].includes(
    field,
  );
}

function performerNotes(
  row: JsonObject,
  linkResidue: readonly string[],
): string | null {
  const gearDetails = optionalString(row.lend_gear_details);
  return joinedNotes([
    optionalString(row.notes),
    gearDetails ? `Gear details: ${gearDetails}` : null,
    detailedAnswerNote(row.amplification, "Amplification response"),
    detailedAnswerNote(row.lend_gear, "Gear lending response"),
    ...linkResidue.map((value) => `Link note: ${value}`),
  ]);
}

function detailedAnswerNote(value: unknown, label: string): string | null {
  const text = optionalString(value);
  if (text === null || placeholder(text)) return null;
  if (/^(?:yes|y|true|1|no|n|false|0)$/i.test(text)) return null;
  return `${label}: ${text}`;
}

function availabilityWindows(
  raw: unknown,
  timeSlots: readonly SeasonTimeSlot[],
): PerformerSignupInput["availabilities"] {
  const value = optionalString(raw)?.toLowerCase() ?? "";
  return GOAL1_SLOT_DEFINITIONS.flatMap((definition, index) => {
    if (
      !value.includes(definition.artifactLabel) &&
      !value.includes(definition.artifactLabel.replace("-", "–"))
    ) {
      return [];
    }
    const slot = timeSlots[index];
    return slot ? [{ startsAt: slot.startsAt, endsAt: slot.endsAt }] : [];
  });
}

function extractLinksAndResidue(...values: unknown[]): {
  links: string[];
  residue: string[];
} {
  const links = new Set<string>();
  const residue: string[] = [];
  for (const raw of values) {
    const value = optionalString(raw);
    if (!value || placeholder(value)) continue;
    const matches = [...value.matchAll(/https?:\/\/[^\s<>"']+/gi)];
    let remainder = value;
    for (const match of matches) {
      const candidate = match[0].replace(/[,.;)]+$/g, "");
      try {
        const normalized = new URL(candidate).toString();
        links.add(normalized);
      } catch {
        // Useful invalid text remains in the residue below.
      }
      remainder = remainder.replace(match[0], " ");
    }
    const useful = remainder
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-,;:]+|[-,;:]+$/g, "");
    if (useful && !placeholder(useful)) residue.push(useful);
  }
  return { links: [...links], residue };
}

function mapSelections<Value extends string>(
  raw: string | null,
  mappings: readonly (readonly [needle: string, value: Value])[],
  fallback: Value,
): { values: Value[]; unmapped: string | null } {
  if (!raw || placeholder(raw)) return { values: [], unmapped: null };
  const normalized = ` ${raw.toLowerCase()} `;
  const values = [
    ...new Set(
      mappings
        .filter(([needle]) => normalized.includes(needle))
        .map(([, value]) => value),
    ),
  ];
  const unmappedTokens = raw
    .split(/[,;\n|]+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 0 &&
        !mappings.some(([needle]) =>
          ` ${token.toLowerCase()} `.includes(needle),
        ),
    );
  if (values.length === 0) {
    values.push(fallback);
    return { values, unmapped: raw };
  }
  return {
    values,
    unmapped: unmappedTokens.length > 0 ? unmappedTokens.join(", ") : null,
  };
}

function readArtifacts(
  directory: string,
  files: Goal1ArtifactFileMap,
): Goal1Artifacts {
  const submissions = readJson(join(directory, files.submissions));
  const matches = readJson(join(directory, files.slate));
  const geocache = readJson(join(directory, files.geocache));
  return {
    hosts: array(submissions.hosts),
    performers: array(submissions.performers),
    matches,
    geocache,
  };
}

function readJson(path: string): JsonObject {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Goal-1 artifact is missing or unreadable: ${path}`, {
      cause: error,
    });
  }
  try {
    return object(JSON.parse(raw), path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Goal-1 artifact is not valid JSON: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function keyedRows(
  rows: readonly JsonObject[],
  kind: "host" | "performer",
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const row of rows) {
    const key =
      optionalString(row[`${kind}_ts`]) ??
      optionalString(row.ts) ??
      optionalString(row.timestamp);
    if (!key)
      throw new Error(`${kind} row is missing its timestamp natural key.`);
    if (result.has(key))
      throw new Error(`Duplicate ${kind} natural key: ${key}`);
    result.set(key, row);
  }
  return result;
}

function eventDateValue(event: JsonObject, eventYear?: number): string {
  const direct = optionalString(event.date);
  if (direct && /^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const display = requiredString(event.date_display, "event date_display");
  const match =
    /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(
      display,
    );
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ] as const;
  if (match) {
    const displayYear = match[3];
    if (displayYear === undefined && eventYear === undefined) {
      throw new Error(
        `Event date_display has no year; pass --event-year YYYY: ${display}`,
      );
    }
    const year = displayYear === undefined ? eventYear! : Number(displayYear);
    if (!Number.isInteger(year) || year < 1000 || year > 9999) {
      throw new Error(`eventYear must be a four-digit year: ${year}`);
    }
    const month =
      monthNames.indexOf(
        match[1]!.toLowerCase() as (typeof monthNames)[number],
      ) + 1;
    const day = Number(match[2]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leap ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1];
    if (day >= 1 && day <= (daysInMonth ?? 0)) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }
  throw new Error(
    `Event date_display must use a month-name date such as September 16, 2026: ${display}`,
  );
}

function durationMinutes(value: unknown): number {
  const matched = optionalString(value)?.match(/\d+/)?.[0];
  const parsed = matched ? Number(matched) : 60;
  return Number.isSafeInteger(parsed) && parsed >= 5 && parsed <= 240
    ? parsed
    : 60;
}

function positiveAnswer(value: unknown): boolean {
  return /^(?:yes|y|true|available|1)\b/i.test(optionalString(value) ?? "");
}

function positiveContent(value: unknown): boolean {
  const text = optionalString(value);
  return (
    text !== null &&
    !placeholder(text) &&
    !/^(?:(?:we|i)\s+)?(?:no|nope|not|none|never|don'?t|doesn'?t|won'?t|false|n\/?a)\b/i.test(
      text,
    )
  );
}

function placeholder(value: string): boolean {
  return /^(?:n\/?a|none|-|no)$/i.test(value.trim());
}

function joinedNotes(values: readonly (string | null)[]): string | null {
  const useful = values.filter(
    (value): value is string => value !== null && !placeholder(value),
  );
  return useful.length > 0 ? useful.join("\n") : null;
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value === undefined || value === null ? {} : object(value, "value");
}

function array(value: unknown): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new Error("Expected an array in Goal-1 artifact.");
  return value.map((entry) => object(entry, "array entry"));
}

function entries(value: unknown): [string, unknown][] {
  return Object.entries(objectOrEmpty(value));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (normalized === null)
    throw new Error(`${label} must be a non-empty string.`);
  return normalized;
}

function requiredIsoDate(value: unknown, label: string): string {
  const date = requiredString(value, label);
  if (!parseWallClock(`${date}T12:00`)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  return date;
}

function manualContactKey(reference: string): string | null {
  const match = reference.match(/^manual_contact:\s*(.+)$/);
  return match?.[1]?.trim() || null;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const normalized = optionalString(entry);
      return normalized ? [normalized] : [];
    });
  }
  const normalized = optionalString(value);
  return normalized ? [normalized] : [];
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null || value === undefined
    ? null
    : requiredNumber(value, label);
}

function emptyReport(): MutableImportReport {
  const counts = (): ImportCounts => ({ created: 0, found: 0, skipped: 0 });
  return {
    seasonId: 0,
    records: {
      season: counts(),
      venue: counts(),
      act: counts(),
      contact: counts(),
      slot: counts(),
      assignment: counts(),
      coordinate: counts(),
      annotation: counts(),
    },
    supersessions: [],
    holds: [],
    placeholderActs: [],
    geocache: { hits: [], misses: [] },
    summary: {
      slateVenues: 0,
      approvedActEntries: 0,
      placeholderActs: 0,
      placeholderVenues: 0,
      unmatchedVenues: 0,
      floatingPerformers: 0,
    },
    warnings: [],
  };
}

function increment(
  report: MutableImportReport,
  recordType: ImportRecordType,
  status: keyof ImportCounts,
): void {
  report.records[recordType][status] += 1;
}

function importKeyCacheKey(source: string, naturalKey: string): string {
  return `${source}\u0000${naturalKey}`;
}

function findImportKey(
  state: ImportState,
  source: string,
  naturalKey: string,
): ImportKey | null {
  return state.importKeys.get(importKeyCacheKey(source, naturalKey)) ?? null;
}

function bindImportKey(
  state: ImportState,
  input: Omit<BindImportKeyInput, "seasonId">,
): ImportKey {
  const result = state.core.importKeys.bind({
    seasonId: state.season.id,
    ...input,
  });
  state.importKeys.set(
    importKeyCacheKey(result.key.source, result.key.naturalKey),
    result.key,
  );
  return result.key;
}

function freezeReport(report: MutableImportReport): ImportReport {
  return Object.freeze({
    ...report,
    annotationCount:
      report.records.annotation.created + report.records.annotation.found,
    records: Object.freeze(
      Object.fromEntries(
        Object.entries(report.records).map(([key, value]) => [
          key,
          Object.freeze({ ...value }),
        ]),
      ) as Record<ImportRecordType, ImportCounts>,
    ),
    supersessions: Object.freeze([...report.supersessions]),
    holds: Object.freeze([...report.holds]),
    placeholderActs: Object.freeze([...report.placeholderActs]),
    geocache: Object.freeze({
      hits: Object.freeze([...report.geocache.hits]),
      misses: Object.freeze([...new Set(report.geocache.misses)]),
    }),
    summary: Object.freeze({ ...report.summary }),
    warnings: Object.freeze([...report.warnings]),
  });
}
