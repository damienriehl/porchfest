import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  actAvailabilities,
  acts,
  annotations,
  assignments,
  contacts,
  emailLog,
  slots,
  venueAmenities,
  venueDrinks,
  venueGear,
  venueCoordinates,
  venues,
  type Act,
  type ActAvailability,
  type Contact,
  type Venue,
  type VenueAmenity,
  type VenueDrink,
  type VenueGear,
} from "./storage/schema.js";
import {
  type CoreExecutor,
  type CoreTransaction,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
  conflict as repositoryConflict,
} from "./storage/repository-errors.js";

export type ActChanges = Partial<
  Pick<
    Act,
    | "name"
    | "genre"
    | "description"
    | "links"
    | "durationMinutes"
    | "requiresAmplification"
    | "housePreference"
    | "sharedMemberNote"
    | "canLendGear"
    | "placeholder"
    | "reachViaContactId"
  >
>;

export type VenueChanges = Partial<
  Pick<
    Venue,
    | "title"
    | "address"
    | "spaceDescription"
    | "hasPower"
    | "requestedActNames"
    | "genrePreferences"
    | "rainBackup"
    | "notes"
    | "hostContactId"
    | "placeholder"
    | "reachViaContactId"
  >
>;

export type ContactChanges = Partial<Pick<Contact, "name" | "email" | "phone">>;

export interface SignupContactInput {
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface HostSignupInput {
  seasonId: number;
  contact: SignupContactInput;
  venue: {
    title: string;
    address: string;
    spaceDescription: string;
    hasPower: boolean;
    rainBackup: boolean;
    notes: string | null;
    requestedActNames?: string | null;
    genrePreferences?: string | null;
  };
  gear: readonly VenueGear["value"][];
  drinks: readonly VenueDrink["value"][];
  amenities: readonly VenueAmenity["value"][];
}

export interface PerformerSignupInput {
  seasonId: number;
  contact: SignupContactInput;
  act: {
    name: string;
    durationMinutes: number;
    requiresAmplification: boolean;
    genre: string;
    description: string;
    links: string;
    housePreference: string | null;
    canLendGear: boolean;
    notes: string | null;
    sharedMemberNote?: string | null;
  };
  availabilities: readonly {
    startsAt: Date;
    endsAt: Date;
  }[];
}

export interface ManualPlaceholderContactInput {
  name: string;
  email: string;
  phone?: string | null;
}

// R26 stores both reachability choices through the contact graph. A manual
// address becomes a contact row, so promotion and canonical resolution can use
// the same recipient rules as a placeholder reached through another party.
export type PlaceholderReachInput =
  | {
      reachViaContactId: number;
      contact?: never;
    }
  | {
      reachViaContactId?: never;
      contact: ManualPlaceholderContactInput;
    };

export interface CreatePlaceholderActInput {
  seasonId: number;
  reach: PlaceholderReachInput;
  act: {
    name: string;
    genre?: string | null;
    description?: string | null;
    links?: string | null;
    durationMinutes?: number | null;
    requiresAmplification?: boolean | null;
    housePreference?: string | null;
    canLendGear?: boolean | null;
    notes?: string | null;
    sharedMemberNote?: string | null;
  };
}

export interface CreatePlaceholderVenueInput {
  seasonId: number;
  reach: PlaceholderReachInput;
  venue: {
    title: string;
    address?: string | null;
    spaceDescription?: string | null;
    hasPower?: boolean | null;
    rainBackup?: boolean | null;
    notes?: string | null;
    hostContactId?: number | null;
    requestedActNames?: string | null;
    genrePreferences?: string | null;
  };
}

export interface HostSignup {
  contact: Contact;
  venue: Venue;
  gear: VenueGear[];
  drinks: VenueDrink[];
  amenities: VenueAmenity[];
}

export interface PerformerSignup {
  contact: Contact;
  act: Act;
  availabilities: ActAvailability[];
}

export type ActivityQueueItem =
  | { recordType: "act"; record: Act }
  | { recordType: "venue"; record: Venue }
  | { recordType: "contact"; record: Contact };

export interface RecordResolution<T> {
  canonical: T;
  superseded: T[];
}

export class RecordConflictError extends RepositoryConflictError<
  "act" | "venue" | "contact"
> {
  constructor(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    super("RecordConflictError", recordType, recordId, conflictingFields);
  }
}

export class RecordLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("RecordLifecycleError", message);
  }
}

