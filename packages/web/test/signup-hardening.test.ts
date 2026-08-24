// Regression suite for the U4 review. Every test here is a named killer for a
// guard whose failure is otherwise silent: delete the guard and one of these
// fails by name. The original suite passed while all of these were broken, which
// is the whole reason docs/solutions/conventions/mutation-testing-for-silent-
// guard-failures.md exists.
import {
  type AntibotPort,
  type AntibotRequest,
  type AntibotResult,
  type SeasonState,
} from "@porchfest/core";
import { PerIpRateLimiter } from "@porchfest/antibot";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
  type PorchfestTestingRuntime,
} from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const CHICAGO = "America/Chicago";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class AlwaysPassingAntibot implements AntibotPort {
  readonly name = "always-passing";
  readonly configured = true;
  readonly clientChallenge = {
    scriptUrl: "https://challenge.example/api.js",
    mountTag: "div",
    mountAttributes: { class: "challenge", "data-sitekey": "site-key" },
    responseFieldName: "antibot_token",
    label: "Verification",
    contentSecurityPolicy: {
      scriptSrc: ["https://challenge.example"],
      frameSrc: ["https://challenge.example"],
      connectSrc: ["https://challenge.example"],
    },
  } as const;

  async verify(_request: AntibotRequest): Promise<AntibotResult> {
    return { status: "passed" as const };
  }
}

/** Passes each token exactly once, the way a real single-use provider does. */
class SingleUseAntibot extends AlwaysPassingAntibot {
  readonly seen = new Set<string>();

  override async verify(request: AntibotRequest): Promise<AntibotResult> {
    const token = request.token ?? "";
    if (!token || this.seen.has(token)) {
      return { status: "failed" as const, reason: "already used" };
    }
    this.seen.add(token);
    return { status: "passed" as const };
  }
}

async function makeRuntime(
  options: {
    antibot?: AntibotPort;
    rateLimit?: number;
    timezone?: string;
    state?: SeasonState;
    socketPeer?: string | ((count: number) => string);
    trustedProxyHops?: string;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-harden-"));
  temporaryRoots.push(dataDirectory);
  let calls = 0;
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "hardening-test-session-secret",
      ...(options.trustedProxyHops === undefined
        ? {}
        : { PORCHFEST_TRUSTED_PROXY_HOPS: options.trustedProxyHops }),
    },
    adapterOverrides: options.antibot
      ? { antibot: options.antibot }
      : undefined,
    resolveSocketPeerAddress: () => {
      calls += 1;
      const peer = options.socketPeer ?? "192.0.2.44";
      return typeof peer === "function" ? peer(calls) : peer;
    },
    signupGuardOptions:
      options.rateLimit === undefined
        ? undefined
        : { limit: options.rateLimit, windowMs: 60_000 },
  });
  runtimes.push(runtime);

  const requestedState = options.state ?? "signups_open";
  const { season: createdSeason } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic 2031 Porchfest",
    timezone: options.timezone ?? "UTC",
    eventDate: "2031-06-01",
    timeSlots: [],
    openSignups: requestedState === "signups_open",
  });
  const season =
    requestedState === createdSeason.state
      ? createdSeason
      : runtime.core.seasons.transitionSeason(
          createdSeason.id,
          createdSeason.version,
          requestedState,
        );

  return { runtime, seasonId: season.id };
}

async function csrfToken(
  runtime: PorchfestRuntime,
  path: string,
  seasonId: number,
) {
  const response = await runtime.request(
    `${PUBLIC_BASE_URL}${path}?season=${seasonId}`,
  );
  const html = await response.text();
  return {
    status: response.status,
    html,
    headers: response.headers,
    token: html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "",
  };
}

function submit(
  runtime: PorchfestRuntime,
  path: string,
  body: URLSearchParams,
  options: { contentType?: string; forwardedFor?: string } = {},
) {
  const headers: Record<string, string> = {
    origin: PUBLIC_BASE_URL,
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
  };
  if (options.forwardedFor) headers["x-forwarded-for"] = options.forwardedFor;
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body,
  });
}

function hostBody(seasonId: number, csrf: string) {
  return new URLSearchParams({
    _csrf: csrf,
    season_id: String(seasonId),
    contact_name: "Synthetic Host",
    contact_email: "host@example.invalid",
    venue_title: "The Test Porch",
    venue_address: "Synthetic Venue Address",
    space_description: "Front porch and yard",
    has_power: "yes",
    rain_backup: "no",
    website: "",
  });
}

function performerBody(seasonId: number, csrf: string) {
  const values = new URLSearchParams({
    _csrf: csrf,
    season_id: String(seasonId),
    contact_name: "Synthetic Performer",
    contact_email: "performer@example.invalid",
    act_name: "The Test Fixtures",
    genres: "Folk",
    description: "Songs with harmonies",
    duration_minutes: "45",
    requires_amplification: "no",
    can_lend_gear: "no",
    website: "",
  });
  values.append("availability_start", "2031-06-01T14:00");
  values.append("availability_end", "2031-06-01T16:00");
  return values;
}

