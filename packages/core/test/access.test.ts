// R9's access rules, against a real SQLite file with a pinned clock. Every test
// here is a named killer for a guard whose failure is silent — a link that can be
// used twice, a session that outlives a deactivation — because none of those
// announce themselves at runtime.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AccessError,
  createAccessRepository,
  hashToken,
} from "../src/access.js";
import { organizerInvites, organizerSessions } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

let database: TestDatabase;
let clock = new Date("2027-03-01T12:00:00.000Z");
let tokenCounter = 0;

beforeEach(async () => {
  database = await openTestDatabase("porchfest-access-");
  clock = new Date("2027-03-01T12:00:00.000Z");
  tokenCounter = 0;
});

afterEach(async () => {
  await database.close();
});

function repository(
  options: Parameters<typeof createAccessRepository>[1] = {},
) {
  return createAccessRepository(database.db, {
    now: () => clock,
    // Deterministic tokens keep the assertions readable; entropy is the
    // production default's job and is asserted separately below.
    createToken: () => `token-${(tokenCounter += 1)}`,
    ...options,
  });
}

function advance(ms: number) {
  clock = new Date(clock.valueOf() + ms);
}

describe("bootstrap link", () => {
  it("opens the first organizer account and starts a session", () => {
    const access = repository();
    const { token } = access.issueBootstrapLink();

    const session = access.redeemLink({
      token,
      displayName: "First Organizer",
      email: "first@example.invalid",
    });

    expect(session.organizer.email).toBe("first@example.invalid");
    expect(access.resolveSession(session.token)?.id).toBe(session.organizer.id);
  });

  it("refuses a second bootstrap link once an organizer exists", () => {
    const access = repository();
    const { token } = access.issueBootstrapLink();
    access.redeemLink({
      token,
      displayName: "First",
      email: "first@example.invalid",
    });

    expect(() => access.issueBootstrapLink()).toThrowError(AccessError);
  });

  it("kills every outstanding bootstrap link the moment the first organizer exists", () => {
    const access = repository();
    // A container that restarted twice printed the line twice. The second copy
    // must not still be a working admin account.
    const first = access.issueBootstrapLink();
    const second = access.issueBootstrapLink();

    access.redeemLink({
      token: first.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    expect(() =>
      access.redeemLink({
        token: second.token,
        displayName: "Interloper",
        email: "interloper@example.invalid",
      }),
    ).toThrowError(/withdrawn/);
  });
});

describe("single-use redemption", () => {
  it("refuses a replayed link", () => {
    const access = repository();
    const { token } = access.issueBootstrapLink();
    access.redeemLink({
      token,
      displayName: "First",
      email: "first@example.invalid",
    });

    expect(() =>
      access.redeemLink({
        token,
        displayName: "Again",
        email: "first@example.invalid",
      }),
    ).toThrowError(/already used/);
  });

  it("refuses an expired link", () => {
    const access = repository({ bootstrapTtlMs: 60_000 });
    const { token } = access.issueBootstrapLink();
    advance(60_001);

    expect(() =>
      access.redeemLink({
        token,
        displayName: "Late",
        email: "late@example.invalid",
      }),
    ).toThrowError(/expired/);
  });

  it("lets exactly one of two redemptions of the same link win", () => {
    const access = repository();
    const { token } = access.issueBootstrapLink();

    // better-sqlite3 is synchronous, so these run in sequence rather than truly
    // in parallel — this proves the claim is atomic and single-use, not that two
    // OS threads race. The mechanism is what makes the real race safe: one
    // UPDATE carrying every precondition, verdict from the affected-row count.
    // A SELECT-then-UPDATE would pass this test and still lose the real race,
    // which is why the predicate must stay inside the statement.
    const outcomes = [
      tryRedeem(() =>
        access.redeemLink({
          token,
          displayName: "A",
          email: "a@example.invalid",
        }),
      ),
      tryRedeem(() =>
        access.redeemLink({
          token,
          displayName: "B",
          email: "b@example.invalid",
        }),
      ),
    ];

    expect(outcomes.filter((ok) => ok)).toHaveLength(1);
  });

  it("refuses a token that was never issued", () => {
    const access = repository();
    access.issueBootstrapLink();

    expect(() =>
      access.redeemLink({
        token: "not-a-real-token",
        displayName: "Nobody",
        email: "nobody@example.invalid",
      }),
    ).toThrowError(/not recognized/);
  });
});

function tryRedeem(action: () => unknown): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

describe("invites", () => {
  it("lets an unbound invite collect its email at redemption", () => {
    const access = repository();
    const first = access.redeemLink({
      token: access.issueBootstrapLink().token,
      displayName: "First",
      email: "first@example.invalid",
    });
    const invite = access.issueInvite(null, first.organizer.id);

    expect(access.linkRequiresEmail(invite.token)).toBe(true);
    expect(() =>
      access.redeemLink({ token: invite.token, displayName: "Second" }),
    ).toThrowError("an email address is required");
    const second = access.redeemLink({
      token: invite.token,
      displayName: "Second",
      email: "second@example.invalid",
    });

    expect(second.organizer.email).toBe("second@example.invalid");
  });

  it("lets an organizer invite a second one who can then sign in", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    const invite = access.issueInvite(
      "second@example.invalid",
      first.organizer.id,
    );
    const second = access.redeemLink({
      token: invite.token,
      displayName: "Second",
    });

    expect(second.organizer.email).toBe("second@example.invalid");
    expect(access.countActiveOrganizers()).toBe(2);
  });

  it("binds the invite to the address it was sent to", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });
    const invite = access.issueInvite(
      "second@example.invalid",
      first.organizer.id,
    );

    // Whoever opens the link becomes the invited address, not an address they
    // chose: otherwise a forwarded invite silently creates a different account.
    const redeemed = access.redeemLink({
      token: invite.token,
      displayName: "Impostor",
      email: "impostor@example.invalid",
    });

    expect(redeemed.organizer.email).toBe("second@example.invalid");
  });
});

