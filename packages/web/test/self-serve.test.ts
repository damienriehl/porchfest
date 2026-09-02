import {
  ParticipantTokenError,
  type AntibotPort,
  type AntibotRequest,
  type AntibotResult,
  type CoreRuntime,
  type EmailMessage,
  type EmailPort,
} from "@porchfest/core";
import type { Context } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestingRuntime,
  type PorchfestTestingRuntime,
} from "../src/composition.js";
import { currentParticipant } from "../src/auth.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestTestingRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

class RecordingEmail implements EmailPort {
  readonly name = "recording";
  readonly configured = true;
  readonly deliveries: EmailMessage[] = [];

  async deliver(message: EmailMessage) {
    this.deliveries.push(message);
    return { status: "sent" as const, providerMessageId: "recorded" };
  }
}

class RejectedEmail implements EmailPort {
  readonly name = "rejected";
  readonly configured = true;
  readonly deliveries: EmailMessage[] = [];

  constructor(private readonly mode: "failed" | "throw") {}

  async deliver(message: EmailMessage) {
    this.deliveries.push(message);
    if (this.mode === "throw") throw new Error("synthetic delivery crash");
    return { status: "failed" as const, reason: "synthetic refusal" };
  }
}

class DelayedEmail implements EmailPort {
  readonly name = "delayed";
  readonly configured = true;
  readonly deliveries: EmailMessage[] = [];
  #finish: ((result: { readonly status: "sent" }) => void) | null = null;

  deliver(message: EmailMessage): Promise<{ readonly status: "sent" }> {
    this.deliveries.push(message);
    return new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  complete(): void {
    if (!this.#finish) throw new Error("delivery has not started");
    this.#finish({ status: "sent" });
  }
}

class TrackingAntibot implements AntibotPort {
  readonly name = "tracking";
  readonly configured = true;
  readonly clientChallenge = null;
  readonly requests: AntibotRequest[] = [];

  async verify(request: AntibotRequest) {
    this.requests.push(request);
    return { status: "passed" as const };
  }
}

class RefusingAntibot implements AntibotPort {
  readonly name = "refusing";
  readonly configured = true;
  readonly clientChallenge = null;

  constructor(private readonly result: AntibotResult | Error) {}

  async verify(): Promise<AntibotResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

async function boot(
  options: {
    email?: EmailPort | null;
    antibot?: AntibotPort;
    rateLimit?: number;
    timezone?: string;
    timeSlots?: readonly {
      readonly startsAt: string;
      readonly endsAt: string;
    }[];
    performerAvailability?: readonly {
      readonly startsAt: Date;
      readonly endsAt: Date;
    }[];
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-self-serve-"));
  temporaryRoots.push(dataDirectory);
  const email =
    options.email === undefined ? new RecordingEmail() : options.email;
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "self-serve-test-session-secret",
    },
    adapterOverrides: {
      ...(email ? { email } : {}),
      ...(options.antibot ? { antibot: options.antibot } : {}),
    },
    resolveSocketPeerAddress: () => "192.0.2.88",
    signupGuardOptions: {
      limit: options.rateLimit ?? 100,
      windowMs: 60_000,
    },
  });
  runtimes.push(runtime);

  const organizer = runtime.core.access.redeemLink({
    token: runtime.core.access.issueBootstrapLink().token,
    displayName: "Synthetic Organizer",
    email: "organizer@example.invalid",
  }).organizer;
  const { season } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic Porchfest",
    timezone: options.timezone ?? "UTC",
    eventDate: "2031-09-13",
    eventCity: "Exampleton",
    eventState: "WI",
    timeSlots: options.timeSlots ?? [
      { startsAt: "14:00", endsAt: "15:00" },
      { startsAt: "16:00", endsAt: "17:00" },
    ],
    openSignups: true,
  });
  const host = runtime.core.seasons.createHostSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic Host",
      email: "host@example.invalid",
      phone: "555-0101",
    },
    venue: {
      title: "Token Porch",
      address: "10 Stored Street",
      spaceDescription: "Front porch and yard",
      hasPower: true,
      rainBackup: false,
      notes: "Host participant note",
      requestedActNames: "The Magic Links",
      genrePreferences: "Folk",
    },
    gear: ["pa"],
    drinks: ["water"],
    amenities: ["seating"],
  });
  const performer = runtime.core.seasons.createPerformerSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic Performer",
      email: "performer@example.invalid",
      phone: "555-0102",
    },
    act: {
      name: "The Magic Links",
      durationMinutes: 45,
      requiresAmplification: false,
      genre: "Folk",
      description: "Songs about private URLs",
      links: "https://example.invalid/magic-links",
      housePreference: "Near the park",
      sharedMemberNote: null,
      canLendGear: true,
      notes: "Act participant note",
    },
    availabilities: options.performerAvailability ?? [
      {
        startsAt: new Date("2031-09-13T14:00:00.000Z"),
        endsAt: new Date("2031-09-13T17:00:00.000Z"),
      },
    ],
  });
  runtime.core.seasons.setRecordStatus(
    "venue",
    host.venue.id,
    host.venue.version,
    "confirmed",
  );
  runtime.core.seasons.setRecordStatus(
    "act",
    performer.act.id,
    performer.act.version,
    "confirmed",
  );
  const confirmedHost = runtime.core.seasons.getVenue(host.venue.id);
  const confirmedAct = runtime.core.seasons.getAct(performer.act.id);
  const slot = runtime.core.seasons.listVenueSlots(host.venue.id)[0]!;
  runtime.core.seasons.assignSlot(slot.id, slot.version, performer.act.id);
  runtime.core.annotations.annotate({
    seasonId: season.id,
    recordType: "venue",
    recordId: host.venue.id,
    note: "Organizer annotation stays separate",
  });
  return {
    runtime,
    email,
    organizer,
    season,
    host: { ...host, venue: confirmedHost },
    performer: { ...performer, act: confirmedAct },
    slot,
  };
}