function readAvailabilities(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
) {
  const act = runtime.core.seasons
    .listActivityQueue(seasonId)
    .find(({ recordType }) => recordType === "act");
  return act ? runtime.coreTesting.listRawActAvailabilities(act.record.id) : [];
}

describe("availability is stored in the season's timezone", () => {
  it("stores the instant a Chicago performer meant, not the same clock read as UTC", async () => {
    const { runtime, seasonId } = await makeRuntime({
      timezone: CHICAGO,
    });
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);

    const response = await submit(
      runtime,
      "/signup/performer",
      performerBody(seasonId, token),
    );

    expect(response.status).toBe(201);
    const [window] = readAvailabilities(runtime, seasonId);
    // 14:00 in Chicago on 2031-06-01 is 19:00Z. Reading the wall clock as UTC
    // would store 14:00Z, which is 09:00 Chicago — five hours early.
    // KTD2: this literal is the raw SQLite epoch in seconds. A timestamp_ms
    // codec mutation must fail here instead of round-tripping through itself.
    expect(window?.startsAt.valueOf()).toBe(1_938_106_800);
    expect(window?.endsAt.valueOf()).toBe(1_938_114_000);
  });

  it("keeps a UTC season's wall clock identical, so existing seasons do not move", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);

    await submit(runtime, "/signup/performer", performerBody(seasonId, token));

    const [window] = readAvailabilities(runtime, seasonId);
    expect(window?.startsAt.valueOf()).toBe(1_938_088_800);
  });

  it("resolves both daylight-saving edges to the right offset", async () => {
    const { runtime, seasonId } = await makeRuntime({
      timezone: CHICAGO,
    });
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.delete("availability_start");
    values.delete("availability_end");
    // Standard time (CST, -06:00) and daylight time (CDT, -05:00).
    values.append("availability_start", "2031-01-15T09:00");
    values.append("availability_end", "2031-01-15T10:00");
    values.append("availability_start", "2031-07-15T09:00");
    values.append("availability_end", "2031-07-15T10:00");

    expect((await submit(runtime, "/signup/performer", values)).status).toBe(
      201,
    );

    const stored = readAvailabilities(runtime, seasonId).map(
      (row) => row.startsAt,
    );
    expect(stored).toEqual([1_926_255_600, 1_941_890_400]);
  });

  it("refuses an impossible calendar date instead of normalizing it", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.set("availability_start", "2031-02-29T14:00");
    values.set("availability_end", "2031-02-29T15:00");

    const response = await submit(runtime, "/signup/performer", values);

    // 2031 is not a leap year. `new Date` silently rolls this to March 1.
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("real start and a later end time");
    expect(readAvailabilities(runtime, seasonId)).toEqual([]);
  });

  it("names duplicate windows as a field error rather than a retryable outage", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.append("availability_start", "2031-06-01T14:00");
    values.append("availability_end", "2031-06-01T16:00");

    const response = await submit(runtime, "/signup/performer", values);

    // The unique index refuses these too, but that surfaces as 503 "try again",
    // and retrying an unchanged form can never work.
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("identical");
  });

  it("caps the number of availability windows one submission may carry", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    for (let index = 0; index < 40; index += 1) {
      values.append("availability_start", "2031-06-02T14:00");
      values.append("availability_end", "2031-06-02T16:00");
    }

    const response = await submit(runtime, "/signup/performer", values);
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain("at most 12 availability windows");
    // The over-limit rows must not be echoed back: that is the amplification.
    expect(html.split("availability_start_").length - 1).toBeLessThan(10);
  });
});

describe("challenge tokens survive a correction", () => {
  it("does not spend a challenge token on a submission that fails validation", async () => {
    const antibot = new SingleUseAntibot();
    const { runtime, seasonId } = await makeRuntime({ antibot });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("venue_address", "");
    values.set("antibot_token", "single-use-token");

    const rejected = await submit(runtime, "/signup/host", values);
    expect(rejected.status).toBe(422);
    // The token was never presented to the provider, so it is still unused.
    expect(antibot.seen.has("single-use-token")).toBe(false);

    values.set("venue_address", "2205 Scudder St");
    const corrected = await submit(runtime, "/signup/host", values);
    expect(corrected.status).toBe(201);
  });

  it("never re-renders a token the provider already consumed", async () => {
    const antibot = new SingleUseAntibot();
    antibot.seen.add("spent-token");
    const { runtime, seasonId } = await makeRuntime({ antibot });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("antibot_token", "spent-token");

    const response = await submit(runtime, "/signup/host", values);
    const html = await response.text();

    expect(response.status).toBe(403);
    // Re-rendering the spent token turns "try again" into a permanent refusal.
    expect(html).not.toContain("spent-token");
  });
});

