import type { AntibotPort } from "@porchfest/core";
import { TurnstileAntibotAdapter } from "@porchfest/antibot";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
} from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
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

async function makeRuntime(
  options: {
    antibot?: AntibotPort;
    rateLimit?: number;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-signup-"));
  temporaryRoots.push(dataDirectory);
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "signup-test-session-secret",
    },
    adapterOverrides: options.antibot
      ? { antibot: options.antibot }
      : undefined,
    resolveSocketPeerAddress: () => "192.0.2.44",
    signupGuardOptions:
      options.rateLimit === undefined
        ? undefined
        : { limit: options.rateLimit, windowMs: 60_000 },
  });
  runtimes.push(runtime);

  const { season } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic 2031 Porchfest",
    timezone: "UTC",
    eventDate: "2031-06-01",
    timeSlots: [],
    openSignups: true,
  });

  return { runtime, seasonId: season.id };
}

async function csrfToken(
  runtime: PorchfestRuntime,
  path: "/signup/host" | "/signup/performer",
  seasonId: number,
) {
  const response = await runtime.request(
    `${PUBLIC_BASE_URL}${path}?season=${seasonId}`,
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  expect(token).toBeTruthy();
  return { html, token: token ?? "" };
}

async function submit(
  runtime: PorchfestRuntime,
  path: "/signup/host" | "/signup/performer",
  values: URLSearchParams,
  options: { origin?: string; contentType?: string } = {},
) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type":
        options.contentType ?? "application/x-www-form-urlencoded",
      origin: options.origin ?? PUBLIC_BASE_URL,
    },
    body: values,
  });
}

function hostValues(seasonId: number, csrf: string) {
  const values = new URLSearchParams({
    _csrf: csrf,
    season_id: String(seasonId),
    contact_name: "Synthetic Host",
    contact_email: "host@example.invalid",
    contact_phone: "synthetic-host-phone",
    venue_title: "The Test Porch",
    venue_address: "Synthetic Venue Address",
    space_description: "Front porch, yard, and driveway",
    has_power: "yes",
    rain_backup: "no",
    notes: "Use the side gate & wave.",
    website: "",
  });
  for (const value of ["pa", "microphone", "extension_cord"])
    values.append("gear", value);
  for (const value of ["water", "non_alcoholic"])
    values.append("drinks", value);
  for (const value of ["seating", "shade", "accessible_entry"])
    values.append("amenities", value);
  return values;
}

function performerValues(seasonId: number, csrf: string) {
  const values = new URLSearchParams({
    _csrf: csrf,
    season_id: String(seasonId),
    contact_name: "Synthetic Performer",
    contact_email: "performer@example.invalid",
    contact_phone: "synthetic-performer-phone",
    act_name: "The Test Fixtures",
    duration_minutes: "45",
    requires_amplification: "yes",
    genres: "Folk, rock",
    description: "Songs with harmonies & handclaps.",
    links: "https://example.invalid/the-test-fixtures",
    house_preference: "Near the park",
    can_lend_gear: "yes",
    availability_start: "2031-06-01T14:00",
    availability_end: "2031-06-01T14:45",
    website: "",
  });
  values.append("availability_start", "2031-06-01T16:00");
  values.append("availability_end", "2031-06-01T16:45");
  return values;
}

