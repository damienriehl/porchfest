import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createAccessRepository,
  hashToken,
  tokenHashesMatch,
} from "../src/access.js";
import {
  organizerInvites,
  organizerSessions,
  organizers,
} from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

describe("access persisted lifecycle boundaries", () => {
  let database: TestDatabase;
  let stamp: Date;
  let access: ReturnType<typeof createAccessRepository>;
  beforeEach(async () => {
    database = await openTestDatabase("access-lifecycle-");
    stamp = new Date("2030-01-01T00:00:00Z");
    let sequence = 0;
    access = createAccessRepository(database.db, {
      now: () => stamp,
      createToken: () => `synthetic-access-${++sequence}`,
      bootstrapTtlMs: 10000,
      inviteTtlMs: 10000,
      sessionIdleTtlMs: 10000,
      sessionAbsoluteTtlMs: 30000,
    });
  });
  afterEach(async () => {
    await database.close();
  });
  const bootstrap = () =>
    access.redeemLink({
      token: access.issueBootstrapLink().token,
      email: " Owner@Example.invalid ",
      displayName: " Owner ",
    });
  it("compares hashes of identical, different and differently sized tokens", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(tokenHashesMatch(hashToken("abc"), hashToken("abc"))).toBe(true);
    expect(tokenHashesMatch(hashToken("abc"), hashToken("abcd"))).toBe(false);
    expect(tokenHashesMatch(hashToken("abc"), "short")).toBe(false);
  });
  it("missing email does not consume a link, and blank display names fall back to normalized email", () => {
    const link = access.issueBootstrapLink();
    expect(access.linkRequiresEmail(link.token)).toBe(true);
    expect(() =>
      access.redeemLink({ token: link.token, displayName: " ", email: " \t " }),
    ).toThrow("email address is required");
    expect(
      database.db.select().from(organizerInvites).get()?.redeemedAt,
    ).toBeNull();
    const session = access.redeemLink({
      token: link.token,
      displayName: " ",
      email: " User@Example.invalid ",
    });
    expect(session.organizer).toMatchObject({
      email: "user@example.invalid",
      displayName: "user@example.invalid",
    });
    expect(access.linkRequiresEmail(link.token)).toBe(false);
  });
  it("normalizes whitespace-only invite email into an unbound invite and stops asking at expiry", () => {
    const owner = bootstrap();
    const link = access.issueInvite(" \t ", owner.organizer.id);
    expect(link.invite.email).toBeNull();
    expect(access.linkRequiresEmail(link.token)).toBe(true);
    stamp = new Date(stamp.valueOf() + 10000);
    expect(access.linkRequiresEmail(link.token)).toBe(false);
    expect(() =>
      access.redeemLink({
        token: link.token,
        displayName: "Late",
        email: "late@example.invalid",
      }),
    ).toThrow("expired");
    expect(access.linkRequiresEmail("unknown")).toBe(false);
  });
  it("reinviting an active organizer creates another session without changing identity or display name", () => {
    const first = bootstrap();
    const invite = access.issueInvite(
      " OWNER@example.invalid ",
      first.organizer.id,
    );
    expect(access.linkRequiresEmail(invite.token)).toBe(false);
    const second = access.redeemLink({
      token: invite.token,
      displayName: "Replacement",
    });
    expect(second.organizer).toEqual(first.organizer);
    expect(access.listOrganizers()).toHaveLength(1);
    expect(database.db.select().from(organizerSessions).all()).toHaveLength(2);
    access.endSession(first.token);
    expect(access.resolveSession(first.token)).toBeNull();
    expect(access.resolveSession(second.token)?.id).toBe(first.organizer.id);
  });
  it("persists idle sliding and last-seen time, but refuses exactly at the absolute expiry", () => {
    const session = bootstrap();
    const initial = stamp.valueOf();
    for (const elapsed of [9000, 18000, 27000]) {
      stamp = new Date(initial + elapsed);
      expect(access.resolveSession(session.token)?.id).toBe(
        session.organizer.id,
      );
      expect(
        database.db.select().from(organizerSessions).get()?.idleExpiresAt,
      ).toEqual(new Date(initial + elapsed + 10000));
      expect(database.db.select().from(organizers).get()?.lastSeenAt).toEqual(
        stamp,
      );
    }
    stamp = new Date(initial + 30000);
    expect(access.resolveSession(session.token)).toBeNull();
    expect(database.db.select().from(organizers).get()?.lastSeenAt).toEqual(
      new Date(initial + 27000),
    );
  });
  it("refuses exactly at idle expiry without sliding or updating last-seen", () => {
    const session = bootstrap();
    const before = database.db.select().from(organizerSessions).get();
    stamp = new Date(stamp.valueOf() + 10000);
    expect(access.resolveSession(session.token)).toBeNull();
    expect(database.db.select().from(organizerSessions).get()).toEqual(before);
    expect(database.db.select().from(organizers).get()?.lastSeenAt).toBeNull();
  });
  it("empty and unknown sign-outs do not alter an unrelated active session", () => {
    const session = bootstrap();
    const before = database.db.select().from(organizerSessions).all();
    for (const token of [null, undefined, "", "unknown"])
      access.endSession(token);
    expect(database.db.select().from(organizerSessions).all()).toEqual(before);
    expect(access.resolveSession(session.token)?.id).toBe(session.organizer.id);
  });
  it("deactivation preserves another organizer and historical invite redemption while revoking every owned session", () => {
    const owner = bootstrap();
    const used = access.issueInvite(
      "second@example.invalid",
      owner.organizer.id,
    );
    const second = access.redeemLink({
      token: used.token,
      displayName: "Second",
    });
    const self = access.redeemLink({
      token: access.issueInvite("owner@example.invalid", owner.organizer.id)
        .token,
      displayName: "Owner",
    });
    const pending = access.issueInvite(null, owner.organizer.id);
    expect(access.countActiveOrganizers()).toBe(2);
    access.deactivateOrganizer(owner.organizer.id);
    expect(access.countActiveOrganizers()).toBe(1);
    expect(access.hasAnyOrganizer()).toBe(true);
    expect(access.listOrganizers().map((row) => row.id)).toEqual([
      owner.organizer.id,
      second.organizer.id,
    ]);
    expect(access.resolveSession(owner.token)).toBeNull();
    expect(access.resolveSession(self.token)).toBeNull();
    expect(access.resolveSession(second.token)?.id).toBe(second.organizer.id);
    expect(access.linkRequiresEmail(pending.token)).toBe(false);
    expect(
      database.db
        .select()
        .from(organizerInvites)
        .where(eq(organizerInvites.id, used.invite.id))
        .get(),
    ).toMatchObject({
      revokedAt: null,
      redeemedByOrganizerId: second.organizer.id,
    });
  });
  it("an empty active roster after deactivation still cannot issue a new bootstrap", () => {
    expect(access.countActiveOrganizers()).toBe(0);
    expect(access.hasAnyOrganizer()).toBe(false);
    expect(access.listOrganizers()).toEqual([]);
    const owner = bootstrap();
    access.deactivateOrganizer(owner.organizer.id);
    expect(access.countActiveOrganizers()).toBe(0);
    expect(access.hasAnyOrganizer()).toBe(true);
    expect(() => access.issueBootstrapLink()).toThrow("already exists");
    expect(() => access.deactivateOrganizer(999)).toThrow(
      "already deactivated",
    );
  });
});