describe("per-IP admission applies in every mode", () => {
  it("rate-limits a configured deployment, which the provider itself does not", async () => {
    const { runtime, seasonId } = await makeRuntime({
      antibot: new AlwaysPassingAntibot(),
      rateLimit: 3,
    });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const values = hostBody(seasonId, token);
      values.set("antibot_token", `fresh-token-${attempt}`);
      statuses.push((await submit(runtime, "/signup/host", values)).status);
    }

    // A provider caps token reuse, not request volume. Without a local cap all
    // five would persist.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(
      0,
    );
  });

  it("gives two clients behind one trusted proxy hop separate buckets", async () => {
    const { runtime, seasonId } = await makeRuntime({
      rateLimit: 2,
      trustedProxyHops: "1",
      socketPeer: "10.0.0.9", // the proxy, shared by every client
    });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const send = (client: string) =>
      submit(runtime, "/signup/host", hostBody(seasonId, token), {
        forwardedFor: client,
      });

    await send("198.51.100.1");
    await send("198.51.100.1");
    const exhausted = await send("198.51.100.1");
    const neighbour = await send("198.51.100.2");

    expect(exhausted.status).toBe(429);
    // Keying on the socket peer would lock the whole neighbourhood out here.
    expect(neighbour.status).not.toBe(429);
  });

  it("ignores a spoofed forwarded header when no proxy is trusted", async () => {
    const { runtime, seasonId } = await makeRuntime({
      rateLimit: 2,
      socketPeer: "203.0.113.5",
    });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const send = (spoof: string) =>
      submit(runtime, "/signup/host", hostBody(seasonId, token), {
        forwardedFor: spoof,
      });

    await send("198.51.100.1");
    await send("198.51.100.2");
    const third = await send("198.51.100.3");

    expect(third.status).toBe(429);
  });

  it("forgets addresses that stop submitting", () => {
    let now = 0;
    const limiter = new PerIpRateLimiter({
      limit: 5,
      windowMs: 1_000,
      now: () => now,
    });

    for (let index = 0; index < 500; index += 1) {
      limiter.consume(`2001:db8::${index.toString(16)}`);
    }
    expect(limiter.trackedAddresses).toBe(500);

    now += 5_000;
    limiter.consume("198.51.100.1");

    // Without eviction every one-shot address is retained until restart.
    expect(limiter.trackedAddresses).toBe(1);
  });
});

describe("hostile request shapes get an answer, not a stack trace", () => {
  it("survives a prototype-polluting field name", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.append("__proto__", "x");
    values.append("constructor", "y");

    const response = await submit(runtime, "/signup/host", values);

    // On a plain object `values["__proto__"] ??= []` declines to assign and the
    // following .push throws a public 500.
    expect(response.status).not.toBe(500);
  });

  it("refuses JSON on a form-only route instead of throwing", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const response = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`, {
      method: "POST",
      headers: {
        origin: PUBLIC_BASE_URL,
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      body: "{}",
    });

    expect(response.status).toBe(415);
  });

  it("refuses a scalar answer that arrives twice", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.append("has_power", "no");

    const response = await submit(runtime, "/signup/host", values);

    // First-wins would persist "yes" and silently discard the conflict.
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("more than once");
  });

  it("refuses a file where text belongs rather than dropping it", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const form = new FormData();
    for (const [name, value] of hostBody(seasonId, token)) {
      form.append(name, value);
    }
    form.set("notes", new File(["hello"], "notes.txt", { type: "text/plain" }));

    const response = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`, {
      method: "POST",
      headers: { origin: PUBLIC_BASE_URL },
      body: form,
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("must be text, not a file");
  });

  it("caps a single participant answer and does not echo the oversized value", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    const flood = "&".repeat(20_000);
    values.set("space_description", flood);

    const response = await submit(runtime, "/signup/host", values);
    const html = await response.text();

    expect(response.status).toBe(422);
    // Escaping expands each "&" to "&amp;": echoing it back is the amplification.
    expect(html.length).toBeLessThan(60_000);
  });
});

describe("season legality is visible before the form is filled in", () => {
  it("does not render a usable form for a season that does not exist", async () => {
    const { runtime } = await makeRuntime();
    const { status, html } = await csrfToken(runtime, "/signup/host", 999_999);

    expect(status).toBe(400);
    expect(html).toContain("could not be found");
    expect(html).toContain("Choose a Porchfest season");
    expect(html).toContain('name="season"');
    expect(html).not.toContain('data-signup-form="host"');
  });

  it("does not render a usable form for a season whose signups are closed", async () => {
    const { runtime, seasonId } = await makeRuntime({ state: "locked" });
    const { status, html } = await csrfToken(runtime, "/signup/host", seasonId);

    expect(status).toBe(409);
    expect(html).toContain("Signups are not open");
    expect(html).toContain("Signups are not open right now");
    expect(html).not.toContain('data-signup-form="host"');
  });
});

