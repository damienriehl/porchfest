// Organizer access (R9). Auth that depends on no cloud vendor's access product:
// a bootstrap link printed to the container log opens the first account, and
// organizers invite each other with links that work whether or not an email
// provider is configured.
//
// Every credential in here is a bearer token to the whole contact database, so
// KTD8 governs: high entropy, stored only as a hash, short expiry, consumed
// atomically once, audited on redemption.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  organizerInvites,
  organizerSessions,
  organizers,
  type Organizer,
  type OrganizerInvite,
  type OrganizerInviteKind,
} from "./storage/schema.js";
import type { CoreExecutor } from "./storage/repository-errors.js";

/** 32 bytes of CSPRNG output. The token is returned to the caller exactly once
 *  and never persisted in the clear. */
const TOKEN_BYTES = 32;

export const DEFAULT_BOOTSTRAP_TTL_MS = 60 * 60_000; // one hour
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60_000; // one week
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60_000;
export const DEFAULT_SESSION_IDLE_TTL_MS = 12 * 60 * 60_000;

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly reason: AccessFailure;

  constructor(reason: AccessFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export type AccessFailure =
  | "already-bootstrapped"
  | "invalid-token"
  | "expired"
  | "already-redeemed"
  | "revoked"
  | "deactivated"
  | "duplicate-email";

export interface AccessRepositoryOptions {
  readonly now?: () => Date;
  readonly createToken?: () => string;
  readonly bootstrapTtlMs?: number;
  readonly inviteTtlMs?: number;
  readonly sessionAbsoluteTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
}

export interface IssuedLink {
  /** Shown to a human exactly once; never recoverable afterwards. */
  readonly token: string;
  readonly invite: OrganizerInvite;
}

export interface IssuedSession {
  readonly token: string;
  readonly organizer: Organizer;
  readonly expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hex digests without leaking their difference through timing.
 * Lookup is by hash equality in SQL, which is not constant time; this is used
 * where a value is compared in application code.
 */
export function tokenHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAccessRepository(
  db: CoreExecutor,
  options: AccessRepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const createToken =
    options.createToken ??
    (() => randomBytes(TOKEN_BYTES).toString("base64url"));
  const bootstrapTtlMs = options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
  const inviteTtlMs = options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
  const sessionAbsoluteTtlMs =
    options.sessionAbsoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS;
  const sessionIdleTtlMs =
    options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;

  function mutable() {
    const stamp = now();
    return { version: 1, createdAt: stamp, updatedAt: stamp };
  }

  function countActiveOrganizers(): number {
    const row = db
      .select({ total: sql<number>`count(*)` })
      .from(organizers)
      .where(isNull(organizers.deactivatedAt))
      .get();
    return row?.total ?? 0;
  }

  function hasAnyOrganizer(): boolean {
    const row = db
      .select({ total: sql<number>`count(*)` })
      .from(organizers)
      .get();
    return (row?.total ?? 0) > 0;
  }

  /**
   * Mint the first-boot login link. Refused once any organizer exists — including
   * a deactivated one — so a bootstrap link can never be a back door around
   * deactivation.
   */
  function issueBootstrapLink(): IssuedLink {
    if (hasAnyOrganizer()) {
      throw new AccessError(
        "already-bootstrapped",
        "an organizer already exists, so a bootstrap link cannot be issued",
      );
    }
    return issueLink({
      kind: "bootstrap",
      email: null,
      invitedBy: null,
      ttlMs: bootstrapTtlMs,
    });
  }

  function issueInvite(
    email: string,
    invitedByOrganizerId: number,
  ): IssuedLink {
    return issueLink({
      kind: "invite",
      email: email.trim().toLowerCase(),
      invitedBy: invitedByOrganizerId,
      ttlMs: inviteTtlMs,
    });
  }

  function issueLink(input: {
    kind: OrganizerInviteKind;
    email: string | null;
    invitedBy: number | null;
    ttlMs: number;
  }): IssuedLink {
    const token = createToken();
    const invite = db
      .insert(organizerInvites)
      .values({
        kind: input.kind,
        tokenHash: hashToken(token),
        email: input.email,
        invitedByOrganizerId: input.invitedBy,
        expiresAt: new Date(now().valueOf() + input.ttlMs),
        ...mutable(),
      })
      .returning()
      .get();
    return { token, invite };
  }

  /**
   * Consume a link and produce the organizer it authorizes.
   *
   * The claim is a single UPDATE whose predicate carries every precondition and
   * whose verdict is the affected-row count — KTD7's shape, chosen here because
   * two browsers redeeming the same link at the same instant is exactly the race
   * a SELECT-then-UPDATE would lose. Only the winner sees `changes === 1`.
   */
  function redeemLink(input: {
    token: string;
    displayName: string;
    email?: string;
    fromIp?: string | null;
  }): IssuedSession {
    const stamp = now();
    const tokenHash = hashToken(input.token);

    const claimed = db
      .update(organizerInvites)
      .set({
        redeemedAt: stamp,
        redeemedFromIp: input.fromIp ?? null,
        version: sql`${organizerInvites.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(organizerInvites.tokenHash, tokenHash),
          isNull(organizerInvites.redeemedAt),
          isNull(organizerInvites.revokedAt),
          sql`${organizerInvites.expiresAt} > ${Math.floor(stamp.valueOf() / 1000)}`,
        ),
      )
      .run();

    if (claimed.changes !== 1) throw describeRefusal(tokenHash, stamp);

    const invite = db
      .select()
      .from(organizerInvites)
      .where(eq(organizerInvites.tokenHash, tokenHash))
      .get();
    if (!invite)
      throw new AccessError("invalid-token", "link is not recognized");

    const email = (invite.email ?? input.email ?? "").trim().toLowerCase();
    if (!email) {
      throw new AccessError(
        "invalid-token",
        "an email address is required to redeem this link",
      );
    }

    const organizer = upsertOrganizer(email, input.displayName, stamp);
    db.update(organizerInvites)
      .set({ redeemedByOrganizerId: organizer.id, updatedAt: stamp })
      .where(eq(organizerInvites.id, invite.id))
      .run();

    // The moment a real organizer exists, every outstanding bootstrap link is
    // dead — otherwise a second copy of that log line is a second admin account.
    if (invite.kind === "bootstrap") revokeOutstandingBootstrapLinks(stamp);

    return { ...startSession(organizer, stamp), organizer };
  }

  /** Turn a refused claim into the specific reason, for an honest message. */
  function describeRefusal(tokenHash: string, stamp: Date): AccessError {
    const invite = db
      .select()
      .from(organizerInvites)
      .where(eq(organizerInvites.tokenHash, tokenHash))
      .get();
    if (!invite)
      return new AccessError("invalid-token", "link is not recognized");
    if (invite.revokedAt)
      return new AccessError("revoked", "link was withdrawn");
    if (invite.redeemedAt)
      return new AccessError("already-redeemed", "link was already used");
    return new AccessError("expired", "link has expired");
  }

  function revokeOutstandingBootstrapLinks(stamp: Date): void {
    db.update(organizerInvites)
      .set({ revokedAt: stamp, updatedAt: stamp })
      .where(
        and(
          eq(organizerInvites.kind, "bootstrap"),
          isNull(organizerInvites.redeemedAt),
          isNull(organizerInvites.revokedAt),
        ),
      )
      .run();
  }

  function upsertOrganizer(
    email: string,
    displayName: string,
    stamp: Date,
  ): Organizer {
    const existing = db
      .select()
      .from(organizers)
      .where(eq(organizers.email, email))
      .get();
    if (existing) {
      if (existing.deactivatedAt) {
        throw new AccessError(
          "deactivated",
          "that organizer account is deactivated",
        );
      }
      return existing;
    }
    return db
      .insert(organizers)
      .values({ email, displayName: displayName.trim() || email, ...mutable() })
      .returning()
      .get();
  }

  function startSession(organizer: Organizer, stamp: Date): IssuedSession {
    const token = createToken();
    const expiresAt = new Date(stamp.valueOf() + sessionAbsoluteTtlMs);
    db.insert(organizerSessions)
      .values({
        organizerId: organizer.id,
        tokenHash: hashToken(token),
        expiresAt,
        idleExpiresAt: new Date(stamp.valueOf() + sessionIdleTtlMs),
        ...mutable(),
      })
      .run();
    return { token, organizer, expiresAt };
  }

  /**
   * Resolve a session cookie to its organizer, sliding the idle window.
   *
   * Deactivation is checked on every request rather than at sign-in, which is
   * what makes "a deactivated organizer's existing session is refused on its
   * next request" true without hunting down their session rows.
   */
  function resolveSession(token: string | null | undefined): Organizer | null {
    if (!token) return null;
    const stamp = now();
    const seconds = Math.floor(stamp.valueOf() / 1000);

    const row = db
      .select({ session: organizerSessions, organizer: organizers })
      .from(organizerSessions)
      .innerJoin(organizers, eq(organizers.id, organizerSessions.organizerId))
      .where(eq(organizerSessions.tokenHash, hashToken(token)))
      .get();
    if (!row) return null;

    const { session, organizer } = row;
    if (session.revokedAt) return null;
    if (organizer.deactivatedAt) return null;
    if (session.expiresAt.valueOf() / 1000 <= seconds) return null;
    if (session.idleExpiresAt.valueOf() / 1000 <= seconds) return null;

    db.update(organizerSessions)
      .set({
        idleExpiresAt: new Date(stamp.valueOf() + sessionIdleTtlMs),
        updatedAt: stamp,
      })
      .where(eq(organizerSessions.id, session.id))
      .run();
    db.update(organizers)
      .set({ lastSeenAt: stamp })
      .where(eq(organizers.id, organizer.id))
      .run();

    return organizer;
  }

  function endSession(token: string | null | undefined): void {
    if (!token) return;
    const stamp = now();
    db.update(organizerSessions)
      .set({ revokedAt: stamp, updatedAt: stamp })
      .where(eq(organizerSessions.tokenHash, hashToken(token)))
      .run();
  }

  /**
   * Deactivate an organizer and cut off everything they hold in the same
   * transaction: sessions revoked, outstanding invites they issued withdrawn.
   */
  function deactivateOrganizer(organizerId: number): Organizer {
    const stamp = now();
    const result = db
      .update(organizers)
      .set({
        deactivatedAt: stamp,
        version: sql`${organizers.version} + 1`,
        updatedAt: stamp,
      })
      .where(
        and(eq(organizers.id, organizerId), isNull(organizers.deactivatedAt)),
      )
      .run();
    if (result.changes !== 1) {
      throw new AccessError(
        "deactivated",
        "that organizer is already deactivated",
      );
    }

    db.update(organizerSessions)
      .set({ revokedAt: stamp, updatedAt: stamp })
      .where(
        and(
          eq(organizerSessions.organizerId, organizerId),
          isNull(organizerSessions.revokedAt),
        ),
      )
      .run();
    db.update(organizerInvites)
      .set({ revokedAt: stamp, updatedAt: stamp })
      .where(
        and(
          eq(organizerInvites.invitedByOrganizerId, organizerId),
          isNull(organizerInvites.redeemedAt),
          isNull(organizerInvites.revokedAt),
        ),
      )
      .run();

    const organizer = db
      .select()
      .from(organizers)
      .where(eq(organizers.id, organizerId))
      .get();
    if (!organizer)
      throw new AccessError("invalid-token", "organizer disappeared");
    return organizer;
  }

  function listOrganizers(): Organizer[] {
    return db.select().from(organizers).orderBy(organizers.id).all();
  }

  return Object.freeze({
    countActiveOrganizers,
    hasAnyOrganizer,
    issueBootstrapLink,
    issueInvite,
    redeemLink,
    resolveSession,
    endSession,
    deactivateOrganizer,
    listOrganizers,
  });
}

export type AccessRepository = ReturnType<typeof createAccessRepository>;
