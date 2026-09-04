import type { AntibotPort, EmailMessage, EmailPort } from "@porchfest/core";
import type { VenuesMapDocument } from "@porchfest/map";
import { TurnstileAntibotAdapter } from "@porchfest/antibot";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
} from "../src/composition.js";
import { createApp } from "../src/app.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const CURRENT_YEAR = new Date().getUTCFullYear();
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

class ConfiguredEmail implements EmailPort {
  readonly name = "configured-test-email";
  readonly configured = true;

  async deliver(_message: EmailMessage) {
    return { status: "sent" as const, providerMessageId: "synthetic" };
  }
}

const EXPECTED_HOST_AUDIENCES = {
  contact_name: "Shared with a confirmed match",
  contact_email: "Shared with a confirmed match",
  contact_phone: "Shared with a confirmed match",
  venue_title: "Public map",
  venue_address: "Public map",
  space_description: "Shared with a confirmed match",
  has_power: "Shared with a confirmed match",
  rain_backup: "Shared with a confirmed match",
  requested_act_names: "Organizer-only",
  genre_preferences: "Organizer-only",
  gear: "Shared with a confirmed match",
  drinks: "Shared with a confirmed match",
  amenities: "Shared with a confirmed match",
  notes: "Shared with a confirmed match",
} as const;

const EXPECTED_PERFORMER_AUDIENCES = {
  contact_name: "Shared with a confirmed match",
  contact_email: "Shared with a confirmed match",
  contact_phone: "Shared with a confirmed match",
  act_name: "Public map",
  genres: "Public map",
  description: "Public map",
  links: "Public map",
  duration_minutes: "Organizer-only",
  requires_amplification: "Shared with a confirmed match",
  availability_start: "Organizer-only",
  availability_end: "Organizer-only",
  house_preference: "Organizer-only",
  shared_member_note: "Organizer-only",
  can_lend_gear: "Organizer-only",
  performer_notes: "Organizer-only",
} as const;

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
    timeSlots?: readonly { startsAt: string; endsAt: string }[];
    publicSiteUrl?: string;
    year?: number;
    email?: EmailPort;
    bounds?: {
      north: number;
      south: number;
      east: number;
      west: number;
    };
  } = {},
) {
  const announced: string[] = [];
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-signup-"));
  temporaryRoots.push(dataDirectory);
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "signup-test-session-secret",
    },
    adapterOverrides:
      options.antibot || options.email
        ? {
            ...(options.antibot ? { antibot: options.antibot } : {}),
            ...(options.email ? { email: options.email } : {}),
          }
        : undefined,
    resolveSocketPeerAddress: () => "192.0.2.44",
    signupGuardOptions:
      options.rateLimit === undefined
        ? undefined
        : { limit: options.rateLimit, windowMs: 60_000 },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);

  const year = options.year ?? 2031;
  const { season } = runtime.core.setup.createSeason({
    year,
    displayName: `Synthetic ${year} Porchfest`,
    timezone: "UTC",
    eventDate: `${year}-06-01`,
    eventCity: "Exampleton",
    eventState: "WI",
    localityName: "Synthetic Quarter",
    bounds: options.bounds,
    publicSiteUrl: options.publicSiteUrl,
    timeSlots: options.timeSlots ?? [],
    openSignups: true,
  });

  return { runtime, seasonId: season.id, announced };
}

async function makeEmptyRuntime() {
  const announced: string[] = [];
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "porchfest-signup-empty-"),
  );
  temporaryRoots.push(dataDirectory);
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "signup-empty-test-session-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);
  return { runtime, announced };
}

function bootstrapTokenFrom(announced: readonly string[]): string {
  const token = announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1];
  expect(token, "a bootstrap link should have been announced").toBeTruthy();
  return token ?? "";
}