function csrf(html: string, action: string): string {
  const escaped = action.replaceAll("/", "\\/");
  const form =
    html.match(
      new RegExp(`<form[^>]+action="${escaped}"[\\s\\S]*?<\\/form>`),
    )?.[0] ?? "";
  return form.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

function hidden(html: string, name: string): string {
  return html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] ?? "";
}

function deliveredToken(message: EmailMessage): string {
  const url = message.text.match(/https:\/\/[^\s]+/)?.[0];
  const token = url ? new URL(url).searchParams.get("token") : null;
  if (!token) throw new Error("delivery did not contain a participant token");
  return token;
}

async function participantPage(
  runtime: PorchfestTestingRuntime,
  recordType: "venue" | "act" = "venue",
  recordId?: number,
) {
  const targetId =
    recordId ??
    (recordType === "venue"
      ? runtime.core.seasons.listSeasonVenues(1)[0]!.id
      : runtime.core.seasons.listSeasonActs(1)[0]!.id);
  const issued = runtime.core.participantTokens.issue(recordType, targetId);
  const entry = await runtime.request(
    `${PUBLIC_BASE_URL}/self-serve?token=${issued.token}`,
    { headers: { accept: "text/html" } },
  );
  expect(entry.status).toBe(303);
  const cookie = (entry.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const response = await runtime.request(`${PUBLIC_BASE_URL}/self-serve`, {
    headers: { accept: "text/html", cookie },
  });
  return { issued, entry, cookie, response, html: await response.text() };
}

function hostEdit(html: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    _csrf: csrf(html, "/self-serve"),
    record_version: hidden(html, "record_version"),
    contact_version: hidden(html, "contact_version"),
    contact_name: "Synthetic Host",
    contact_email: "host@example.invalid",
    contact_phone: "555-0199",
    venue_title: "Token Porch",
    space_description: "Front porch, yard, and driveway",
    has_power: "yes",
    rain_backup: "no",
    requested_act_names: "The Magic Links",
    genre_preferences: "Folk and acoustic",
    participant_notes: "Updated host participant note",
    gear: "pa",
    drinks: "water",
    amenities: "seating",
    ...overrides,
  });
}

function actEdit(html: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    _csrf: csrf(html, "/self-serve"),
    record_version: hidden(html, "record_version"),
    contact_version: hidden(html, "contact_version"),
    contact_name: "Synthetic Performer",
    contact_email: "performer@example.invalid",
    contact_phone: "555-0102",
    act_name: "The Magic Links",
    genres: "Folk",
    description: "Songs about private URLs",
    links: "https://example.invalid/magic-links",
    duration_minutes: "45",
    requires_amplification: "no",
    house_preference: "Near the park",
    shared_member_note: "",
    can_lend_gear: "yes",
    participant_notes: "Act participant note",
    ...overrides,
  });
}

