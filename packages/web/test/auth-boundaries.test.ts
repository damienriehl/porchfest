import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import {
  createTrustAuthorizer,
  currentParticipant,
  readParticipantToken,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeParticipantCookie,
} from "../src/auth.js";

const roots: string[] = [];
const runtimes: PorchfestRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function boot() {
  const root = await mkdtemp(join(tmpdir(), "porchfest-auth-boundaries-"));
  roots.push(root);
  const runtime = await createRuntime({
    dataDirectory: root,
    env: {
      PORCHFEST_SESSION_SECRET: "synthetic-auth-boundary-secret",
      PUBLIC_BASE_URL: "https://example.invalid",
      PORCHFEST_SMTP_HOST: "smtp.example.invalid",
      PORCHFEST_SMTP_FROM: "synthetic@example.invalid",
    },
    announce: () => undefined,
  });
  runtimes.push(runtime);
  return runtime;
}
function participant(runtime: PorchfestRuntime) {
  const { season } = runtime.core.setup.createSeason({
    year: 2032,
    displayName: "Synthetic",
    timezone: "UTC",
    eventDate: "2032-09-12",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: [],
    openSignups: true,
  });
  return runtime.core.seasons.createPerformerSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic",
      email: "synthetic@example.invalid",
      phone: null,
    },
    act: {
      name: "Synthetic Act",
      genre: "folk",
      description: "Synthetic",
      links: "",
      durationMinutes: 30,
      requiresAmplification: false,
      housePreference: null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [],
  });
}

describe("auth request boundaries", () => {
  it.each([
    ["broken; other=x; porchfest_session = abc=def ; tail=x", "abc=def"],
    ["porchfest_session= ; porchfest_session=second", null],
    ["prefix_porchfest_session=x; other=y", null],
    ["porchfest_session=first; porchfest_session=second", "first"],
  ])("reads session cookies exactly from %s", async (cookie, expected) => {
    const app = new Hono();
    app.get("/", (context) =>
      context.json({ token: readSessionCookie(context) }),
    );
    expect(
      await (await app.request("/", { headers: { cookie } })).json(),
    ).toEqual({ token: expected });
  });
  it.each([
    ["?token=%20query%20", "query"],
    ["?token=%20", "cookie"],
    ["", "cookie"],
  ])("selects participant bearer from %s", async (query, expected) => {
    const app = new Hono();
    app.get("/", (context) =>
      context.json({ token: readParticipantToken(context) }),
    );
    expect(
      await (
        await app.request(`/${query}`, {
          headers: { cookie: "porchfest_participant=cookie" },
        })
      ).json(),
    ).toEqual({ token: expected });
  });
  it("scopes participant cookies and allows explicit local HTTP serialization", () => {
    const cookie = serializeParticipantCookie(
      "synthetic-token",
      new Date("2032-09-12T00:00:00Z"),
      { secure: false },
    );
    expect(cookie).toBe(
      "porchfest_participant=synthetic-token; Path=/self-serve; HttpOnly; SameSite=Lax; Expires=Sun, 12 Sep 2032 00:00:00 GMT",
    );
    expect(serializeExpiredSessionCookie({ secure: false })).toBe(
      "porchfest_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );
  });
  it("caches a real resolved grant only for its request, then observes database revocation", async () => {
    const runtime = await boot();
    const signup = participant(runtime);
    const issued = runtime.core.participantTokens.issue("act", signup.act.id);
    const app = new Hono();
    let replacement = "";
    app.get("/", (context) => {
      const first = currentParticipant(runtime.core, context);
      if (first)
        replacement = runtime.core.participantTokens.issue(
          "act",
          signup.act.id,
        ).token;
      const second = currentParticipant(runtime.core, context);
      return context.json({ first, second, same: first === second });
    });
    const response = await app.request(`/?token=${issued.token}`);
    expect(await response.json()).toMatchObject({
      first: { recordId: signup.act.id },
      second: { recordId: signup.act.id },
      same: true,
    });
    expect(await (await app.request(`/?token=${issued.token}`)).json()).toEqual(
      { first: null, second: null, same: true },
    );
    expect(runtime.core.participantTokens.resolve(replacement).recordId).toBe(
      signup.act.id,
    );
  });
  it("does not fall back to a valid cookie when an explicit query bearer is invalid", async () => {
    const runtime = await boot();
    const signup = participant(runtime);
    const issued = runtime.core.participantTokens.issue("act", signup.act.id);
    const app = new Hono();
    const authorize = createTrustAuthorizer(runtime.core);
    app.get("/", (context) =>
      context.json({
        participant: authorize("participant", context),
        organizer: authorize("organizer", context),
        public: authorize("public", context),
      }),
    );
    const headers = { cookie: `porchfest_participant=${issued.token}` };
    expect(
      await (await app.request("/?token=invalid", { headers })).json(),
    ).toEqual({ participant: false, organizer: false, public: false });
    expect(await (await app.request("/", { headers })).json()).toEqual({
      participant: true,
      organizer: false,
      public: false,
    });
    expect(await (await app.request("/")).json()).toEqual({
      participant: false,
      organizer: false,
      public: false,
    });
  });
});