async function organizerSession(
  runtime: PorchfestRuntime,
  announced: readonly string[],
): Promise<string> {
  const token = bootstrapTokenFrom(announced);
  const signInPage = await runtime.request(
    `${PUBLIC_BASE_URL}/admin/sign-in?token=${token}`,
  );
  const html = await signInPage.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  expect(csrf).toBeTruthy();
  const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: PUBLIC_BASE_URL,
    },
    body: new URLSearchParams({
      _csrf: csrf,
      token,
      display_name: "Example Organizer",
      email: "organizer@example.invalid",
    }),
  });
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
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
    requested_act_names: "The Test Fixtures",
    genre_preferences: "Folk and acoustic rock",
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
    shared_member_note: "Drummer also plays in Fixture Friends",
    can_lend_gear: "yes",
    availability_start: "2031-06-01T14:00",
    availability_end: "2031-06-01T14:45",
    website: "",
  });
  values.append("availability_start", "2031-06-01T16:00");
  values.append("availability_end", "2031-06-01T16:45");
  return values;
}

function publicPreviewFrom(html: string, kind: "host" | "performer"): string {
  const preview = html.match(
    new RegExp(
      `<article[^>]*data-signup-preview="${kind}"[\\s\\S]*?</article>`,
    ),
  )?.[0];
  expect(preview, `expected the ${kind} public preview`).toBeTruthy();
  return preview ?? "";
}