function post(
  runtime: PorchfestTestingRuntime,
  path: string,
  cookie: string,
  body: URLSearchParams,
  headers: Record<string, string> = {},
) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      cookie,
      origin: PUBLIC_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

async function requestLink(
  runtime: PorchfestTestingRuntime,
  email: string,
  options: {
    headers?: Record<string, string>;
    website?: string;
    antibotToken?: string;
  } = {},
) {
  const page = await runtime.request(
    `${PUBLIC_BASE_URL}/self-serve/request-link`,
  );
  const html = await page.text();
  const response = await post(
    runtime,
    "/self-serve/request-link",
    "",
    new URLSearchParams({
      _csrf: csrf(html, "/self-serve/request-link"),
      email,
      website: options.website ?? "",
      ...(options.antibotToken ? { antibot_token: options.antibotToken } : {}),
    }),
    options.headers,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}

describe("U8 participant self-serve scenarios", () => {
  it("R31: does not disguise an unexpected participant-token storage failure", () => {
    const failure = new Error("synthetic database failure");
    const core = {
      participantTokens: {
        resolve: () => {
          throw failure;
        },
      },
    } as unknown as CoreRuntime;
    const context = {
      req: {
        query: (name: string) => (name === "token" ? "synthetic-token" : null),
        header: () => undefined,
      },
    } as unknown as Context;

    expect(() => currentParticipant(core, context)).toThrow(failure);
  });

  it("R31: reuses the participant grant resolved by route authorization", () => {
    let resolutions = 0;
    const grant = {
      recordType: "venue" as const,
      recordId: 7,
      seasonId: 3,
      contactId: 11,
      expiresAt: new Date("2031-09-13T00:00:00.000Z"),
    };
    const core = {
      participantTokens: {
        resolve: () => {
          resolutions += 1;
          return grant;
        },
      },
    } as unknown as CoreRuntime;
    const context = {
      req: {
        query: (name: string) => (name === "token" ? "synthetic-token" : null),
        header: () => undefined,
      },
    } as unknown as Context;

    expect(currentParticipant(core, context)).toBe(grant);
    expect(currentParticipant(core, context)).toBe(grant);
    expect(resolutions).toBe(1);
  });

  it("R31: refuses an expired link and offers a new one", async () => {
    const { runtime, host } = await boot();
    const issued = runtime.core.participantTokens.issue("venue", host.venue.id);
    runtime.coreTesting.expireParticipantMagicLink(issued.token);

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/self-serve?token=${issued.token}`,
    );
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).not.toContain('{"error":"unauthorized"}');
    expect(html).toContain("expired or is no longer available");
    expect(html).toContain('href="/self-serve/request-link"');
  });

  it("R31: throttles one target while known and unknown responses stay identical", async () => {
    const antibot = new TrackingAntibot();
    const { runtime, email } = await boot({ antibot, rateLimit: 100 });
    const known = await requestLink(runtime, "host@example.invalid");
    const knownBody = await known.text();
    await requestLink(runtime, "host@example.invalid");
    await requestLink(runtime, "host@example.invalid");
    const capped = await requestLink(runtime, "host@example.invalid");
    const unknown = await requestLink(runtime, "nobody@example.invalid");

    expect(email).toBeInstanceOf(RecordingEmail);
    expect((email as RecordingEmail).deliveries).toHaveLength(3);
    expect(capped.status).toBe(202);
    expect(unknown.status).toBe(known.status);
    expect(await capped.text()).toBe(knownBody);
    expect(await unknown.text()).toBe(knownBody);
    expect(antibot.requests).toHaveLength(5);

    const limited = await boot({
      antibot: new TrackingAntibot(),
      rateLimit: 1,
    });
    expect(
      (await requestLink(limited.runtime, "host@example.invalid")).status,
    ).toBe(202);
    expect(
      (await requestLink(limited.runtime, "host@example.invalid")).status,
    ).toBe(429);
  });

  it("R31: returns before delivery and activates a replacement only after success", async () => {
    const email = new DelayedEmail();
    const { runtime, host } = await boot({ email });
    const existing = runtime.core.participantTokens.issue(
      "venue",
      host.venue.id,
    );

    const response = await requestLink(runtime, "host@example.invalid");

    expect(response.status).toBe(202);
    expect(email.deliveries).toHaveLength(1);
    expect(
      runtime.core.participantTokens.resolve(existing.token).recordId,
    ).toBe(host.venue.id);
    const candidate = deliveredToken(email.deliveries[0]!);
    expect(() => runtime.core.participantTokens.resolve(candidate)).toThrow(
      ParticipantTokenError,
    );

    email.complete();
    await vi.waitFor(() => {
      expect(runtime.core.participantTokens.resolve(candidate).recordId).toBe(
        host.venue.id,
      );
    });
    expect(() =>
      runtime.core.participantTokens.resolve(existing.token),
    ).toThrow(ParticipantTokenError);
  });

  it.each(["failed", "throw"] as const)(
    "R31: %s delivery keeps the old link and the generic response",
    async (mode) => {
      const email = new RejectedEmail(mode);
      const { runtime, host } = await boot({ email });
      const existing = runtime.core.participantTokens.issue(
        "venue",
        host.venue.id,
      );

      const known = await requestLink(runtime, "host@example.invalid");
      const knownBody = await known.text();
      const unknown = await requestLink(runtime, "nobody@example.invalid");

      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(await unknown.text()).toBe(knownBody);
      expect(
        runtime.core.participantTokens.resolve(existing.token).recordId,
      ).toBe(host.venue.id);
      expect(() =>
        runtime.core.participantTokens.resolve(
          deliveredToken(email.deliveries[0]!),
        ),
      ).toThrow(ParticipantTokenError);
    },
  );

  it("R31: anti-bot refusals never deliver or supersede a participant link", async () => {
    const cases: readonly [AntibotResult | Error, number][] = [
      [{ status: "failed", reason: "synthetic refusal" }, 403],
      [{ status: "unavailable", reason: "synthetic outage" }, 503],
      [new Error("synthetic adapter crash"), 503],
    ];
    for (const [result, expectedStatus] of cases) {
      const { runtime, email, host } = await boot({
        antibot: new RefusingAntibot(result),
      });
      const existing = runtime.core.participantTokens.issue(
        "venue",
        host.venue.id,
      );

      const response = await requestLink(runtime, "host@example.invalid", {
        antibotToken: "synthetic-token",
      });

      expect(response.status).toBe(expectedStatus);
      expect((email as RecordingEmail).deliveries).toHaveLength(0);
      expect(
        runtime.core.participantTokens.resolve(existing.token).recordId,
      ).toBe(host.venue.id);
    }

    const honeypot = await boot();
    const existing = honeypot.runtime.core.participantTokens.issue(
      "venue",
      honeypot.host.venue.id,
    );
    const response = await requestLink(
      honeypot.runtime,
      "host@example.invalid",
      { website: "spam.example" },
    );
    expect(response.status).toBe(400);
    expect((honeypot.email as RecordingEmail).deliveries).toHaveLength(0);
    expect(
      honeypot.runtime.core.participantTokens.resolve(existing.token).recordId,
    ).toBe(honeypot.host.venue.id);
  });

  it("KTD16: ignores hostile host headers when building a reissue link", async () => {
    const { runtime, email } = await boot();
    const response = await requestLink(runtime, "host@example.invalid", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "forwarded.evil.example",
      },
    });

    expect(response.status).toBe(202);
    const delivered = (email as RecordingEmail).deliveries[0]!.text;
    expect(delivered).toContain(`${PUBLIC_BASE_URL}/self-serve?token=`);
    expect(delivered).not.toContain("evil.example");
  });

  it("R33: queues withdrawal and availability without changing an assignment", async () => {
    const { runtime, season, host, performer } = await boot();
    const hostPage = await participantPage(runtime, "venue", host.venue.id);
    const actPage = await participantPage(runtime, "act", performer.act.id);
    const before = runtime.core.seasons.listAssignments(season.id);

    const withdrawal = await post(
      runtime,
      "/self-serve/change-request",
      hostPage.cookie,
      new URLSearchParams({
        _csrf: csrf(hostPage.html, "/self-serve/change-request"),
        record_version: hidden(hostPage.html, "record_version"),
        kind: "withdrawal",
      }),
    );
    const availabilityValues = new URLSearchParams({
      _csrf: csrf(actPage.html, "/self-serve/change-request"),
      record_version: hidden(actPage.html, "record_version"),
      kind: "availability",
      availability_start: "2031-09-13T14:00",
      availability_end: "2031-09-13T15:00",
    });
    availabilityValues.append("availability_start", "2031-09-13T16:00");
    availabilityValues.append("availability_end", "2031-09-13T17:00");
    const availability = await post(
      runtime,
      "/self-serve/change-request",
      actPage.cookie,
      availabilityValues,
    );
    const address = await post(
      runtime,
      "/self-serve/change-request",
      hostPage.cookie,
      new URLSearchParams({
        _csrf: csrf(hostPage.html, "/self-serve/change-request"),
        record_version: hidden(hostPage.html, "record_version"),
        kind: "address",
        proposed_address: "11 Corrected Street",
      }),
    );

    expect(withdrawal.status).toBe(303);
    expect(availability.status).toBe(303);
    expect(address.status).toBe(303);
    const requests = runtime.core.changeRequests.listPendingForSeason(
      season.id,
    );
    expect(requests).toHaveLength(3);
    expect(
      requests.find(({ kind }) => kind === "availability")
        ?.proposedAvailability,
    ).toEqual([
      {
        startsAt: new Date("2031-09-13T14:00:00.000Z"),
        endsAt: new Date("2031-09-13T15:00:00.000Z"),
      },
      {
        startsAt: new Date("2031-09-13T16:00:00.000Z"),
        endsAt: new Date("2031-09-13T17:00:00.000Z"),
      },
    ]);
    expect(runtime.core.seasons.listAssignments(season.id)).toEqual(before);
    expect(runtime.core.seasons.getVenue(host.venue.id).status).toBe(
      "confirmed",
    );
    expect(runtime.core.seasons.getVenue(host.venue.id).address).toBe(
      "10 Stored Street",
    );
    expect(runtime.core.seasons.getAct(performer.act.id).status).toBe(
      "confirmed",
    );
  });

  it("renders the confirmed assignment as a readable season-local time", async () => {
    const { runtime, performer, slot } = await boot({
      timezone: "America/Chicago",
      timeSlots: [{ startsAt: "23:00", endsAt: "23:45" }],
      performerAvailability: [
        {
          startsAt: new Date("2031-09-14T04:00:00.000Z"),
          endsAt: new Date("2031-09-14T04:45:00.000Z"),
        },
      ],
    });
    const page = await participantPage(runtime, "act", performer.act.id);

    expect(slot.startsAt.toISOString()).toBe("2031-09-14T04:00:00.000Z");
    expect(page.html).toContain(
      "Sep 13, 2031, 11:00–11:45 PM (America/Chicago)",
    );
    expect(page.html).not.toContain("2031-09-13T14:00:00.000Z");
  });

  it("R33: renders and applies a two-window availability proposal", async () => {
    const { runtime, performer } = await boot();
    const page = await participantPage(runtime, "act", performer.act.id);
    expect(page.html).toContain('id="availability_start_1"');
    expect(page.html).toContain('for="availability_start_1"');
    expect(page.html).toContain('value="2031-09-13T14:00"');
    const values = new URLSearchParams({
      _csrf: csrf(page.html, "/self-serve/change-request"),
      record_version: hidden(page.html, "record_version"),
      kind: "availability",
      availability_start: "2031-09-13T14:00",
      availability_end: "2031-09-13T15:00",
    });
    values.append("availability_start", "2031-09-13T16:00");
    values.append("availability_end", "2031-09-13T17:00");

    const response = await post(
      runtime,
      "/self-serve/change-request",
      page.cookie,
      values,
    );
    expect(response.status).toBe(303);
    const request = runtime.core.changeRequests
      .listPendingForSeason(performer.act.seasonId)
      .find(({ kind }) => kind === "availability")!;
    runtime.core.changeRequests.apply(request.id, request.version);

    const updated = runtime.core.participantTokens.read(page.issued.token);
    expect(updated.recordType).toBe("act");
    if (updated.recordType === "act") {
      expect(updated.availabilities).toEqual([
        expect.objectContaining({
          startsAt: new Date("2031-09-13T14:00:00.000Z"),
          endsAt: new Date("2031-09-13T15:00:00.000Z"),
        }),
        expect.objectContaining({
          startsAt: new Date("2031-09-13T16:00:00.000Z"),
          endsAt: new Date("2031-09-13T17:00:00.000Z"),
        }),
      ]);
    }
  });

  it("R33: returns a labelled 422 for a blank address proposal", async () => {
    const { runtime, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    const response = await post(
      runtime,
      "/self-serve/change-request",
      page.cookie,
      new URLSearchParams({
        _csrf: csrf(page.html, "/self-serve/change-request"),
        record_version: hidden(page.html, "record_version"),
        kind: "address",
        proposed_address: "   ",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain('id="proposed_address-error"');
    expect(body).toContain("Enter the corrected venue address");
    expect(runtime.core.changeRequests.listPendingForSeason(1)).toHaveLength(0);
    expect(runtime.core.seasons.getVenue(host.venue.id).address).toBe(
      "10 Stored Street",
    );
  });

  it.each([
    ["reversed", "2031-09-13T17:00", "2031-09-13T16:00"],
    ["equal", "2031-09-13T16:00", "2031-09-13T16:00"],
  ])(
    "R33: returns a labelled 422 for %s availability",
    async (_case, start, end) => {
      const { runtime, performer } = await boot();
      const page = await participantPage(runtime, "act", performer.act.id);
      const response = await post(
        runtime,
        "/self-serve/change-request",
        page.cookie,
        new URLSearchParams({
          _csrf: csrf(page.html, "/self-serve/change-request"),
          record_version: hidden(page.html, "record_version"),
          kind: "availability",
          availability_start: start,
          availability_end: end,
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(422);
      expect(body).toContain('id="availability_start-error"');
      expect(body).toContain("a later end time");
      expect(runtime.core.changeRequests.listPendingForSeason(1)).toHaveLength(
        0,
      );
    },
  );

  it("R31: refuses a revoked link after an approved withdrawal", async () => {
    const { runtime, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    const response = await post(
      runtime,
      "/self-serve/change-request",
      page.cookie,
      new URLSearchParams({
        _csrf: csrf(page.html, "/self-serve/change-request"),
        record_version: hidden(page.html, "record_version"),
        kind: "withdrawal",
      }),
    );
    expect(response.status).toBe(303);
    const request = runtime.core.changeRequests.listPendingForSeason(1)[0]!;
    runtime.core.changeRequests.apply(request.id, request.version);

    const refused = await runtime.request(
      `${PUBLIC_BASE_URL}/self-serve?token=${page.issued.token}`,
      { headers: { accept: "text/html" } },
    );
    expect(refused.status).toBe(401);
  });

  it("R31: a link cannot read or write another participant record", async () => {
    const { runtime, host, performer } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    const attemptedRead = await runtime.request(
      `${PUBLIC_BASE_URL}/self-serve?record_id=${performer.act.id}`,
      { headers: { accept: "text/html", cookie: page.cookie } },
    );
    const readBody = await attemptedRead.text();
    expect(readBody).toContain("Token Porch");
    expect(readBody).not.toContain("Songs about private URLs");
    expect(readBody).not.toContain("performer@example.invalid");

    const attemptedWrite = await post(
      runtime,
      "/self-serve",
      page.cookie,
      hostEdit(page.html, { record_id: String(performer.act.id) }),
    );
    expect(attemptedWrite.status).toBe(422);
    expect(runtime.core.seasons.getAct(performer.act.id).description).toBe(
      "Songs about private URLs",
    );
  });

  it("R14 and AE1: hides routes and refuses minting without email", async () => {
    const { runtime, host } = await boot({ email: null });
    expect(
      runtime.routes.list().some(({ path }) => path.startsWith("/self-serve")),
    ).toBe(false);
    expect((await runtime.request("/self-serve")).status).toBe(404);
    expect(() =>
      runtime.core.participantTokens.issue("venue", host.venue.id),
    ).toThrow(/email provider/i);
  });

  it("R15: returns an edit to the queue and keeps the confirmed assignment", async () => {
    const { runtime, organizer, season, host } = await boot();
    runtime.core.queue.dismiss({
      organizerId: organizer.id,
      seasonId: season.id,
      recordType: "venue",
      recordId: host.venue.id,
      version: host.venue.version,
    });
    runtime.core.queue.dismiss({
      organizerId: organizer.id,
      seasonId: season.id,
      recordType: "contact",
      recordId: host.contact.id,
      version: host.contact.version,
    });
    const before = runtime.core.seasons.listAssignments(season.id);
    const page = await participantPage(runtime, "venue", host.venue.id);
    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      hostEdit(page.html),
    );

    expect(response.status).toBe(303);
    const newItems = runtime.core.queue.listNewForOrganizer(
      season.id,
      organizer.id,
    );
    expect(newItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: "venue" }),
        expect.objectContaining({ recordType: "contact" }),
      ]),
    );
    expect(runtime.core.seasons.listAssignments(season.id)).toEqual(before);
  });

  it("R14: refuses a non-HTTP act link without writing any edit", async () => {
    const { runtime, performer } = await boot();
    const page = await participantPage(runtime, "act", performer.act.id);
    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      actEdit(page.html, {
        contact_phone: "555-0199",
        links: "javascript:alert(1)",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain("only links that begin with http:// or https://");
    expect(runtime.core.seasons.getAct(performer.act.id).links).toBe(
      "https://example.invalid/magic-links",
    );
    expect(runtime.core.seasons.getContact(performer.contact.id).phone).toBe(
      "555-0102",
    );
  });

  it.each(["1", "1000000"])(
    "R14: refuses an out-of-range act duration of %s and preserves the submitted value",
    async (duration) => {
      const { runtime, performer } = await boot();
      const page = await participantPage(runtime, "act", performer.act.id);
      const response = await post(
        runtime,
        "/self-serve",
        page.cookie,
        actEdit(page.html, {
          contact_phone: "555-0199",
          duration_minutes: duration,
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(422);
      expect(body).toContain("Enter a set duration from 5 to 240 minutes");
      expect(body).toContain(
        `name="duration_minutes" type="number" value="${duration}"`,
      );
      expect(
        runtime.core.seasons.getAct(performer.act.id).durationMinutes,
      ).toBe(45);
      expect(runtime.core.seasons.getContact(performer.contact.id).phone).toBe(
        "555-0102",
      );
    },
  );

  it.each([5, 240])(
    "R14: accepts the boundary act duration of %i minutes",
    async (duration) => {
      const { runtime, performer } = await boot();
      const page = await participantPage(runtime, "act", performer.act.id);
      expect(page.html).toContain('name="duration_minutes" type="number"');
      expect(page.html).toContain('min="5" max="240"');

      const response = await post(
        runtime,
        "/self-serve",
        page.cookie,
        actEdit(page.html, { duration_minutes: String(duration) }),
      );

      expect(response.status).toBe(303);
      expect(
        runtime.core.seasons.getAct(performer.act.id).durationMinutes,
      ).toBe(duration);
    },
  );

  it("R14: refuses an over-limit editable field without echoing or persisting it", async () => {
    const { runtime, performer } = await boot();
    const page = await participantPage(runtime, "act", performer.act.id);
    const overLimitNotes = "n".repeat(4001);
    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      actEdit(page.html, {
        contact_phone: "555-0199",
        participant_notes: overLimitNotes,
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(422);
    expect(body).toContain('id="participant_notes-error"');
    expect(body).toContain("Shorten this answer to 4000 characters or fewer");
    expect(body).not.toContain(overLimitNotes);
    expect(runtime.core.seasons.getAct(performer.act.id).notes).toBe(
      "Act participant note",
    );
    expect(runtime.core.seasons.getContact(performer.contact.id).phone).toBe(
      "555-0102",
    );
  });

  it("R14: accepts an editable field at its shared length ceiling", async () => {
    const { runtime, performer } = await boot();
    const page = await participantPage(runtime, "act", performer.act.id);
    const boundaryDescription = "d".repeat(4000);

    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      actEdit(page.html, { description: boundaryDescription }),
    );

    expect(response.status).toBe(303);
    expect(runtime.core.seasons.getAct(performer.act.id).description).toBe(
      boundaryDescription,
    );
  });

  it.each([
    ["malformed", ["not-a-listed-option"]],
    ["duplicate", ["pa", "pa"]],
  ])(
    "R14: refuses a %s venue selection without writing any edit",
    async (_case, gear) => {
      const { runtime, host } = await boot();
      const page = await participantPage(runtime, "venue", host.venue.id);
      const values = hostEdit(page.html, { contact_phone: "555-0199" });
      values.delete("gear");
      for (const value of gear) values.append("gear", value);

      const response = await post(runtime, "/self-serve", page.cookie, values);

      expect(response.status).toBe(422);
      expect(await response.text()).toContain(
        "Choose each listed gear option at most once",
      );
      expect(
        runtime.core.seasons.getVenue(host.venue.id).spaceDescription,
      ).toBe("Front porch and yard");
      expect(runtime.core.seasons.getContact(host.contact.id).phone).toBe(
        "555-0101",
      );
    },
  );

  it.each([
    "assignment",
    "slot",
    "status",
    "latitude",
    "longitude",
    "organizer_annotation",
  ])("R14: refuses a self-serve write to read-only field %s", async (field) => {
    const { runtime, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      hostEdit(page.html, { [field]: "malicious change" }),
    );

    expect(response.status).toBe(422);
    expect(runtime.core.seasons.getVenue(host.venue.id)).toMatchObject({
      status: "confirmed",
      address: "10 Stored Street",
      notes: "Host participant note",
    });
  });

  it("R14: round-trips participant notes without overwriting organizer annotations", async () => {
    const { runtime, season, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    expect(page.html).toContain("Host participant note");
    expect(page.html).toContain("Organizer annotation stays separate");

    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      hostEdit(page.html),
    );
    expect(response.status).toBe(303);
    expect(runtime.core.seasons.getVenue(host.venue.id).notes).toBe(
      "Updated host participant note",
    );
    expect(
      runtime.core.annotations.listAnnotations(
        season.id,
        "venue",
        host.venue.id,
      ),
    ).toEqual([
      expect.objectContaining({ note: "Organizer annotation stays separate" }),
    ]);
  });

  it("R32: refuses a stale participant edit instead of overwriting", async () => {
    const { runtime, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    runtime.core.seasons.updateVenue(host.venue.id, host.venue.version, {
      spaceDescription: "Organizer saved this",
    });

    const response = await post(
      runtime,
      "/self-serve",
      page.cookie,
      hostEdit(page.html, { space_description: "Participant stale save" }),
    );
    expect(response.status).toBe(409);
    expect(runtime.core.seasons.getVenue(host.venue.id).spaceDescription).toBe(
      "Organizer saved this",
    );
    expect(runtime.core.seasons.getContact(host.contact.id).phone).toBe(
      "555-0101",
    );
  });

  it("KTD8: sends every self-serve response with private no-store caching", async () => {
    const { runtime, host } = await boot();
    expect(runtime.routes.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/self-serve/request-link",
          tier: "public",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/self-serve/request-link",
          tier: "public",
        }),
        expect.objectContaining({
          method: "GET",
          path: "/self-serve",
          tier: "participant",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/self-serve/change-request",
          tier: "participant",
        }),
      ]),
    );
    const request = await runtime.request(
      `${PUBLIC_BASE_URL}/self-serve/request-link`,
    );
    const page = await participantPage(runtime, "venue", host.venue.id);
    const refused = await runtime.request(
      `${PUBLIC_BASE_URL}/self-serve?token=not-a-token`,
      { headers: { accept: "text/html" } },
    );

    for (const response of [request, page.entry, page.response, refused]) {
      expect(response.headers.get("cache-control")).toBe("no-store, private");
    }
    expect(page.entry.headers.get("set-cookie")).toContain("Secure");
    expect(page.entry.headers.get("set-cookie")).toContain("HttpOnly");
    expect(page.entry.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("accessibility: labels every self-serve control and keeps phone-sized targets", async () => {
    const { runtime, host } = await boot();
    const page = await participantPage(runtime, "venue", host.venue.id);
    for (const id of [
      "contact_name",
      "contact_email",
      "contact_phone",
      "venue_title",
      "space_description",
      "proposed_address",
    ]) {
      expect(page.html).toContain(`id="${id}"`);
      expect(page.html).toContain(`for="${id}"`);
    }
    const css = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/assets/signup.css`,
    );
    expect(await css.text()).toContain("min-height: 44px");
  });
});