export type RecordRepositoryOptions = RepositoryOptions;

export function createRecordRepository(
  db: CoreExecutor,
  options: RecordRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function conflict(
    recordType: "act" | "venue" | "contact",
    recordId: number,
    fields: readonly string[],
  ): never {
    return repositoryConflict(
      RecordConflictError,
      recordType,
      recordId,
      fields,
    );
  }

  function getAct(id: number): Act {
    const record = db.select().from(acts).where(eq(acts.id, id)).get();
    if (!record) throw new RecordLifecycleError(`act ${id} does not exist`);
    return record;
  }

  function getVenue(id: number): Venue {
    const record = db.select().from(venues).where(eq(venues.id, id)).get();
    if (!record) throw new RecordLifecycleError(`venue ${id} does not exist`);
    return record;
  }

  function getContact(id: number): Contact {
    const record = db.select().from(contacts).where(eq(contacts.id, id)).get();
    if (!record) throw new RecordLifecycleError(`contact ${id} does not exist`);
    return record;
  }

  function mutableValues() {
    const timestamp = now();
    return { createdAt: timestamp, updatedAt: timestamp };
  }

  function createContact(input: HostSignupInput | PerformerSignupInput) {
    return db
      .insert(contacts)
      .values({
        seasonId: input.seasonId,
        name: input.contact.name,
        email: input.contact.email ?? null,
        phone: input.contact.phone ?? null,
        ...mutableValues(),
      })
      .returning()
      .get();
  }

  function createHostSignup(input: HostSignupInput): HostSignup {
    const contact = createContact(input);
    const venue = db
      .insert(venues)
      .values({
        seasonId: input.seasonId,
        title: input.venue.title,
        address: input.venue.address,
        spaceDescription: input.venue.spaceDescription,
        hasPower: input.venue.hasPower,
        rainBackup: input.venue.rainBackup,
        notes: input.venue.notes,
        requestedActNames: input.venue.requestedActNames ?? null,
        genrePreferences: input.venue.genrePreferences ?? null,
        hostContactId: contact.id,
        ...mutableValues(),
      })
      .returning()
      .get();
    const gear =
      input.gear.length === 0
        ? []
        : db
            .insert(venueGear)
            .values(
              input.gear.map((value) => ({
                seasonId: input.seasonId,
                venueId: venue.id,
                value,
                ...mutableValues(),
              })),
            )
            .returning()
            .all();
    const drinks =
      input.drinks.length === 0
        ? []
        : db
            .insert(venueDrinks)
            .values(
              input.drinks.map((value) => ({
                seasonId: input.seasonId,
                venueId: venue.id,
                value,
                ...mutableValues(),
              })),
            )
            .returning()
            .all();
    const amenities =
      input.amenities.length === 0
        ? []
        : db
            .insert(venueAmenities)
            .values(
              input.amenities.map((value) => ({
                seasonId: input.seasonId,
                venueId: venue.id,
                value,
                ...mutableValues(),
              })),
            )
            .returning()
            .all();
    return { contact, venue, gear, drinks, amenities };
  }

  function createPerformerSignup(input: PerformerSignupInput): PerformerSignup {
    const contact = createContact(input);
    const act = db
      .insert(acts)
      .values({
        seasonId: input.seasonId,
        name: input.act.name,
        durationMinutes: input.act.durationMinutes,
        requiresAmplification: input.act.requiresAmplification,
        genre: input.act.genre,
        description: input.act.description,
        links: input.act.links,
        housePreference: input.act.housePreference,
        canLendGear: input.act.canLendGear,
        notes: input.act.notes,
        sharedMemberNote: input.act.sharedMemberNote ?? null,
        reachViaContactId: contact.id,
        ...mutableValues(),
      })
      .returning()
      .get();
    const availabilities =
      input.availabilities.length === 0
        ? []
        : db
            .insert(actAvailabilities)
            .values(
              input.availabilities.map(({ startsAt, endsAt }) => ({
                seasonId: input.seasonId,
                actId: act.id,
                startsAt,
                endsAt,
                ...mutableValues(),
              })),
            )
            .returning()
            .all();
    return { contact, act, availabilities };
  }

  function createPlaceholderReachContact(
    executor: CoreExecutor,
    seasonId: number,
    reach: PlaceholderReachInput,
  ): number {
    if (reach.reachViaContactId !== undefined) {
      const contact = executor
        .select()
        .from(contacts)
        .where(eq(contacts.id, reach.reachViaContactId))
        .get();
      if (!contact) {
        throw new RecordLifecycleError(
          `contact ${reach.reachViaContactId} does not exist`,
        );
      }
      if (contact.seasonId !== seasonId) {
        throw new RecordLifecycleError(
          "placeholder contact belongs to a different season",
        );
      }
      return contact.id;
    }

    const contact = executor
      .insert(contacts)
      .values({
        seasonId,
        name: reach.contact.name,
        email: reach.contact.email,
        phone: reach.contact.phone ?? null,
        ...mutableValues(),
      })
      .returning()
      .get();
    return contact.id;
  }

  /** R26 creates the organizer's canonical shell before a participant filing
   *  exists. The surrounding transaction matters for manual reachability: a
   *  failed record insert must not leave behind an orphan contact. */
  function createPlaceholderAct(input: CreatePlaceholderActInput): Act {
    return db.transaction((tx: CoreTransaction) => {
      const reachViaContactId = createPlaceholderReachContact(
        tx,
        input.seasonId,
        input.reach,
      );
      return tx
        .insert(acts)
        .values({
          seasonId: input.seasonId,
          ...input.act,
          placeholder: true,
          reachViaContactId,
          ...mutableValues(),
        })
        .returning()
        .get();
    });
  }

  /** Venue placeholders share the same reach-via invariant as acts, while an
   *  optional host reference is independently checked against the season. */
  function createPlaceholderVenue(input: CreatePlaceholderVenueInput): Venue {
    return db.transaction((tx: CoreTransaction) => {
      const reachViaContactId = createPlaceholderReachContact(
        tx,
        input.seasonId,
        input.reach,
      );
      if (input.venue.hostContactId !== undefined) {
        const hostContactId = input.venue.hostContactId;
        if (hostContactId !== null) {
          const host = tx
            .select()
            .from(contacts)
            .where(eq(contacts.id, hostContactId))
            .get();
          if (!host) {
            throw new RecordLifecycleError(
              `contact ${hostContactId} does not exist`,
            );
          }
          if (host.seasonId !== input.seasonId) {
            throw new RecordLifecycleError(
              "placeholder host contact belongs to a different season",
            );
          }
        }
      }
      return tx
        .insert(venues)
        .values({
          seasonId: input.seasonId,
          ...input.venue,
          placeholder: true,
          reachViaContactId,
          ...mutableValues(),
        })
        .returning()
        .get();
    });
  }

  function updateAct(
    id: number,
    expectedVersion: number,
    changes: ActChanges,
  ): Act {
    const fields = Object.keys(changes);
    const result = db
      .update(acts)
      .set({
        ...changes,
        version: sql`${acts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(acts.id, id), eq(acts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("act", id, fields);
    return getAct(id);
  }

  function updateVenue(
    id: number,
    expectedVersion: number,
    changes: VenueChanges,
  ): Venue {
    const beforeAddress =
      changes.address === undefined
        ? undefined
        : db
            .select({ address: venues.address })
            .from(venues)
            .where(eq(venues.id, id))
            .get()?.address;
    const fields = Object.keys(changes);
    const result = db
      .update(venues)
      .set({
        ...changes,
        version: sql`${venues.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("venue", id, fields);
    if (
      changes.address !== undefined &&
      beforeAddress !== undefined &&
      changes.address !== beforeAddress
    ) {
      // R29/AE10: even a hand-placed pin may be wrong after the address moves.
      // Preserve its stronger source so a provider can never replace it, but
      // take it off the publishable path until an organizer verifies it again.
      db.update(venueCoordinates)
        .set({
          status: "needs-review",
          rejectionCode: "address-changed",
          updatedAt: now(),
          updatedBy: null,
          version: sql`${venueCoordinates.version} + 1`,
        })
        .where(eq(venueCoordinates.venueId, id))
        .run();
    }
    return getVenue(id);
  }

  function updateContact(
    id: number,
    expectedVersion: number,
    changes: ContactChanges,
  ): Contact {
    const fields = Object.keys(changes);
    const result = db
      .update(contacts)
      .set({
        ...changes,
        version: sql`${contacts.version} + 1`,
        updatedAt: now(),
      })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .run();
    if (result.changes !== 1) conflict("contact", id, fields);
    return getContact(id);
  }

  function promotePlaceholderAct(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Act {
    return db.transaction((tx: CoreTransaction) => {
      const placeholder = tx
        .select()
        .from(acts)
        .where(eq(acts.id, placeholderId))
        .get();
      const submission = tx
        .select()
        .from(acts)
        .where(eq(acts.id, submissionId))
        .get();
      if (!placeholder)
        throw new RecordLifecycleError(`act ${placeholderId} does not exist`);
      if (!submission)
        throw new RecordLifecycleError(`act ${submissionId} does not exist`);
      if (!placeholder.placeholder)
        throw new RecordLifecycleError(
          `act ${placeholderId} is not a placeholder`,
        );
      if (submission.placeholder)
        throw new RecordLifecycleError(
          `act ${submissionId} is not a submission`,
        );
      if (placeholder.seasonId !== submission.seasonId)
        throw new RecordLifecycleError(
          "promotion records belong to different seasons",
        );
      if (placeholder.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${placeholderId} is already superseded`,
        );
      if (submission.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${submissionId} is already superseded`,
        );
      const placeholderResult = tx
        .update(acts)
        .set({
          name: submission.name,
          genre: submission.genre ?? placeholder.genre,
          description: submission.description ?? placeholder.description,
          links: submission.links ?? placeholder.links,
          durationMinutes:
            submission.durationMinutes ?? placeholder.durationMinutes,
          requiresAmplification:
            submission.requiresAmplification ??
            placeholder.requiresAmplification,
          housePreference:
            submission.housePreference ?? placeholder.housePreference,
          canLendGear: submission.canLendGear ?? placeholder.canLendGear,
          placeholder: false,
          reachViaContactId:
            submission.reachViaContactId ?? placeholder.reachViaContactId,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(eq(acts.id, placeholderId), eq(acts.version, placeholderVersion)),
        )
        .run();
      if (placeholderResult.changes !== 1)
        conflict("act", placeholderId, ["promotion"]);

      tx.update(assignments)
        .set({
          actId: placeholderId,
          version: sql`${assignments.version} + 1`,
          updatedAt: now(),
        })
        .where(eq(assignments.actId, submissionId))
        .run();
      const submissionAvailabilities = tx
        .select({
          startsAt: actAvailabilities.startsAt,
          endsAt: actAvailabilities.endsAt,
        })
        .from(actAvailabilities)
        .where(eq(actAvailabilities.actId, submissionId))
        .all();
      if (submissionAvailabilities.length > 0) {
        const copiedAt = now();
        tx.insert(actAvailabilities)
          .values(
            submissionAvailabilities.map((availability) => ({
              seasonId: submission.seasonId,
              actId: placeholderId,
              startsAt: availability.startsAt,
              endsAt: availability.endsAt,
              createdAt: copiedAt,
              updatedAt: copiedAt,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      tx.update(emailLog)
        .set({ recordId: placeholderId })
        .where(
          and(
            eq(emailLog.recordType, "act"),
            eq(emailLog.recordId, submissionId),
          ),
        )
        .run();
      tx.update(annotations)
        .set({ recordId: placeholderId })
        .where(
          and(
            eq(annotations.recordType, "act"),
            eq(annotations.recordId, submissionId),
          ),
        )
        .run();

      const submissionResult = tx
        .update(acts)
        .set({
          canonicalActId: placeholderId,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(eq(acts.id, submissionId), eq(acts.version, submissionVersion)),
        )
        .run();
      if (submissionResult.changes !== 1)
        conflict("act", submissionId, ["promotion"]);

      const promoted = tx
        .select()
        .from(acts)
        .where(eq(acts.id, placeholderId))
        .get();
      if (!promoted)
        throw new RecordLifecycleError(`act ${placeholderId} disappeared`);
      return promoted;
    });
  }

  function promotePlaceholderVenue(
    placeholderId: number,
    placeholderVersion: number,
    submissionId: number,
    submissionVersion: number,
  ): Venue {
    return db.transaction((tx: CoreTransaction) => {
      const placeholder = tx
        .select()
        .from(venues)
        .where(eq(venues.id, placeholderId))
        .get();
      const submission = tx
        .select()
        .from(venues)
        .where(eq(venues.id, submissionId))
        .get();
      if (!placeholder)
        throw new RecordLifecycleError(`venue ${placeholderId} does not exist`);
      if (!submission)
        throw new RecordLifecycleError(`venue ${submissionId} does not exist`);
      if (!placeholder.placeholder)
        throw new RecordLifecycleError(
          `venue ${placeholderId} is not a placeholder`,
        );
      if (submission.placeholder)
        throw new RecordLifecycleError(
          `venue ${submissionId} is not a submission`,
        );
      if (placeholder.seasonId !== submission.seasonId)
        throw new RecordLifecycleError(
          "promotion records belong to different seasons",
        );
      if (placeholder.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${placeholderId} is already superseded`,
        );
      if (submission.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${submissionId} is already superseded`,
        );
      const placeholderSlot = tx
        .select({ id: slots.id })
        .from(slots)
        .where(
          or(
            eq(slots.venueId, placeholderId),
            eq(slots.fallbackVenueId, placeholderId),
          ),
        )
        .get();
      const submissionSlot = tx
        .select({ id: slots.id })
        .from(slots)
        .where(
          or(
            eq(slots.venueId, submissionId),
            eq(slots.fallbackVenueId, submissionId),
          ),
        )
        .get();
      if (placeholderSlot && submissionSlot)
        throw new RecordLifecycleError("venue promotion would merge slots");

      const placeholderResult = tx
        .update(venues)
        .set({
          title: submission.title,
          address: submission.address ?? placeholder.address,
          spaceDescription:
            submission.spaceDescription ?? placeholder.spaceDescription,
          hasPower: submission.hasPower ?? placeholder.hasPower,
          rainBackup: submission.rainBackup ?? placeholder.rainBackup,
          notes: submission.notes ?? placeholder.notes,
          hostContactId: submission.hostContactId ?? placeholder.hostContactId,
          placeholder: false,
          reachViaContactId:
            submission.reachViaContactId ?? placeholder.reachViaContactId,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(venues.id, placeholderId),
            eq(venues.version, placeholderVersion),
          ),
        )
        .run();
      if (placeholderResult.changes !== 1)
        conflict("venue", placeholderId, ["promotion"]);

      const placeholderCoordinate = tx
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.venueId, placeholderId))
        .get();
      const submittedCoordinate = tx
        .select()
        .from(venueCoordinates)
        .where(eq(venueCoordinates.venueId, submissionId))
        .get();
      const preserveOrganizerCoordinate =
        placeholderCoordinate?.source === "organizer-verified" &&
        submittedCoordinate?.source === "geocoded";
      if (submittedCoordinate !== undefined && !preserveOrganizerCoordinate) {
        tx.insert(venueCoordinates)
          .values({
            venueId: placeholderId,
            latitude: submittedCoordinate.latitude,
            longitude: submittedCoordinate.longitude,
            source: submittedCoordinate.source,
            precision: submittedCoordinate.precision,
            provider: submittedCoordinate.provider,
            ref: submittedCoordinate.ref,
            crossCheckDistanceM: submittedCoordinate.crossCheckDistanceM,
            status: submittedCoordinate.status,
            rejectionCode: submittedCoordinate.rejectionCode,
            addressAtGeocode: submittedCoordinate.addressAtGeocode,
            updatedAt: now(),
            updatedBy: submittedCoordinate.updatedBy,
          })
          .onConflictDoUpdate({
            target: venueCoordinates.venueId,
            set: {
              latitude: submittedCoordinate.latitude,
              longitude: submittedCoordinate.longitude,
              source: submittedCoordinate.source,
              precision: submittedCoordinate.precision,
              provider: submittedCoordinate.provider,
              ref: submittedCoordinate.ref,
              crossCheckDistanceM: submittedCoordinate.crossCheckDistanceM,
              status: submittedCoordinate.status,
              rejectionCode: submittedCoordinate.rejectionCode,
              addressAtGeocode: submittedCoordinate.addressAtGeocode,
              updatedAt: now(),
              updatedBy: submittedCoordinate.updatedBy,
              version: sql`${venueCoordinates.version} + 1`,
            },
          })
          .run();
      }
      if (submittedCoordinate !== undefined) {
        tx.delete(venueCoordinates)
          .where(eq(venueCoordinates.venueId, submissionId))
          .run();
      }
      if (
        (submittedCoordinate === undefined || preserveOrganizerCoordinate) &&
        (submission.address ?? placeholder.address) !== placeholder.address
      ) {
        tx.update(venueCoordinates)
          .set({
            status: "needs-review",
            rejectionCode: "address-changed",
            updatedAt: now(),
            updatedBy: null,
            version: sql`${venueCoordinates.version} + 1`,
          })
          .where(eq(venueCoordinates.venueId, placeholderId))
          .run();
      }

      tx.update(slots)
        .set({
          venueId: sql`case when ${slots.venueId} = ${submissionId} then ${placeholderId} else ${slots.venueId} end`,
          fallbackVenueId: sql`case when ${slots.fallbackVenueId} = ${submissionId} then ${placeholderId} else ${slots.fallbackVenueId} end`,
          version: sql`${slots.version} + 1`,
          updatedAt: now(),
        })
        .where(
          or(
            eq(slots.venueId, submissionId),
            eq(slots.fallbackVenueId, submissionId),
          ),
        )
        .run();
      const submittedGear = tx
        .select({ value: venueGear.value })
        .from(venueGear)
        .where(eq(venueGear.venueId, submissionId))
        .all();
      if (submittedGear.length > 0) {
        const copiedAt = now();
        tx.insert(venueGear)
          .values(
            submittedGear.map(({ value }) => ({
              seasonId: submission.seasonId,
              venueId: placeholderId,
              value,
              createdAt: copiedAt,
              updatedAt: copiedAt,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      const submittedDrinks = tx
        .select({ value: venueDrinks.value })
        .from(venueDrinks)
        .where(eq(venueDrinks.venueId, submissionId))
        .all();
      if (submittedDrinks.length > 0) {
        const copiedAt = now();
        tx.insert(venueDrinks)
          .values(
            submittedDrinks.map(({ value }) => ({
              seasonId: submission.seasonId,
              venueId: placeholderId,
              value,
              createdAt: copiedAt,
              updatedAt: copiedAt,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      const submittedAmenities = tx
        .select({ value: venueAmenities.value })
        .from(venueAmenities)
        .where(eq(venueAmenities.venueId, submissionId))
        .all();
      if (submittedAmenities.length > 0) {
        const copiedAt = now();
        tx.insert(venueAmenities)
          .values(
            submittedAmenities.map(({ value }) => ({
              seasonId: submission.seasonId,
              venueId: placeholderId,
              value,
              createdAt: copiedAt,
              updatedAt: copiedAt,
            })),
          )
          .onConflictDoNothing()
          .run();
      }
      tx.update(emailLog)
        .set({ recordId: placeholderId })
        .where(
          and(
            eq(emailLog.recordType, "venue"),
            eq(emailLog.recordId, submissionId),
          ),
        )
        .run();

      const submissionResult = tx
        .update(venues)
        .set({
          canonicalVenueId: placeholderId,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(venues.id, submissionId),
            eq(venues.version, submissionVersion),
          ),
        )
        .run();
      if (submissionResult.changes !== 1)
        conflict("venue", submissionId, ["promotion"]);

      const promoted = tx
        .select()
        .from(venues)
        .where(eq(venues.id, placeholderId))
        .get();
      if (!promoted)
        throw new RecordLifecycleError(`venue ${placeholderId} disappeared`);
      return promoted;
    });
  }

  function resolveCanonicalAct(id: number): Act {
    let canonical = getAct(id);
    const seen = new Set<number>();
    while (canonical.canonicalActId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`act ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getAct(canonical.canonicalActId);
    }
    return canonical;
  }

  function resolveAct(id: number): RecordResolution<Act> {
    const canonical = resolveCanonicalAct(id);
    const familyRows = db
      .select()
      .from(acts)
      .where(eq(acts.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(
      familyRows.map((record: Act) => [record.id, record]),
    );
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate: Act) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalActId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalActId === canonical.id) return true;
        current =
          familyById.get(current.canonicalActId) ??
          getAct(current.canonicalActId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function resolveCanonicalVenue(id: number): Venue {
    let canonical = getVenue(id);
    const seen = new Set<number>();
    while (canonical.canonicalVenueId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(`venue ${id} has a supersession cycle`);
      seen.add(canonical.id);
      canonical = getVenue(canonical.canonicalVenueId);
    }
    return canonical;
  }

  function resolveVenue(id: number): RecordResolution<Venue> {
    const canonical = resolveCanonicalVenue(id);
    const familyRows = db
      .select()
      .from(venues)
      .where(eq(venues.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(
      familyRows.map((record: Venue) => [record.id, record]),
    );
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate: Venue) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalVenueId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalVenueId === canonical.id) return true;
        current =
          familyById.get(current.canonicalVenueId) ??
          getVenue(current.canonicalVenueId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function resolveCanonicalContact(id: number): Contact {
    let canonical = getContact(id);
    const seen = new Set<number>();
    while (canonical.canonicalContactId !== null) {
      if (seen.has(canonical.id))
        throw new RecordLifecycleError(
          `contact ${id} has a supersession cycle`,
        );
      seen.add(canonical.id);
      canonical = getContact(canonical.canonicalContactId);
    }
    return canonical;
  }

  function resolveContact(id: number): RecordResolution<Contact> {
    const canonical = resolveCanonicalContact(id);
    const familyRows = db
      .select()
      .from(contacts)
      .where(eq(contacts.seasonId, canonical.seasonId))
      .all();
    const familyById = new Map(
      familyRows.map((record: Contact) => [record.id, record]),
    );
    familyById.set(canonical.id, canonical);
    const family = familyRows.filter((candidate: Contact) => {
      if (candidate.id === canonical.id) return false;
      let current = candidate;
      const candidateSeen = new Set<number>();
      while (current.canonicalContactId !== null) {
        if (candidateSeen.has(current.id)) return false;
        candidateSeen.add(current.id);
        if (current.canonicalContactId === canonical.id) return true;
        current =
          familyById.get(current.canonicalContactId) ??
          getContact(current.canonicalContactId);
      }
      return false;
    });
    return { canonical, superseded: family };
  }

  function supersedeAct(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Act {
    return db.transaction((tx: CoreTransaction) => {
      const source = tx.select().from(acts).where(eq(acts.id, id)).get();
      if (!source) throw new RecordLifecycleError(`act ${id} does not exist`);

      let target = tx.select().from(acts).where(eq(acts.id, canonicalId)).get();
      if (!target)
        throw new RecordLifecycleError(`act ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalActId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `act ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalActId;
        target = tx.select().from(acts).where(eq(acts.id, nextId)).get();
        if (!target)
          throw new RecordLifecycleError(`act ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError("act supersession would create a cycle");

      const targetCheck = tx
        .select({ canonicalActId: acts.canonicalActId })
        .from(acts)
        .where(eq(acts.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`act ${target.id} does not exist`);
      if (targetCheck.canonicalActId !== null)
        throw new RecordLifecycleError(
          `act ${target.id} is already superseded`,
        );

      const result = tx
        .update(acts)
        .set({
          canonicalActId: target.id,
          version: sql`${acts.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(acts.id, id), eq(acts.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("act", id, ["canonicalActId"]);

      const superseded = tx.select().from(acts).where(eq(acts.id, id)).get();
      if (!superseded) throw new RecordLifecycleError(`act ${id} disappeared`);
      return superseded;
    });
  }

  function supersedeVenue(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Venue {
    return db.transaction((tx: CoreTransaction) => {
      const source = tx.select().from(venues).where(eq(venues.id, id)).get();
      if (!source) throw new RecordLifecycleError(`venue ${id} does not exist`);

      let target = tx
        .select()
        .from(venues)
        .where(eq(venues.id, canonicalId))
        .get();
      if (!target)
        throw new RecordLifecycleError(`venue ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalVenueId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `venue ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalVenueId;
        target = tx.select().from(venues).where(eq(venues.id, nextId)).get();
        if (!target)
          throw new RecordLifecycleError(`venue ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError(
          "venue supersession would create a cycle",
        );

      const targetCheck = tx
        .select({ canonicalVenueId: venues.canonicalVenueId })
        .from(venues)
        .where(eq(venues.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`venue ${target.id} does not exist`);
      if (targetCheck.canonicalVenueId !== null)
        throw new RecordLifecycleError(
          `venue ${target.id} is already superseded`,
        );

      const result = tx
        .update(venues)
        .set({
          canonicalVenueId: target.id,
          version: sql`${venues.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(venues.id, id), eq(venues.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("venue", id, ["canonicalVenueId"]);

      const superseded = tx
        .select()
        .from(venues)
        .where(eq(venues.id, id))
        .get();
      if (!superseded)
        throw new RecordLifecycleError(`venue ${id} disappeared`);
      return superseded;
    });
  }

  function supersedeContact(
    id: number,
    expectedVersion: number,
    canonicalId: number,
  ): Contact {
    return db.transaction((tx: CoreTransaction) => {
      const source = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, id))
        .get();
      if (!source)
        throw new RecordLifecycleError(`contact ${id} does not exist`);

      let target = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, canonicalId))
        .get();
      if (!target)
        throw new RecordLifecycleError(`contact ${canonicalId} does not exist`);
      const seen = new Set<number>();
      while (target.canonicalContactId !== null) {
        if (seen.has(target.id))
          throw new RecordLifecycleError(
            `contact ${canonicalId} has a supersession cycle`,
          );
        seen.add(target.id);
        const nextId: number = target.canonicalContactId;
        target = tx
          .select()
          .from(contacts)
          .where(eq(contacts.id, nextId))
          .get();
        if (!target)
          throw new RecordLifecycleError(`contact ${nextId} does not exist`);
      }

      if (source.seasonId !== target.seasonId)
        throw new RecordLifecycleError(
          "supersession records belong to different seasons",
        );
      if (source.id === target.id)
        throw new RecordLifecycleError(
          "contact supersession would create a cycle",
        );

      const targetCheck = tx
        .select({ canonicalContactId: contacts.canonicalContactId })
        .from(contacts)
        .where(eq(contacts.id, target.id))
        .get();
      if (!targetCheck)
        throw new RecordLifecycleError(`contact ${target.id} does not exist`);
      if (targetCheck.canonicalContactId !== null)
        throw new RecordLifecycleError(
          `contact ${target.id} is already superseded`,
        );

      const result = tx
        .update(contacts)
        .set({
          canonicalContactId: target.id,
          version: sql`${contacts.version} + 1`,
          updatedAt: now(),
        })
        .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
        .run();
      if (result.changes !== 1) conflict("contact", id, ["canonicalContactId"]);

      const superseded = tx
        .select()
        .from(contacts)
        .where(eq(contacts.id, id))
        .get();
      if (!superseded)
        throw new RecordLifecycleError(`contact ${id} disappeared`);
      return superseded;
    });
  }

  function listActivityQueue(seasonId: number): ActivityQueueItem[] {
    return [
      ...db
        .select()
        .from(acts)
        .where(and(eq(acts.seasonId, seasonId), isNull(acts.canonicalActId)))
        .all()
        .map((record: Act): ActivityQueueItem => ({
          recordType: "act",
          record,
        })),
      ...db
        .select()
        .from(venues)
        .where(
          and(eq(venues.seasonId, seasonId), isNull(venues.canonicalVenueId)),
        )
        .all()
        .map((record: Venue): ActivityQueueItem => ({
          recordType: "venue",
          record,
        })),
      ...db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.seasonId, seasonId),
            isNull(contacts.canonicalContactId),
          ),
        )
        .all()
        .map((record: Contact): ActivityQueueItem => ({
          recordType: "contact",
          record,
        })),
    ];
  }

  function resolveEmailRecipients(
    recordType: "act" | "venue",
    recordId: number,
  ): Contact[] {
    let recipientIds: (number | null)[];
    if (recordType === "act") {
      recipientIds = [resolveCanonicalAct(recordId).reachViaContactId];
    } else {
      const record = resolveCanonicalVenue(recordId);
      recipientIds = [record.hostContactId, record.reachViaContactId];
    }
    const resolved = new Map<number, Contact>();
    for (const contactId of recipientIds) {
      if (contactId === null) continue;
      const canonical = resolveCanonicalContact(contactId);
      if (canonical.email !== null) resolved.set(canonical.id, canonical);
    }
    return [...resolved.values()];
  }

  return Object.freeze({
    createHostSignup,
    createPerformerSignup,
    createPlaceholderAct,
    createPlaceholderVenue,
    updateAct,
    updateVenue,
    updateContact,
    promotePlaceholderAct,
    promotePlaceholderVenue,
    supersedeAct,
    supersedeVenue,
    supersedeContact,
    resolveAct,
    resolveVenue,
    resolveContact,
    listActivityQueue,
    resolveEmailRecipients,
  });
}