describe("public signup forms", () => {
  it("takes each landing-page signup link through zero, one, and multiple legal seasons", async () => {
    const empty = await makeEmptyRuntime();
    const single = await makeRuntime();
    const multiple = await makeRuntime();
    multiple.runtime.core.setup.createSeason({
      year: 2032,
      displayName: "Synthetic 2032 Porchfest",
      timezone: "UTC",
      eventDate: "2032-07-04",
      eventCity: "Sample City",
      eventState: "MN",
      localityName: "Sample Ward",
      timeSlots: [],
      openSignups: true,
    });

    for (const { runtime } of [empty, single, multiple]) {
      const landing = await runtime.request(`${PUBLIC_BASE_URL}/`);
      const landingHtml = await landing.text();
      expect(landing.status).toBe(200);
      expect(landingHtml).toContain('href="/signup/host"');
      expect(landingHtml).toContain('href="/signup/performer"');
    }

    for (const path of ["/signup/host", "/signup/performer"] as const) {
      const noSeason = await empty.runtime.request(`${PUBLIC_BASE_URL}${path}`);
      const noSeasonHtml = await noSeason.text();
      expect(noSeason.status).toBe(200);
      expect(noSeasonHtml).toContain("Signups are not open right now");
      expect(noSeasonHtml).not.toContain("<form");

      const oneSeason = await single.runtime.request(
        `${PUBLIC_BASE_URL}${path}`,
      );
      const oneSeasonHtml = await oneSeason.text();
      expect(oneSeason.status).toBe(200);
      expect(oneSeasonHtml).toContain(
        `data-signup-form="${path.endsWith("host") ? "host" : "performer"}"`,
      );
      expect(oneSeasonHtml).not.toContain("Choose a Porchfest season");

      const seasonPicker = await multiple.runtime.request(
        `${PUBLIC_BASE_URL}${path}`,
      );
      const seasonPickerHtml = await seasonPicker.text();
      expect(seasonPicker.status).toBe(200);
      expect(seasonPickerHtml).toContain("Choose a Porchfest season");
      expect(seasonPickerHtml.match(/name="season"/g)).toHaveLength(2);
      expect(seasonPickerHtml).not.toContain("data-signup-form");
    }
  });

  it("takes organizer access to one-use-link instructions or the dashboard", async () => {
    const { runtime, announced } = await makeRuntime();
    const landing = await runtime.request(`${PUBLIC_BASE_URL}/`);
    const landingHtml = await landing.text();
    expect(landingHtml).toContain('href="/admin"');
    expect(landingHtml).toContain("Organizer access");
    expect(landingHtml).not.toContain("/admin/sign-in");

    const cookie = await organizerSession(runtime, announced);
    expect(cookie).toBeTruthy();

    const signedOut = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { accept: "text/html" },
    });
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/admin/sign-in");
    const instructions = await runtime.request(
      `${PUBLIC_BASE_URL}${signedOut.headers.get("location")}`,
    );
    const instructionsHtml = await instructions.text();
    expect(instructions.status).toBe(200);
    expect(instructionsHtml).toContain("Sign-in links work once");
    expect(instructionsHtml).toContain("another organizer");
    expect(instructionsHtml).toContain(
      "operator with access to the deployment",
    );
    expect(instructionsHtml).not.toContain('type="submit"');

    const dashboard = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie },
    });
    const dashboardHtml = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(dashboardHtml).toContain("Welcome, Example Organizer");
    expect(dashboardHtml).toContain("Synthetic 2031 Porchfest");
    expect(dashboardHtml).not.toContain("Your session has ended");
  });

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

  it("auto-selects the only signup-legal season for a bare host URL and submits it", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { season: closedSeason } = runtime.core.setup.createSeason({
      year: 2030,
      displayName: "Closed Synthetic Porchfest",
      timezone: "UTC",
      eventDate: "2030-06-01",
      eventCity: "Exampleton",
      eventState: "WI",
      localityName: "Closed Quarter",
      timeSlots: [],
      openSignups: true,
    });
    runtime.core.seasons.transitionSeason(
      closedSeason.id,
      closedSeason.version,
      "signups_closed",
    );
    const { season: archivedSeason } = runtime.core.setup.createSeason({
      year: 2029,
      displayName: "Archived Synthetic Porchfest",
      timezone: "UTC",
      eventDate: "2029-06-01",
      eventCity: "Exampleton",
      eventState: "WI",
      localityName: "Archived Quarter",
      timeSlots: [],
      openSignups: true,
    });
    runtime.core.seasons.transitionSeason(
      archivedSeason.id,
      archivedSeason.version,
      "archived",
    );

    const response = await runtime.request(`${PUBLIC_BASE_URL}/signup/host`);
    const html = await response.text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

    expect(response.status).toBe(200);
    expect(html).toContain('data-signup-form="host"');
    expect(html).toContain(`name="season_id" value="${seasonId}"`);
    expect(html).toContain("Synthetic 2031 Porchfest");
    expect(html).not.toContain("Closed Synthetic Porchfest");
    expect(html).not.toContain("Archived Synthetic Porchfest");
    expect(html).not.toContain("Choose a Porchfest season");
    expect(html).not.toContain('class="error-summary"');
    expect(token).toBeTruthy();

    const submitted = await submit(
      runtime,
      "/signup/host",
      hostValues(seasonId, token),
    );
    expect(submitted.status).toBe(201);
  });

  it("offers only signup-legal seasons with identifying context", async () => {
    const { runtime } = await makeRuntime();
    const { season: assigningSeason } = runtime.core.setup.createSeason({
      year: 2032,
      displayName: "Synthetic 2032 Porchfest",
      timezone: "UTC",
      eventDate: "2032-07-04",
      eventCity: "Sample City",
      eventState: "MN",
      localityName: "Sample Ward",
      timeSlots: [],
      openSignups: true,
    });
    runtime.core.seasons.transitionSeason(
      assigningSeason.id,
      assigningSeason.version,
      "assigning",
    );
    const { season: closedSeason } = runtime.core.setup.createSeason({
      year: 2033,
      displayName: "Closed 2033 Porchfest",
      timezone: "UTC",
      eventDate: "2033-08-01",
      eventCity: "Closed City",
      eventState: "IA",
      localityName: "Closed Ward",
      timeSlots: [],
      openSignups: true,
    });
    runtime.core.seasons.transitionSeason(
      closedSeason.id,
      closedSeason.version,
      "signups_closed",
    );
    const { season: archivedSeason } = runtime.core.setup.createSeason({
      year: 2034,
      displayName: "Archived 2034 Porchfest",
      timezone: "UTC",
      eventDate: "2034-09-01",
      eventCity: "Archived City",
      eventState: "IL",
      localityName: "Archived Ward",
      timeSlots: [],
      openSignups: true,
    });
    runtime.core.seasons.transitionSeason(
      archivedSeason.id,
      archivedSeason.version,
      "archived",
    );

    const listSeasons = vi.fn(() => runtime.core.setup.listSeasons());
    const app = createApp({
      core: {
        ...runtime.core,
        setup: { ...runtime.core.setup, listSeasons },
      },
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    const response = await app.request(`${PUBLIC_BASE_URL}/signup/host`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Choose a Porchfest season");
    expect(html).toContain("Synthetic 2031 Porchfest");
    expect(html).toContain("Synthetic 2032 Porchfest");
    expect(html).toContain("June 1, 2031");
    expect(html).toContain("July 4, 2032");
    expect(html).toContain("Synthetic Quarter, WI");
    expect(html).toContain("Sample Ward, MN");
    expect(html).toContain("Accepting signups");
    expect(html).toContain("Building the schedule");
    expect(html).not.toContain("Closed 2033 Porchfest");
    expect(html).not.toContain("Archived 2034 Porchfest");
    expect(html).toContain('name="season"');
    expect(html.match(/name="season"/g)).toHaveLength(2);
    expect(html).not.toContain('data-signup-form="host"');
    expect(html).not.toContain('name="season_id"');
    expect(html).toContain('class="signup-single-column"');
    expect(html).not.toContain('class="signup-layout"');
    expect(listSeasons).toHaveBeenCalledTimes(1);
  });

  it("repeats the selected season on both forms and explains performer slots", async () => {
    const { runtime, seasonId } = await makeRuntime({
      timeSlots: [
        { startsAt: "14:00", endsAt: "14:45" },
        { startsAt: "16:00", endsAt: "16:45" },
      ],
    });

    const host = await csrfToken(runtime, "/signup/host", seasonId);
    const performer = await csrfToken(runtime, "/signup/performer", seasonId);

    for (const html of [host.html, performer.html]) {
      expect(html).toContain("Selected Porchfest");
      expect(html).toContain("Synthetic 2031 Porchfest");
      expect(html).toContain("June 1, 2031");
      expect(html).toContain("Synthetic Quarter, WI");
      expect(html).toContain("Accepting signups");
    }
    expect(performer.html).toContain("Published performance slots");
    expect(performer.html).toContain("2:00–2:45 PM");
    expect(performer.html).toContain("4:00–4:45 PM");
    expect(performer.html).toContain(
      "Your availability does not need to match a published slot exactly",
    );
    expect(performer.html).toContain(
      "Include the setup and teardown buffer your full act needs",
    );
  });

  it("refuses a direct closed-season request without participant fields", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const season = runtime.core.seasons.getSeason(seasonId);
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "signups_closed",
    );

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/performer?season=${seasonId}`,
    );
    const html = await response.text();

    expect(response.status).toBe(409);
    expect(html).toContain("Signups are not open for that Porchfest season");
    expect(html).not.toContain('data-signup-form="performer"');
    expect(html).not.toContain('name="contact_name"');
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

  it("labels every host and performer field with the canonical audience before submission", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const host = await csrfToken(runtime, "/signup/host", seasonId);
    const performer = await csrfToken(runtime, "/signup/performer", seasonId);

    for (const [field, audience] of Object.entries(EXPECTED_HOST_AUDIENCES)) {
      expect(host.html).toContain(
        `data-audience-field="${field}" data-audience-label="${audience}"`,
      );
    }
    for (const [field, audience] of Object.entries(
      EXPECTED_PERFORMER_AUDIENCES,
    )) {
      expect(performer.html).toContain(
        `data-audience-field="${field}" data-audience-label="${audience}"`,
      );
    }
    expect(host.html).toContain(
      "No means there is no covered or indoor backup space; organizers and a confirmed match will need to plan accordingly",
    );
    expect(host.html).toContain(
      "A checked amenity is available to the performers matched with your porch",
    );
    expect(host.html).toContain(
      "Your full street address will appear on the public map",
    );
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

  it("lets the live preview read only server-approved public fields", async () => {
    const { runtime } = await makeRuntime();
    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/signup/assets/signup-preview.js`,
    );
    const source = await response.text();

    for (const scenario of [
      {
        kind: "host",
        fields: {
          title: "venue_title",
          subtitle: "venue_address",
        },
        hasDescription: false,
        values: {
          venue_title: "Public porch",
          venue_address: "Public address",
          space_description: "PRIVATE SPACE",
          has_power: "yes",
          rain_backup: "yes",
        },
        expectedReads: ["venue_title", "venue_address"],
      },
      {
        kind: "performer",
        fields: {
          title: "act_name",
          subtitle: "genres",
          description: "description",
        },
        hasDescription: true,
        values: {
          act_name: "Public act",
          genres: "Public genre",
          description: "Public description",
          duration_minutes: "125",
          requires_amplification: "yes",
        },
        expectedReads: ["act_name", "genres", "description"],
      },
    ] as const) {
      const reads: string[] = [];
      const nodes = {
        title: { textContent: "" },
        subtitle: { textContent: "" },
        description: { textContent: "" },
      };
      const preview = {
        getAttribute: (name: string) => {
          const slot = name.match(/^data-preview-(.+)-field$/)?.[1] as
            keyof typeof scenario.fields | undefined;
          return slot ? scenario.fields[slot] : null;
        },
        querySelector: (selector: string) => {
          if (selector === "[data-preview-title]") return nodes.title;
          if (selector === "[data-preview-subtitle]") return nodes.subtitle;
          if (selector === "[data-preview-description]")
            return scenario.hasDescription ? nodes.description : null;
          return null;
        },
      };
      const form = {
        addEventListener: () => undefined,
        elements: {
          namedItem: (name: string) => {
            reads.push(name);
            const value = scenario.values[name as keyof typeof scenario.values];
            return value === undefined ? null : { value };
          },
        },
        getAttribute: () => scenario.kind,
      };

      runInNewContext(source, {
        document: {
          querySelector: (selector: string) => {
            if (selector === "[data-signup-preview]") return preview;
            if (selector === "[data-signup-form]") return form;
            return null;
          },
        },
      });

      expect(reads).toEqual(scenario.expectedReads);
      expect(
        Object.values(nodes).map(({ textContent }) => textContent),
      ).not.toContain("PRIVATE SPACE");
      expect(
        Object.values(nodes).map(({ textContent }) => textContent),
      ).not.toContain("125");
      expect(
        Object.values(nodes).map(({ textContent }) => textContent),
      ).not.toContain("Amplified");
    }
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
      requestedActNames: "The Test Fixtures",
      genrePreferences: "Folk and acoustic rock",
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
      sharedMemberNote: "Drummer also plays in Fixture Friends",
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

  it("extracts mixed performer link prose into structured links and an organizer note", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerValues(seasonId, token);
    values.set(
      "links",
      "Listen at https://music.example.invalid/demo, then see https://band.example.invalid/about. Acoustic demo from last summer",
    );
    values.set("performer_notes", "Needs ten minutes to set up.");

    const response = await submit(runtime, "/signup/performer", values);
    const html = await response.text();
    const act = runtime.core.seasons
      .listActivityQueue(seasonId)
      .find(({ recordType }) => recordType === "act")?.record;

    expect(response.status).toBe(201);
    expect(act).toMatchObject({
      links:
        "https://music.example.invalid/demo\nhttps://band.example.invalid/about",
      notes:
        "Needs ten minutes to set up.\nLink note: Listen at then see Acoustic demo from last summer",
    });
    expect(html).toContain("https://music.example.invalid/demo");
    expect(html).toContain("https://band.example.invalid/about");
    expect(html).toContain(
      "Link note: Listen at then see Acoustic demo from last summer",
    );
    expect(html).not.toContain("Listen at https://music.example.invalid/demo");
  });

  it("drops a pure performer-link placeholder instead of persisting it", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const { token } = await csrfToken(runtime, "/signup/performer", seasonId);
    const values = performerValues(seasonId, token);
    values.set("links", "n/a");

    const response = await submit(runtime, "/signup/performer", values);
    const html = await response.text();
    const act = runtime.core.seasons
      .listActivityQueue(seasonId)
      .find(({ recordType }) => recordType === "act")?.record;

    expect(response.status).toBe(201);
    expect(act).toMatchObject({ links: "", notes: null });
    expect(html).not.toContain('data-submission-field="links"');
    expect(html).not.toContain("Link note:");
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

  it("advertises participant self-service on the landing page and receipt only when enabled", async () => {
    const disabled = await makeRuntime();
    const enabled = await makeRuntime({ email: new ConfiguredEmail() });

    const disabledLanding = await (
      await disabled.runtime.request(`${PUBLIC_BASE_URL}/`)
    ).text();
    const enabledLanding = await (
      await enabled.runtime.request(`${PUBLIC_BASE_URL}/`)
    ).text();
    expect(disabledLanding).not.toContain("/self-serve/request-link");
    expect(enabledLanding).toContain('href="/self-serve/request-link"');
    expect(enabledLanding).toContain("Manage your signup");

    for (const [fixture, isEnabled] of [
      [disabled, false],
      [enabled, true],
    ] as const) {
      const { token } = await csrfToken(
        fixture.runtime,
        "/signup/host",
        fixture.seasonId,
      );
      const receipt = await submit(
        fixture.runtime,
        "/signup/host",
        hostValues(fixture.seasonId, token),
      );
      const html = await receipt.text();
      expect(receipt.status).toBe(201);
      expect(html.includes('href="/self-serve/request-link"')).toBe(isEnabled);
      expect(
        html.includes("Participant self-service is not available yet"),
      ).toBe(!isEnabled);
    }
  });

  it("keeps match and organizer answers out of public receipt previews", async () => {
    const { runtime, seasonId } = await makeRuntime();
    const hostForm = await csrfToken(runtime, "/signup/host", seasonId);
    const hostInput = hostValues(seasonId, hostForm.token);
    hostInput.set("space_description", "PRIVATE HOST SPACE");
    hostInput.set("has_power", "yes");
    hostInput.set("rain_backup", "yes");
    const hostResponse = await submit(runtime, "/signup/host", hostInput);
    const hostHtml = await hostResponse.text();
    const performerForm = await csrfToken(
      runtime,
      "/signup/performer",
      seasonId,
    );
    const performerResponse = await submit(
      runtime,
      "/signup/performer",
      performerValues(seasonId, performerForm.token),
    );
    const performerHtml = await performerResponse.text();

    expect(hostResponse.status).toBe(201);
    expect(performerResponse.status).toBe(201);
    const hostPreview = publicPreviewFrom(hostHtml, "host");
    expect(hostPreview).toContain('data-preview-title-field="venue_title"');
    expect(hostPreview).toContain(
      'data-preview-subtitle-field="venue_address"',
    );
    expect(hostPreview).toContain("The Test Porch");
    expect(hostPreview).toContain("Synthetic Venue Address");
    expect(hostPreview).not.toContain("data-preview-description-field");
    expect(hostPreview).not.toContain("Keep filling in the form");
    expect(hostPreview).not.toContain("PRIVATE HOST SPACE");
    expect(hostPreview).not.toContain("Power available");
    expect(hostPreview).not.toContain("Rain backup");
    expect(hostHtml).toContain("PRIVATE HOST SPACE");

    const performerPreview = publicPreviewFrom(performerHtml, "performer");
    expect(performerPreview).toContain('data-preview-title-field="act_name"');
    expect(performerPreview).toContain('data-preview-subtitle-field="genres"');
    expect(performerPreview).toContain(
      'data-preview-description-field="description"',
    );
    expect(performerPreview).toContain("The Test Fixtures");
    expect(performerPreview).toContain("Folk, rock");
    expect(performerPreview).toContain("Songs with harmonies &amp; handclaps.");
    expect(performerPreview).not.toContain("45 minutes");
    expect(performerPreview).not.toContain("Amplified");
    expect(performerHtml).toContain("45 minutes");
  });

  it("gives both receipts distinct non-secret references and links the configured public site", async () => {
    const publicSiteUrl = "https://festival.example.invalid/contact";
    const { runtime, seasonId } = await makeRuntime({ publicSiteUrl });
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
    const hostHtml = await hostReceipt.text();
    const performerHtml = await performerReceipt.text();
    const hostReference = hostHtml.match(
      /data-submission-reference="([^"]+)"/,
    )?.[1];
    const performerReference = performerHtml.match(
      /data-submission-reference="([^"]+)"/,
    )?.[1];

    expect(hostReceipt.status).toBe(201);
    expect(performerReceipt.status).toBe(201);
    expect(hostReference).toMatch(/^HOST-\d+$/);
    expect(performerReference).toMatch(/^PERFORMER-\d+$/);
    expect(hostReference).not.toBe(performerReference);
    for (const html of [hostHtml, performerHtml]) {
      expect(html).toContain(
        "Quote this reference when contacting the organizers",
      );
      expect(html).toContain(
        "cannot be reopened to edit or withdraw your signup, or to check its status",
      );
      expect(html).toContain("Participant self-service is not available yet");
      expect(html).toContain(`href="${publicSiteUrl}"`);
    }
  });

  it("directs both receipts back to the original public organizer channel when no public site is configured", async () => {
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

    for (const response of [hostReceipt, performerReceipt]) {
      const html = await response.text();
      expect(response.status).toBe(201);
      expect(html).toContain(
        "Keep this reference and use the same public organizer channel that supplied this form",
      );
      expect(html).not.toContain("festival.example.invalid");
    }
  });

  it("keeps canonical audiences aligned from both forms through receipts and a match message", async () => {
    const { runtime, seasonId } = await makeRuntime({
      year: CURRENT_YEAR,
      bounds: { north: 45, south: 44, east: -93, west: -94 },
      timeSlots: [{ startsAt: "14:00", endsAt: "15:00" }],
    });
    const hostForm = await csrfToken(runtime, "/signup/host", seasonId);
    const hostInput = hostValues(seasonId, hostForm.token);
    hostInput.set(
      "requested_act_names",
      "ORGANIZER_ONLY_REQUESTED_ACT_SENTINEL",
    );
    const hostResponse = await submit(runtime, "/signup/host", hostInput);
    const hostReceipt = await hostResponse.text();
    const performerForm = await csrfToken(
      runtime,
      "/signup/performer",
      seasonId,
    );
    const performerInput = performerValues(seasonId, performerForm.token);
    performerInput.set("duration_minutes", "125");
    performerInput.delete("availability_start");
    performerInput.delete("availability_end");
    performerInput.set("availability_start", `${CURRENT_YEAR}-06-01T12:34`);
    performerInput.set("availability_end", `${CURRENT_YEAR}-06-01T17:56`);
    performerInput.set(
      "performer_notes",
      "ORGANIZER_ONLY_PERFORMER_NOTE_SENTINEL",
    );
    const performerResponse = await submit(
      runtime,
      "/signup/performer",
      performerInput,
    );
    const performerReceipt = await performerResponse.text();

    expect(hostResponse.status).toBe(201);
    expect(performerResponse.status).toBe(201);
    for (const [field, audience] of Object.entries(EXPECTED_HOST_AUDIENCES)) {
      expect(hostReceipt).toContain(
        `data-submission-field="${field}" data-audience-label="${audience}"`,
      );
    }
    for (const [field, audience] of Object.entries(
      EXPECTED_PERFORMER_AUDIENCES,
    )) {
      if (field === "availability_end") continue;
      expect(performerReceipt).toContain(
        `data-submission-field="${field}" data-audience-label="${audience}"`,
      );
    }

    const queue = runtime.core.seasons.listActivityQueue(seasonId);
    const venueItem = queue.find(({ recordType }) => recordType === "venue");
    const actItem = queue.find(({ recordType }) => recordType === "act");
    expect(venueItem?.recordType).toBe("venue");
    expect(actItem?.recordType).toBe("act");
    if (venueItem?.recordType !== "venue" || actItem?.recordType !== "act") {
      throw new Error("expected submitted venue and act records");
    }
    const venue = venueItem.record;
    const act = actItem.record;
    const slot = runtime.core.seasons.listVenueSlots(venue.id)[0];
    expect(slot).toBeDefined();
    runtime.core.seasons.assignSlot(slot!.id, slot!.version, act.id);
    const generated = runtime.core.outbox.generateWave({
      seasonId,
      kind: "match",
    });
    const message = generated.messages[0]?.textBody ?? "";

    for (const sharedValue of [
      "Synthetic Host",
      "host@example.invalid",
      "synthetic-host-phone",
      "Synthetic Performer",
      "performer@example.invalid",
      "synthetic-performer-phone",
      "Front porch, yard, and driveway",
      "Power: Yes",
      "No indoor backup",
      "PA",
      "microphone",
      "extension cord",
      "water",
      "non-alcoholic drinks",
      "seating",
      "shade",
      "accessible entry",
      "Use the side gate & wave.",
      "The Test Fixtures requires amplification",
    ]) {
      expect(message).toContain(sharedValue);
    }
    for (const organizerOnlyValue of [
      "ORGANIZER_ONLY_REQUESTED_ACT_SENTINEL",
      "Folk and acoustic rock",
      "125",
      "12:34",
      "17:56",
      "Near the park",
      "Drummer also plays in Fixture Friends",
      "ORGANIZER_ONLY_PERFORMER_NOTE_SENTINEL",
      "can lend gear",
    ]) {
      expect(message).not.toContain(organizerOnlyValue);
    }

    runtime.core.geocoding.verifyVenueCoordinate(
      venue.id,
      { latitude: 44.98, longitude: -93.19 },
      null,
      venue.version,
    );
    const currentSeason = runtime.core.seasons.getSeason(seasonId);
    const locked = runtime.core.seasons.transitionSeason(
      seasonId,
      currentSeason.version,
      "locked",
    );
    runtime.core.seasons.publishSeasonMap(locked.id, locked.version, {
      eventCity: locked.eventCity,
      eventState: locked.eventState,
    });
    const mapResponse = await runtime.request(
      `${PUBLIC_BASE_URL}/map/data.json`,
    );
    const mapDocument = (await mapResponse.json()) as VenuesMapDocument;
    const mapVenue = mapDocument.venues[0];
    const mapAct = mapVenue?.acts[0];
    expect(mapResponse.status).toBe(200);
    expect(mapVenue).toBeDefined();
    expect(mapAct).toBeDefined();
    if (!mapVenue || !mapAct) throw new Error("expected a published map match");

    expect(mapVenue).toMatchObject({
      title: "Synthetic Venue Address",
      address: "Synthetic Venue Address",
    });
    expect(mapAct).toMatchObject({
      name: "The Test Fixtures",
      genre: "Folk, rock",
      description: "Songs with harmonies & handclaps.",
      links: [{ url: "https://example.invalid/the-test-fixtures" }],
    });
    for (const nonPublicField of [
      "space_description",
      "has_power",
      "rain_backup",
      "gear",
      "drinks",
      "amenities",
    ]) {
      expect(mapVenue).not.toHaveProperty(nonPublicField);
    }
    for (const nonPublicField of [
      "duration_minutes",
      "requires_amplification",
    ]) {
      expect(mapAct).not.toHaveProperty(nonPublicField);
    }
    const publicMapJson = JSON.stringify(mapDocument);
    for (const nonPublicValue of [
      "Synthetic Host",
      "host@example.invalid",
      "synthetic-host-phone",
      "Synthetic Performer",
      "performer@example.invalid",
      "synthetic-performer-phone",
      "Front porch, yard, and driveway",
      "Use the side gate & wave.",
      "ORGANIZER_ONLY_REQUESTED_ACT_SENTINEL",
      "Folk and acoustic rock",
      "Near the park",
      "Drummer also plays in Fixture Friends",
      "ORGANIZER_ONLY_PERFORMER_NOTE_SENTINEL",
    ]) {
      expect(publicMapJson).not.toContain(nonPublicValue);
    }
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
