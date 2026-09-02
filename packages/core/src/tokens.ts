// Participant self-serve credentials (R14/R31, KTD8).
//
// The raw bearer exists only in the return value of issue/reissue. SQLite keeps
// its SHA-256 digest, a record-sized scope, and an expiry. Participant edits live
// here too because the contact and its act/venue must pass KTD7 together: a
// contact save followed by a stale record refusal may not leave half an edit.

import { randomBytes } from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { hashToken } from "./access.js";
import { RecordConflictError } from "./records.js";
import { createSeasonRepository } from "./season.js";
import {
  actAvailabilities,
  acts,
  contacts,
  participantMagicLinks,
  venueAmenities,
  venueAmenityValues,
  venueDrinks,
  venueDrinkValues,
  venueGear,
  venueGearValues,
  venues,
  type Act,
  type ActAvailability,
  type ChangeRequestRecordType,
  type Contact,
  type ParticipantMagicLink,
  type Venue,
  type VenueAmenity,
  type VenueDrink,
  type VenueGear,
} from "./storage/schema.js";
import {
  type CoreExecutor,
  type CoreTransaction,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

const TOKEN_BYTES = 32;

export const DEFAULT_PARTICIPANT_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_PARTICIPANT_REISSUE_LIMIT = 3;
export const DEFAULT_PARTICIPANT_REISSUE_WINDOW_MS = 60 * 60_000;

export type ParticipantRecordType = ChangeRequestRecordType;

export type ParticipantTokenFailure =
  | "disabled"
  | "invalid-token"
  | "expired"
  | "revoked"
  | "unavailable"
  | "wrong-record";

export class ParticipantTokenError extends Error {
  override readonly name = "ParticipantTokenError";
  readonly reason: ParticipantTokenFailure;

  constructor(reason: ParticipantTokenFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface ParticipantTokenRepositoryOptions extends RepositoryOptions {
  readonly enabled: boolean;
  readonly createToken?: () => string;
  readonly ttlMs?: number;
  readonly reissueLimit?: number;
  readonly reissueWindowMs?: number;
}

export interface IssuedParticipantLink {
  /** Returned once for delivery. It is never recoverable from storage. */
  readonly token: string;
  readonly link: ParticipantMagicLink;
  readonly email: string;
  readonly displayName: string;
}

export interface ParticipantGrant {
  readonly recordType: ParticipantRecordType;
  readonly recordId: number;
  readonly seasonId: number;
  readonly contactId: number;
  readonly expiresAt: Date;
}

export type ParticipantRecordView =
  | {
      readonly recordType: "act";
      readonly record: Act;
      readonly contact: Contact;
      readonly availabilities: readonly ActAvailability[];
    }
  | {
      readonly recordType: "venue";
      readonly record: Venue;
      readonly contact: Contact;
      readonly gear: readonly VenueGear[];
      readonly drinks: readonly VenueDrink[];
      readonly amenities: readonly VenueAmenity[];
    };

interface ParticipantContactChanges {
  readonly name?: string;
  readonly email?: string | null;
  readonly phone?: string | null;
}

interface ParticipantActChanges {
  readonly name?: string;
  readonly genre?: string | null;
  readonly description?: string | null;
  readonly links?: string | null;
  readonly durationMinutes?: number | null;
  readonly requiresAmplification?: boolean | null;
  readonly housePreference?: string | null;
  readonly sharedMemberNote?: string | null;
  readonly canLendGear?: boolean | null;
  readonly notes?: string | null;
}

interface ParticipantVenueChanges {
  readonly title?: string;
  readonly spaceDescription?: string | null;
  readonly hasPower?: boolean | null;
  readonly requestedActNames?: string | null;
  readonly genrePreferences?: string | null;
  readonly rainBackup?: boolean | null;
  readonly notes?: string | null;
}

interface ParticipantEditBase {
  readonly recordId: number;
  readonly recordVersion: number;
  readonly contactVersion: number;
  readonly contact: ParticipantContactChanges;
}

export type ParticipantEditInput =
  | (ParticipantEditBase & {
      readonly recordType: "act";
      readonly record: ParticipantActChanges;
    })
  | (ParticipantEditBase & {
      readonly recordType: "venue";
      readonly record: ParticipantVenueChanges;
      readonly gear: readonly string[];
      readonly drinks: readonly string[];
      readonly amenities: readonly string[];
    });

export type ParticipantEditResult =
  | {
      readonly recordType: "act";
      readonly record: Act;
      readonly contact: Contact;
    }
  | {
      readonly recordType: "venue";
      readonly record: Venue;
      readonly contact: Contact;
    };

type ParticipantTarget =
  | {
      readonly recordType: "act";
      readonly record: Act;
      readonly contact: Contact;
    }
  | {
      readonly recordType: "venue";
      readonly record: Venue;
      readonly contact: Contact;
    };

export function createParticipantTokenRepository(
  db: CoreExecutor,
  options: ParticipantTokenRepositoryOptions,
) {
  const now = options.now ?? (() => new Date());
  const createToken =
    options.createToken ??
    (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const ttlMs = options.ttlMs ?? DEFAULT_PARTICIPANT_TOKEN_TTL_MS;
  const reissueLimit =
    options.reissueLimit ?? DEFAULT_PARTICIPANT_REISSUE_LIMIT;
  const reissueWindowMs =
    options.reissueWindowMs ?? DEFAULT_PARTICIPANT_REISSUE_WINDOW_MS;

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("participant token ttlMs must be positive");
  }
  if (!Number.isSafeInteger(reissueLimit) || reissueLimit < 1) {
    throw new RangeError("participant reissueLimit must be a positive integer");
  }
  if (!Number.isFinite(reissueWindowMs) || reissueWindowMs <= 0) {
    throw new RangeError("participant reissueWindowMs must be positive");
  }

  function assertEnabled(): void {
    if (!options.enabled) {
      throw new ParticipantTokenError(
        "disabled",
        "participant self-serve requires a configured email provider",
      );
    }
  }

  function targetFor(
    executor: CoreExecutor,
    recordType: ParticipantRecordType,
    recordId: number,
  ): ParticipantTarget {
    if (recordType === "act") {
      const record = executor
        .select()
        .from(acts)
        .where(eq(acts.id, recordId))
        .get();
      const contact = participantContact(
        executor,
        record?.reachViaContactId ?? null,
      );
      if (
        !record ||
        !eligibleRecord(
          record.status,
          record.canonicalActId,
          record.placeholder,
        ) ||
        !contact
      ) {
        throw unavailableRecord();
      }
      return { recordType, record, contact };
    }

    const record = executor
      .select()
      .from(venues)
      .where(eq(venues.id, recordId))
      .get();
    // A stale/unusable host contact must not mask the explicit reach-via
    // fallback. This matters after imports and organizer contact merges.
    const contact = record
      ? (participantContact(executor, record.hostContactId) ??
        participantContact(executor, record.reachViaContactId))
      : null;
    if (
      !record ||
      !eligibleRecord(
        record.status,
        record.canonicalVenueId,
        record.placeholder,
      ) ||
      !contact
    ) {
      throw unavailableRecord();
    }
    return { recordType, record, contact };
  }

  function issue(
    recordType: ParticipantRecordType,
    recordId: number,
  ): IssuedParticipantLink {
    assertEnabled();
    return db.transaction(
      (tx) => issueWith(tx, recordType, recordId, "active"),
      { behavior: "immediate" },
    );
  }

  function issueWith(
    executor: CoreExecutor,
    recordType: ParticipantRecordType,
    recordId: number,
    state: "active" | "pending-reissue",
  ): IssuedParticipantLink {
    const target = targetFor(executor, recordType, recordId);
    const stamp = now();

    // Direct issue is already authoritative. Self-serve reissue remains inert
    // until the delivery adapter confirms that the replacement was sent.
    if (state === "active") {
      revokeTargetLinks(executor, recordType, recordId, stamp);
    }

    const token = createToken();
    const link = executor
      .insert(participantMagicLinks)
      .values({
        recordType,
        recordId,
        contactId: target.contact.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(stamp.valueOf() + ttlMs),
        activatedAt: state === "active" ? stamp : null,
        isReissue: state === "pending-reissue",
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    return {
      token,
      link,
      email: target.contact.email!,
      displayName: target.contact.name,
    };
  }

  function reissueForEmail(email: string): IssuedParticipantLink[] {
    assertEnabled();
    const normalized = normalizeEmail(email);
    if (!normalized) return [];

    return db.transaction(
      (tx) => {
        const matchingContactIds = tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              isNull(contacts.canonicalContactId),
              sql`lower(trim(${contacts.email})) = ${normalized}`,
            ),
          )
          .all()
          .map(({ id }) => id);
        if (matchingContactIds.length === 0) return [];

        const targets: {
          recordType: ParticipantRecordType;
          recordId: number;
        }[] = [];
        for (const act of tx
          .select()
          .from(acts)
          .where(inArray(acts.reachViaContactId, matchingContactIds))
          .all()) {
          if (
            act.reachViaContactId !== null &&
            eligibleRecord(act.status, act.canonicalActId, act.placeholder)
          ) {
            targets.push({ recordType: "act", recordId: act.id });
          }
        }
        for (const venue of tx
          .select()
          .from(venues)
          .where(
            or(
              inArray(venues.hostContactId, matchingContactIds),
              inArray(venues.reachViaContactId, matchingContactIds),
            ),
          )
          .all()) {
          const contact =
            participantContact(tx, venue.hostContactId) ??
            participantContact(tx, venue.reachViaContactId);
          if (
            contact !== null &&
            matchingContactIds.includes(contact.id) &&
            eligibleRecord(
              venue.status,
              venue.canonicalVenueId,
              venue.placeholder,
            )
          ) {
            targets.push({ recordType: "venue", recordId: venue.id });
          }
        }

        const cutoff = new Date(now().valueOf() - reissueWindowMs);
        return targets.flatMap((target) => {
          const row = tx
            .select({ total: sql<number>`count(*)` })
            .from(participantMagicLinks)
            .where(
              and(
                eq(participantMagicLinks.recordType, target.recordType),
                eq(participantMagicLinks.recordId, target.recordId),
                gt(participantMagicLinks.createdAt, cutoff),
                eq(participantMagicLinks.isReissue, true),
                or(
                  isNotNull(participantMagicLinks.activatedAt),
                  and(
                    isNull(participantMagicLinks.activatedAt),
                    isNull(participantMagicLinks.revokedAt),
                  ),
                ),
              ),
            )
            .get();
          return (row?.total ?? 0) >= reissueLimit
            ? []
            : [
                issueWith(
                  tx,
                  target.recordType,
                  target.recordId,
                  "pending-reissue",
                ),
              ];
        });
      },
      { behavior: "immediate" },
    );
  }

  /**
   * Promote one delivered reissue candidate. Earlier live links are revoked
   * only after delivery succeeds, so provider failures cannot lock anyone out.
   */
  function activateReissue(token: string): ParticipantMagicLink {
    assertEnabled();
    return db.transaction(
      (tx) => {
        const candidate = pendingReissue(tx, token);
        const target = targetFor(tx, candidate.recordType, candidate.recordId);
        if (target.contact.id !== candidate.contactId) {
          revokeLink(tx, candidate.id);
          throw new ParticipantTokenError(
            "revoked",
            "reissue target changed before activation",
          );
        }

        const stamp = now();
        revokeTargetLinks(
          tx,
          candidate.recordType,
          candidate.recordId,
          stamp,
          candidate,
        );
        const result = tx
          .update(participantMagicLinks)
          .set({
            activatedAt: stamp,
            version: sql`${participantMagicLinks.version} + 1`,
            updatedAt: stamp,
          })
          .where(
            and(
              eq(participantMagicLinks.id, candidate.id),
              eq(participantMagicLinks.version, candidate.version),
              isNull(participantMagicLinks.activatedAt),
              isNull(participantMagicLinks.revokedAt),
            ),
          )
          .run();
        if (result.changes !== 1) {
          throw new ParticipantTokenError(
            "revoked",
            "reissue candidate is no longer pending",
          );
        }
        return tx
          .select()
          .from(participantMagicLinks)
          .where(eq(participantMagicLinks.id, candidate.id))
          .get()!;
      },
      { behavior: "immediate" },
    );
  }

  /** Mark a failed/thrown delivery candidate inert without touching old links. */
  function abandonReissue(token: string): void {
    assertEnabled();
    db.transaction(
      (tx) => {
        const candidate = tx
          .select()
          .from(participantMagicLinks)
          .where(eq(participantMagicLinks.tokenHash, hashToken(token)))
          .get();
        if (
          !candidate ||
          !candidate.isReissue ||
          candidate.activatedAt ||
          candidate.revokedAt
        ) {
          return;
        }
        revokeLink(tx, candidate.id);
      },
      { behavior: "immediate" },
    );
  }

  function resolve(token: string): ParticipantGrant {
    assertEnabled();
    return resolveWith(db, token);
  }

  function read(token: string): ParticipantRecordView {
    const grant = resolve(token);
    const target = targetFor(db, grant.recordType, grant.recordId);
    if (target.recordType === "act") {
      const availabilities = db
        .select()
        .from(actAvailabilities)
        .where(eq(actAvailabilities.actId, target.record.id))
        .all();
      return { ...target, availabilities };
    }
    return {
      ...target,
      gear: db
        .select()
        .from(venueGear)
        .where(eq(venueGear.venueId, target.record.id))
        .all(),
      drinks: db
        .select()
        .from(venueDrinks)
        .where(eq(venueDrinks.venueId, target.record.id))
        .all(),
      amenities: db
        .select()
        .from(venueAmenities)
        .where(eq(venueAmenities.venueId, target.record.id))
        .all(),
    };
  }

  function resolveWith(
    executor: CoreExecutor,
    token: string,
  ): ParticipantGrant {
    if (!token) {
      throw new ParticipantTokenError(
        "invalid-token",
        "link is not recognized",
      );
    }
    const link = executor
      .select()
      .from(participantMagicLinks)
      .where(eq(participantMagicLinks.tokenHash, hashToken(token)))
      .get();
    if (!link) {
      throw new ParticipantTokenError(
        "invalid-token",
        "link is not recognized",
      );
    }
    if (link.revokedAt) {
      throw new ParticipantTokenError("revoked", "link was revoked");
    }
    if (!link.activatedAt) {
      throw new ParticipantTokenError("invalid-token", "link is not active");
    }
    if (link.expiresAt.valueOf() <= now().valueOf()) {
      throw new ParticipantTokenError("expired", "link has expired");
    }

    let target: ParticipantTarget;
    try {
      target = targetFor(executor, link.recordType, link.recordId);
    } catch (error) {
      if (!(error instanceof ParticipantTokenError)) throw error;
      revokeLink(executor, link.id);
      throw new ParticipantTokenError("revoked", "link was revoked");
    }
    if (target.contact.id !== link.contactId) {
      revokeLink(executor, link.id);
      throw new ParticipantTokenError("revoked", "link was revoked");
    }
    return {
      recordType: link.recordType,
      recordId: link.recordId,
      seasonId: target.record.seasonId,
      contactId: target.contact.id,
      expiresAt: link.expiresAt,
    };
  }

  function revokeLink(executor: CoreExecutor, linkId: number): void {
    const stamp = now();
    executor
      .update(participantMagicLinks)
      .set({
        revokedAt: stamp,
        version: sql`${participantMagicLinks.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(participantMagicLinks.id, linkId),
          isNull(participantMagicLinks.revokedAt),
        ),
      )
      .run();
  }

  function pendingReissue(
    executor: CoreExecutor,
    token: string,
  ): ParticipantMagicLink {
    const candidate = executor
      .select()
      .from(participantMagicLinks)
      .where(eq(participantMagicLinks.tokenHash, hashToken(token)))
      .get();
    if (
      !candidate ||
      !candidate.isReissue ||
      candidate.activatedAt ||
      candidate.revokedAt
    ) {
      throw new ParticipantTokenError(
        "invalid-token",
        "reissue candidate is not pending",
      );
    }
    if (candidate.expiresAt.valueOf() <= now().valueOf()) {
      revokeLink(executor, candidate.id);
      throw new ParticipantTokenError("expired", "link has expired");
    }
    return candidate;
  }

  function revokeTargetLinks(
    executor: CoreExecutor,
    recordType: ParticipantRecordType,
    recordId: number,
    stamp: Date,
    supersedingReissue?: ParticipantMagicLink,
  ): void {
    executor
      .update(participantMagicLinks)
      .set({
        revokedAt: stamp,
        version: sql`${participantMagicLinks.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(participantMagicLinks.recordType, recordType),
          eq(participantMagicLinks.recordId, recordId),
          isNull(participantMagicLinks.revokedAt),
          supersedingReissue === undefined
            ? undefined
            : or(
                isNotNull(participantMagicLinks.activatedAt),
                lt(
                  participantMagicLinks.createdAt,
                  supersedingReissue.createdAt,
                ),
                and(
                  eq(
                    participantMagicLinks.createdAt,
                    supersedingReissue.createdAt,
                  ),
                  lt(participantMagicLinks.id, supersedingReissue.id),
                ),
              ),
        ),
      )
      .run();
  }

  function update(
    token: string,
    input: ParticipantEditInput,
  ): ParticipantEditResult {
    assertEnabled();
    return db.transaction(
      (tx) => {
        const grant = resolveWith(tx, token);
        if (
          grant.recordType !== input.recordType ||
          grant.recordId !== input.recordId
        ) {
          throw new ParticipantTokenError(
            "wrong-record",
            "this link does not grant access to that record",
          );
        }

        const seasons = createSeasonRepository(tx, { now });
        const sharedContact = contactIsShared(
          tx,
          grant.recordType,
          grant.recordId,
          grant.contactId,
        );
        // A shared contact is identity data for multiple records. Clone under
        // the submitted contact version guard and repoint only this grant;
        // otherwise the normal contact CAS is appropriate.
        const contact = sharedContact
          ? cloneContact(
              tx,
              grant.contactId,
              input.contactVersion,
              input.contact,
              now(),
            )
          : seasons.updateContact(
              grant.contactId,
              input.contactVersion,
              input.contact,
            );

        if (input.recordType === "act") {
          const record = seasons.updateAct(
            input.recordId,
            input.recordVersion,
            sharedContact
              ? { ...input.record, reachViaContactId: contact.id }
              : input.record,
          );
          if (sharedContact) {
            repointActiveLinks(tx, grant, contact.id, now());
          }
          return { recordType: "act", record, contact };
        }

        const selections = validateSelections(input);
        const venueContactChanges = sharedContact
          ? venueContactRepoint(tx, input.recordId, grant.contactId, contact.id)
          : {};
        const record = seasons.updateVenue(
          input.recordId,
          input.recordVersion,
          { ...input.record, ...venueContactChanges },
        );
        replaceVenueSelections(tx, record, selections);
        if (sharedContact) {
          repointActiveLinks(tx, grant, contact.id, now());
        }
        return { recordType: "venue", record, contact };
      },
      { behavior: "immediate" },
    );
  }

  return Object.freeze({
    enabled: options.enabled,
    issue,
    reissueForEmail,
    activateReissue,
    abandonReissue,
    resolve,
    read,
    update,
  });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function participantContact(
  executor: CoreExecutor,
  contactId: number | null,
): Contact | null {
  if (contactId === null) return null;
  const contact = executor
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get();
  return contact && contact.canonicalContactId === null && contact.email
    ? contact
    : null;
}

function unavailableRecord(): ParticipantTokenError {
  return new ParticipantTokenError(
    "unavailable",
    "that participant record is unavailable",
  );
}

function eligibleRecord(
  status: string,
  canonicalId: number | null,
  placeholder: boolean,
): boolean {
  return status !== "withdrawn" && canonicalId === null && !placeholder;
}

function contactIsShared(
  executor: CoreExecutor,
  recordType: ParticipantRecordType,
  recordId: number,
  contactId: number,
): boolean {
  const anotherAct = executor
    .select({ id: acts.id })
    .from(acts)
    .where(
      and(
        eq(acts.reachViaContactId, contactId),
        recordType === "act" ? ne(acts.id, recordId) : undefined,
      ),
    )
    .limit(1)
    .get();
  if (anotherAct) return true;

  const anotherVenue = executor
    .select({ id: venues.id })
    .from(venues)
    .where(
      and(
        or(
          eq(venues.hostContactId, contactId),
          eq(venues.reachViaContactId, contactId),
        ),
        recordType === "venue" ? ne(venues.id, recordId) : undefined,
      ),
    )
    .limit(1)
    .get();
  return anotherVenue !== undefined;
}

function cloneContact(
  tx: CoreTransaction,
  contactId: number,
  expectedVersion: number,
  changes: ParticipantContactChanges,
  stamp: Date,
): Contact {
  // BEGIN IMMEDIATE serializes writers. Reading with both id and version is the
  // old-row CAS guard for the clone, while the target record update below has
  // its own affected-row CAS; any failure rolls the entire transaction back.
  const source = tx
    .select()
    .from(contacts)
    .where(
      and(eq(contacts.id, contactId), eq(contacts.version, expectedVersion)),
    )
    .get();
  if (!source) {
    throw new RecordConflictError("contact", contactId, Object.keys(changes));
  }
  return tx
    .insert(contacts)
    .values({
      seasonId: source.seasonId,
      name: changes.name ?? source.name,
      email: changes.email === undefined ? source.email : changes.email,
      phone: changes.phone === undefined ? source.phone : changes.phone,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .returning()
    .get();
}

function venueContactRepoint(
  executor: CoreExecutor,
  venueId: number,
  oldContactId: number,
  newContactId: number,
): Pick<Venue, "hostContactId" | "reachViaContactId"> {
  const venue = executor
    .select({
      hostContactId: venues.hostContactId,
      reachViaContactId: venues.reachViaContactId,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .get();
  if (!venue) throw unavailableRecord();
  return {
    hostContactId:
      venue.hostContactId === oldContactId ? newContactId : venue.hostContactId,
    reachViaContactId:
      venue.reachViaContactId === oldContactId
        ? newContactId
        : venue.reachViaContactId,
  };
}

function repointActiveLinks(
  tx: CoreTransaction,
  grant: ParticipantGrant,
  contactId: number,
  stamp: Date,
): void {
  tx.update(participantMagicLinks)
    .set({
      contactId,
      version: sql`${participantMagicLinks.version} + 1`,
      updatedAt: stamp,
    })
    .where(
      and(
        eq(participantMagicLinks.recordType, grant.recordType),
        eq(participantMagicLinks.recordId, grant.recordId),
        eq(participantMagicLinks.contactId, grant.contactId),
        isNotNull(participantMagicLinks.activatedAt),
        isNull(participantMagicLinks.revokedAt),
      ),
    )
    .run();
}

function validateSelections(
  input: Extract<ParticipantEditInput, { recordType: "venue" }>,
): ValidatedVenueSelections {
  return {
    gear: enumSet("gear", input.gear, venueGearValues),
    drinks: enumSet("drinks", input.drinks, venueDrinkValues),
    amenities: enumSet("amenities", input.amenities, venueAmenityValues),
  };
}

function enumSet<const Value extends string>(
  label: string,
  values: readonly string[],
  allowed: readonly Value[],
): readonly Value[] {
  if (
    new Set(values).size !== values.length ||
    values.some((value) => !allowed.includes(value as Value))
  ) {
    throw new ParticipantTokenError(
      "unavailable",
      `participant ${label} selection is invalid`,
    );
  }
  return values as readonly Value[];
}

interface ValidatedVenueSelections {
  readonly gear: readonly VenueGear["value"][];
  readonly drinks: readonly VenueDrink["value"][];
  readonly amenities: readonly VenueAmenity["value"][];
}

function replaceVenueSelections(
  tx: CoreTransaction,
  venue: Venue,
  input: ValidatedVenueSelections,
): void {
  tx.delete(venueGear).where(eq(venueGear.venueId, venue.id)).run();
  tx.delete(venueDrinks).where(eq(venueDrinks.venueId, venue.id)).run();
  tx.delete(venueAmenities).where(eq(venueAmenities.venueId, venue.id)).run();
  const stamp = venue.updatedAt;
  if (input.gear.length > 0) {
    tx.insert(venueGear)
      .values(
        input.gear.map((value) => ({
          seasonId: venue.seasonId,
          venueId: venue.id,
          value,
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .run();
  }
  if (input.drinks.length > 0) {
    tx.insert(venueDrinks)
      .values(
        input.drinks.map((value) => ({
          seasonId: venue.seasonId,
          venueId: venue.id,
          value,
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .run();
  }
  if (input.amenities.length > 0) {
    tx.insert(venueAmenities)
      .values(
        input.amenities.map((value) => ({
          seasonId: venue.seasonId,
          venueId: venue.id,
          value,
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .run();
  }
}

export type ParticipantTokenRepository = ReturnType<
  typeof createParticipantTokenRepository
>;