describe("public signup forms", () => {
  it("registers both forms and their mutations as public routes", async () => {
    const { runtime } = await makeRuntime();

    expect(runtime.routes.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/signup/host",
          tier: "public",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/signup/host",
          tier: "public",
        }),
        expect.objectContaining({
          method: "GET",
          path: "/signup/performer",
          tier: "public",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/signup/performer",
          tier: "public",
        }),
      ]),
    );
  });

  it("auto-selects the only open season for a bare host URL and submits it", async () => {
    const { runtime, seasonId } = await makeRuntime();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`);
    const html = await response.text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

    expect(response.status).toBe(200);
    expect(html).toContain('data-signup-form="host"');
    expect(html).toContain(`name="season_id" value="${seasonId}"`);
    expect(html).not.toContain('class="error-summary"');
    expect(token).toBeTruthy();

    const submitted = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, token),
    );
    expect(submitted.status).toBe(201);
  });

  it("renders a season chooser instead of a full form when two seasons are open", async () => {
    const { runtime } = await makeRuntime();
    runtime.core.setup.createSeason({
      year: 2032,
      displayName: "Synthetic 2032 Porchfest",
      timezone: "UTC",
      eventDate: "2032-06-01",
      timeSlots: [],
      openSignups: true,
    });

    const response = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Choose a Porchfest season");
    expect(html).toContain("Synthetic 2031 Porchfest");
    expect(html).toContain("Synthetic 2032 Porchfest");
    expect(html).toContain('name="season"');
    expect(html).not.toContain('data-signup-form="host"');
    expect(html).not.toContain('name="season_id"');
    expect(html).toContain('class="signup-single-column"');
    expect(html).not.toContain('class="signup-layout"');
  });

  it("renders a closed notice instead of a signup form when no season is open", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const season = runtime.core.seasons.getSeason(seasonId);
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "signups_closed",
    );

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/performer`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Signups are not open right now");
    expect(html).toContain('class="confirmation-card"');
    expect(html).toContain('class="signup-single-column"');
    expect(html).not.toContain('class="signup-layout"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain('data-signup-form="performer"');
  });

  it("keeps the empty-season refusal status and offers an open season", async () => {
    const { runtime } = await makeRuntime();

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/host?season=`,
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain(
      "Choose an open Porchfest season before signing up.",
    );
    expect(html).toContain("Choose a Porchfest season");
    expect(html).toContain('name="season"');
    expect(html).not.toContain('data-signup-form="host"');
  });

  it("keeps the malformed-season refusal status and offers an open season", async () => {
    const { runtime } = await makeRuntime();

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/host?season=abc`,
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain(
      "Choose an open Porchfest season before signing up.",
    );
    expect(html).toContain('name="season"');
    expect(html).not.toContain('data-signup-form="host"');
  });

  it("renders semantic, labelled host controls and the progressive preview", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { html } = await csrfToken(runtime, "/signup/host", seasonId);

    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend>Who you are</legend>");
    expect(html).toContain('for="venue_address"');
    expect(html).toContain('id="venue_address"');
    expect(html).toContain('data-signup-preview="host"');
    expect(html).toContain('type="module"');
    expect(html).toContain("/signup/assets/signup-preview.js");
  });

  it("lets the preview module no-op when its container is absent", async () => {
    const { runtime } = await makeRuntime();
    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/assets/signup-preview.js`,
    );
    const source = await response.text();

    expect(() =>
      runInNewContext(source, {
        document: { querySelector: () => null },
      }),
    ).not.toThrow();
  });

  it("ships the phone-facing focus, touch-target, and reduced-motion baseline", async () => {
    const { runtime } = await makeRuntime();
    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/assets/signup.css`,
    );
    const css = await response.text();

    expect(css).toContain("min-width: 320px");
    expect(css).toMatch(/min-height:\s*44px/g);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 2px solid var(--color-accent)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/outline:\s*none/);
  });

  it("refuses an unrecognized request host and ignores an untrusted forwarded host", async () => {
    const { runtime, seasonId } = await makeRuntime();

    expect(
      (
        await runtime.request(
          `https://hostile.example/signup/host?season=${seasonId}`,
        )
      ).status,
    ).toBe(421);
    expect(
      (
        await runtime.request(
          `${PUBLIC_BASE_URL}/signup/host?season=${seasonId}`,
          { headers: { "x-forwarded-host": "hostile.example" } },
        )
      ).status,
    ).toBe(200);
  });

  it("round-trips every host field through the real repository and activity queue", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const response = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, token),
    );

    expect(response.status).toBe(201);
    const queue = runtime.core.seasons.listActivityQueue(seasonId);
    const contact = queue.find(({ recordType }) => recordType === "contact");
    const venue = queue.find(({ recordType }) => recordType === "venue");
    expect(contact?.record).toMatchObject({
      name: "Synthetic Host",
      email: "host@example.invalid",
      phone: "synthetic-host-phone",
    });
    expect(venue?.record).toMatchObject({
      title: "The Test Porch",
      address: "Synthetic Venue Address",
      spaceDescription: "Front porch, yard, and driveway",
      hasPower: true,
      rainBackup: false,
      notes: "Use the side gate & wave.",
    });
    const createdVenue = venue?.record;
    expect(createdVenue && "id" in createdVenue).toBe(true);
    const venueId = createdVenue?.id ?? 0;
    expect(runtime.coreTesting.listVenueGear(venueId)).toEqual([
      { value: "pa" },
      { value: "microphone" },
      { value: "extension_cord" },
    ]);
    expect(runtime.coreTesting.listVenueDrinks(venueId)).toEqual([
      { value: "water" },
      { value: "non_alcoholic" },
    ]);
    expect(runtime.coreTesting.listVenueAmenities(venueId)).toEqual([
      { value: "seating" },
      { value: "shade" },
      { value: "accessible_entry" },
    ]);
  });

  it("round-trips every performer field and availability window", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);

    const response = await submit(
      runtime,
      "/signup/performer",
      performerValues(seasonId, token),
    );

    expect(response.status).toBe(201);
    const queue = runtime.core.seasons.listActivityQueue(seasonId);
    expect(
      queue.find(({ recordType }) => recordType === "contact")?.record,
    ).toMatchObject({
      name: "Synthetic Performer",
      email: "performer@example.invalid",
      phone: "synthetic-performer-phone",
    });
    const act = queue.find(({ recordType }) => recordType === "act");
    expect(act?.record).toMatchObject({
      name: "The Test Fixtures",
      durationMinutes: 45,
      requiresAmplification: true,
      genre: "Folk, rock",
      description: "Songs with harmonies & handclaps.",
      links: "https://example.invalid/the-test-fixtures",
      housePreference: "Near the park",
      canLendGear: true,
    });
    expect(
      runtime.coreTesting.listActAvailabilities(act?.record.id ?? 0),
    ).toEqual([
      {
        startsAt: new Date(1_938_088_800_000),
        endsAt: new Date(1_938_091_500_000),
      },
      {
        startsAt: new Date(1_938_096_000_000),
        endsAt: new Date(1_938_098_700_000),
      },
    ]);
  });

  it("refuses a configured challenge timeout and persists nothing", async () => {
    const neverResponds: typeof fetch = async () =>
      await new Promise<Response>(() => undefined);
    const antibot = new TurnstileAntibotAdapter({
      secretKey: "synthetic-secret",
      siteKey: "test-site-key",
      timeoutMs: 1,
      fetcher: neverResponds,
    });
    const { runtime, seasonId } = await makeRuntime({ antibot });
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostValues(seasonId, token);
    values.set("antibot_token", "timeout-token");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/verification.*try again/i);
    expect(runtime.core.seasons.listActivityQueue(seasonId)).toEqual([]);
  });

  it("refuses a replayed configured challenge token on its second use", async () => {
    const antibot = new TurnstileAntibotAdapter({
      secretKey: "synthetic-secret",
      siteKey: "test-site-key",
      fetcher: async () => Response.json({ success: true }),
    });
    const { runtime, seasonId } = await makeRuntime({ antibot });
    const firstForm = await csrfToken(runtime, "/signup/host", seasonId);
    const firstValues = hostValues(seasonId, firstForm.token);
    firstValues.set("antibot_token", "single-use-token");
    expect((await submit(runtime, "/signup/host", firstValues)).status).toBe(
      201,
    );

    const secondForm = await csrfToken(runtime, "/signup/host", seasonId);
    const secondValues = hostValues(seasonId, secondForm.token);
    secondValues.set("venue_title", "Replay Must Not Persist");
    secondValues.set("antibot_token", "single-use-token");
    const replay = await submit(runtime, "/signup/host", secondValues);

    expect(replay.status).toBe(403);
    const venues = runtime.core.seasons
      .listActivityQueue(seasonId)
      .filter(({ recordType }) => recordType === "venue");
    expect(venues).toHaveLength(1);
    expect(venues[0]?.record).toMatchObject({ title: "The Test Porch" });
  });

  it("rate-limits the unconfigured fallback by socket peer and ignores spoofed forwarding", async () => {
    const { runtime, seasonId } = await makeRuntime({ rateLimit: 1 });
    const firstForm = await csrfToken(runtime, "/signup/host", seasonId);
    const first = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, firstForm.token),
    );
    expect(first.status).toBe(201);

    const secondForm = await csrfToken(runtime, "/signup/host", seasonId);
    const second = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: PUBLIC_BASE_URL,
        "x-forwarded-for": "198.51.100.201",
      },
      body: hostValues(seasonId, secondForm.token),
    });

    expect(second.status).toBe(429);
    expect(await second.text()).toMatch(/too many/i);
  });

  it("drops a honeypot-filled unconfigured submission without persistence", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostValues(seasonId, token);
    values.set("website", "https://bot.example.invalid");

    const response = await submit(runtime, "/signup/host", values);

    expect(response.status).toBe(400);
    expect(runtime.core.seasons.listActivityQueue(seasonId)).toEqual([]);
  });

  it("names a missing field inline and preserves every other submitted value", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);
    const values = hostValues(seasonId, token);
    values.delete("venue_address");
    values.set("space_description", "Typed <b>on a phone</b> & kept");

    const response = await submit(runtime, "/signup/host", values);
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain(
      "Add a street address so performers can find your porch.",
    );
    expect(html).toContain('href="#venue_address"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Typed &lt;b&gt;on a phone&lt;/b&gt; &amp; kept");
    expect(html).toContain('value="Synthetic Host"');
    expect(html).toContain('value="host@example.invalid"');
    expect(html).toContain('value="pa" checked');
    expect(runtime.core.seasons.listActivityQueue(seasonId)).toEqual([]);
  });

  it("rejects non-http links and re-renders participant markup as inert text", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerValues(seasonId, token);
    values.set("description", '<img src=x onerror="alert(1)">');
    values.set("links", "<b>video</b>\njavascript:alert(1)");

    const response = await submit(runtime, "/signup/performer", values);
    const html = await response.text();

    expect(response.status).toBe(422);
    expect(html).toContain(
      "Use only links that begin with http:// or https://.",
    );
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;video&lt;/b&gt;");
    expect(html).toContain("javascript:alert(1)");
    expect(runtime.core.seasons.listActivityQueue(seasonId)).toEqual([]);
  });

  it("renders a next-steps confirmation and honest no-email notice", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/host", seasonId);

    const response = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, token),
    );
    const html = await response.text();

    expect(response.status).toBe(201);
    expect(html).toMatch(/organizer.*review/i);
    expect(html).toMatch(/no confirmation email will follow/i);
    expect(html).toContain("The Test Porch");
  });

  it("links both receipts back to another signup for the same season", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const hostForm = await csrfToken(runtime, "/signup/host", seasonId);
    const hostReceipt = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, hostForm.token),
    );
    const performerForm = await csrfToken(
      runtime,
      "/signup/performer",
      seasonId,
    );
    const performerReceipt = await submit(
      runtime,
      "/signup/performer",
      performerValues(seasonId, performerForm.token),
    );

    expect(hostReceipt.status).toBe(201);
    expect(await hostReceipt.text()).toContain(
      `href="/signup/host?season=${seasonId}"`,
    );
    expect(performerReceipt.status).toBe(201);
    expect(await performerReceipt.text()).toContain(
      `href="/signup/performer?season=${seasonId}"`,
    );
  });
});