describe("deactivation", () => {
  it("refuses a deactivated organizer's existing session on its next request", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });
    const invite = access.issueInvite(
      "second@example.invalid",
      first.organizer.id,
    );
    const second = access.redeemLink({
      token: invite.token,
      displayName: "Second",
    });
    expect(access.resolveSession(second.token)).not.toBeNull();

    access.deactivateOrganizer(second.organizer.id);

    // Checked per request rather than at sign-in, so no session hunt is needed.
    expect(access.resolveSession(second.token)).toBeNull();
  });

  it("withdraws the invites a deactivated organizer had outstanding", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });
    const pending = access.issueInvite(
      "third@example.invalid",
      first.organizer.id,
    );

    access.deactivateOrganizer(first.organizer.id);

    expect(() =>
      access.redeemLink({ token: pending.token, displayName: "Third" }),
    ).toThrowError(/withdrawn/);
  });

  it("refuses to reactivate by redeeming a fresh invite", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });
    const invite = access.issueInvite(
      "second@example.invalid",
      first.organizer.id,
    );
    const second = access.redeemLink({
      token: invite.token,
      displayName: "Second",
    });
    access.deactivateOrganizer(second.organizer.id);

    const reinvite = access.issueInvite(
      "second@example.invalid",
      first.organizer.id,
    );

    expect(() =>
      access.redeemLink({ token: reinvite.token, displayName: "Second" }),
    ).toThrowError(/deactivated/);
  });

  it("refuses to deactivate the same organizer twice", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const first = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });
    access.deactivateOrganizer(first.organizer.id);

    expect(() => access.deactivateOrganizer(first.organizer.id)).toThrowError(
      AccessError,
    );
  });
});

describe("sessions", () => {
  it("expires at the absolute bound however active the organizer is", () => {
    const access = repository({
      sessionAbsoluteTtlMs: 10_000,
      sessionIdleTtlMs: 5_000,
    });
    const bootstrap = access.issueBootstrapLink();
    const session = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    advance(4_000);
    expect(access.resolveSession(session.token)).not.toBeNull(); // slides idle
    advance(4_000);
    expect(access.resolveSession(session.token)).not.toBeNull();
    advance(4_000);

    // Idle was refreshed twice, so only the absolute bound can end this.
    expect(access.resolveSession(session.token)).toBeNull();
  });

  it("expires an idle session before its absolute bound", () => {
    const access = repository({
      sessionAbsoluteTtlMs: 1_000_000,
      sessionIdleTtlMs: 5_000,
    });
    const bootstrap = access.issueBootstrapLink();
    const session = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    advance(5_001);

    expect(access.resolveSession(session.token)).toBeNull();
  });

  it("refuses a signed-out session token", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const session = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    access.endSession(session.token);

    expect(access.resolveSession(session.token)).toBeNull();
  });

  it("refuses an absent or unknown token without throwing", () => {
    const access = repository();
    expect(access.resolveSession(null)).toBeNull();
    expect(access.resolveSession("")).toBeNull();
    expect(access.resolveSession("nonsense")).toBeNull();
  });
});

describe("credentials at rest", () => {
  it("stores no link or session token in the clear", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const session = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
    });

    const invites = database.db.select().from(organizerInvites).all();
    const sessions = database.db.select().from(organizerSessions).all();

    // A leaked backup must not be a leaked login.
    expect(invites.map((row) => row.tokenHash)).not.toContain(bootstrap.token);
    expect(invites[0]?.tokenHash).toBe(hashToken(bootstrap.token));
    expect(sessions.map((row) => row.tokenHash)).not.toContain(session.token);
    expect(sessions[0]?.tokenHash).toBe(hashToken(session.token));
  });

  it("records who redeemed a link and from where", () => {
    const access = repository();
    const bootstrap = access.issueBootstrapLink();
    const session = access.redeemLink({
      token: bootstrap.token,
      displayName: "First",
      email: "first@example.invalid",
      fromIp: "198.51.100.7",
    });

    const invite = database.db.select().from(organizerInvites).get();
    expect(invite?.redeemedByOrganizerId).toBe(session.organizer.id);
    expect(invite?.redeemedFromIp).toBe("198.51.100.7");
    expect(invite?.redeemedAt).not.toBeNull();
  });

  it("mints high-entropy tokens by default", () => {
    // The deterministic tokens above are a test convenience; the production
    // default must be unguessable.
    const access = createAccessRepository(database.db, { now: () => clock });
    const { token } = access.issueBootstrapLink();

    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(new Set(token).size).toBeGreaterThan(10);
  });
});