describe("participant responses and the challenge contract", () => {
  it("marks participant HTML private as well as no-store", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { headers } = await csrfToken(runtime, "/signup/host", seasonId);

    expect(headers.get("cache-control")).toBe("no-store, private");
  });

  it("keeps the policy self-only when no challenge is configured", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { headers, html } = await csrfToken(
      runtime,
      "/signup/host",
      seasonId,
    );

    expect(headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(headers.get("content-security-policy")).not.toContain("https://");
    expect(html).not.toContain("challenge.example");
  });

  it("widens the policy by exactly what the configured adapter asks for", async () => {
    const { runtime, seasonId } = await makeRuntime({
      antibot: new AlwaysPassingAntibot(),
    });
    const { headers, html } = await csrfToken(
      runtime,
      "/signup/host",
      seasonId,
    );
    const policy = headers.get("content-security-policy") ?? "";

    expect(policy).toContain("script-src 'self' https://challenge.example");
    expect(policy).toContain("frame-src 'self' https://challenge.example");
    // The widget and its script are rendered from the adapter's descriptor, so
    // no provider is named anywhere in web.
    expect(html).toContain('src="https://challenge.example/api.js"');
    expect(html).toContain('data-sitekey="site-key"');
  });
});

describe("the confirmation page is a receipt", () => {
  it("separates what the public sees from what only organizers see", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("contact_phone", "synthetic-host-phone");
    values.set("notes", "Side gate is open");
    values.append("gear", "pa");
    values.append("drinks", "water");

    const response = await submit(runtime, "/signup/host", values);
    const html = await response.text();
    const publicHalf = html.slice(
      html.indexOf("Shown publicly"),
      html.indexOf("Kept private"),
    );
    const privateHalf = html.slice(html.indexOf("Kept private"));

    expect(response.status).toBe(201);
    expect(publicHalf).toContain("The Test Porch");
    // The human label, not the stored value: "pa" alone also matches "space".
    expect(publicHalf).toContain("PA system");
    expect(publicHalf).toContain("Water");
    expect(publicHalf).not.toContain("synthetic-host-phone");
    expect(privateHalf).toContain("synthetic-host-phone");
    expect(privateHalf).toContain("host@example.invalid");
    expect(privateHalf).toContain("Side gate is open");
  });

  it("persists the performer notes field and keeps it private", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.set("performer_notes", "We need a shady spot");

    const response = await submit(runtime, "/signup/performer", values);
    const html = await response.text();

    expect(response.status).toBe(201);
    const act = runtime.core.seasons
      .listActivityQueue(seasonId)
      .find(({ recordType }) => recordType === "act");
    expect(runtime.coreTesting.readAct(act?.record.id ?? 0)?.notes).toBe(
      "We need a shady spot",
    );
    expect(html.slice(html.indexOf("Kept private"))).toContain(
      "We need a shady spot",
    );
  });
});

describe("validation guards are load-bearing", () => {
  it("refuses a malformed email address", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("contact_email", "not-an-email");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("name@example.com");
  });

  it("refuses an unanswered yes/no rather than persisting it as no", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.delete("rain_backup");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Choose yes or no");
  });

  it("refuses a yes/no value that is neither", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("has_power", "maybe");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(422);
  });

  it("refuses an unlisted gear value instead of dropping it", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.append("gear", "flamethrower");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Choose only the listed gear");
  });

  it("refuses a set duration outside the allowed range", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.set("duration_minutes", "1000");

    const response = await submit(runtime, "/signup/performer", values);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("5 to 240 minutes");
  });

  it("refuses a performer with no availability at all", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.delete("availability_start");
    values.delete("availability_end");

    const response = await submit(runtime, "/signup/performer", values);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("at least one time window");
  });

  it("refuses an availability window that ends before it starts", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerBody(seasonId, token);
    values.set("availability_end", "2031-06-01T13:00");

    const response = await submit(runtime, "/signup/performer", values);

    expect(response.status).toBe(422);
  });

  it("refuses a thrown adapter with a retryable refusal, not a crash", async () => {
    class ThrowingAntibot extends AlwaysPassingAntibot {
      override async verify(): Promise<never> {
        throw new Error("provider exploded");
      }
    }
    const { runtime, seasonId } = await makeRuntime({
      antibot: new ThrowingAntibot(),
    });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostBody(seasonId, token);
    values.set("antibot_token", "anything");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("unavailable right now");
  });
});
