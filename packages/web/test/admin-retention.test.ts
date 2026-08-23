// R35 at the HTTP boundary: organizers can identify expired participant data,
// deliberately anonymize one participant, and hand the backup half to operators.
import { ANONYMIZED_CONTACT_NAME } from "@porchfest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function boot() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-15T12:00:00.000Z"));
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "porchfest-retention-web-"),
  );
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "admin-retention-test-secret",
      PORCHFEST_RETENTION_MONTHS: "18",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);

  const cookieFor = async (token: string, name: string, email?: string) => {
    const page = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/sign-in?token=${token}`,
    );
    const csrf =
      (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
    const body = new URLSearchParams({
      _csrf: csrf,
      token,
      display_name: name,
    });
    if (email) body.set("email", email);
    const signedIn = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
      method: "POST",
      headers: {
        origin: PUBLIC_BASE_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    return (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  };

  const bootstrapToken =
    announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  await cookieFor(
    bootstrapToken,
    "Initial Organizer",
    "organizer@example.invalid",
  );
  const { season } = runtime.core.setup.createSeason({
    year: 2030,
    displayName: "Synthetic Retention Season",
    timezone: "UTC",
    eventDate: "2030-09-14",
    timeSlots: [],
    openSignups: true,
  });
  const signup = runtime.core.seasons.createHostSignup({
    seasonId: season.id,
    contact: {
      name: "Synthetic Host",
      email: "synthetic-host@example.invalid",
      phone: "synthetic-host-phone",
    },
    venue: {
      title: "Synthetic Porch",
      address: "synthetic-host-address",
      spaceDescription: "Synthetic space",
      hasPower: true,
      rainBackup: false,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });

  vi.setSystemTime(new Date("2033-01-15T12:00:00.000Z"));
  const organizerId = runtime.core.access.listOrganizers()[0]?.id ?? 0;
  const invite = runtime.core.access.issueInvite(
    "current-organizer@example.invalid",
    organizerId,
  );
  const cookie = await cookieFor(invite.token, "Current Organizer");
  return { runtime, season, signup, cookie };
}

function get(runtime: PorchfestRuntime, path: string, cookie: string) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, { headers: { cookie } });
}

function post(
  runtime: PorchfestRuntime,
  path: string,
  cookie: string,
  body: URLSearchParams,
  origin = PUBLIC_BASE_URL,
) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      origin,
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

async function csrfFrom(response: Response, action: string) {
  const html = await response.text();
  const pattern = new RegExp(
    `action="${action.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"[\\s\\S]{0,500}?name="_csrf" value="([^"]+)"`,
  );
  return html.match(pattern)?.[1] ?? "";
}

describe("the organizer retention surface", () => {
  it("lists eligible participants under the configured window without changing them", async () => {
    const { runtime, season, signup, cookie } = await boot();

    const queue = await get(runtime, `/admin?season=${season.id}`, cookie);
    expect(await queue.text()).toContain('href="/admin/retention"');

    const page = await get(runtime, "/admin/retention", cookie);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store, private");
    expect(html).toContain("18-month retention window");
    expect(html).toContain("Synthetic Host");
    expect(html).toContain(
      `action="/admin/retention/${signup.contact.id}/anonymize"`,
    );
    expect(html).toContain("cannot be undone");
    expect(runtime.core.retention.listReceipts()).toHaveLength(0);
    expect(
      runtime.core.queue
        .listForOrganizer(season.id, 1)
        .some(
          (item) =>
            item.recordType === "contact" &&
            item.record.name === "Synthetic Host",
        ),
    ).toBe(true);
  });

  it("anonymizes one participant and renders the pending backup receipt", async () => {
    const { runtime, season, signup, cookie } = await boot();
    const action = `/admin/retention/${signup.contact.id}/anonymize`;
    const page = await get(runtime, "/admin/retention", cookie);

    const response = await post(
      runtime,
      action,
      cookie,
      new URLSearchParams({
        _csrf: await csrfFrom(page, action),
        version: String(signup.contact.version),
        confirmation: "anonymize",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/admin/retention?anonymized=1",
    );
    expect(
      runtime.core.queue
        .listForOrganizer(season.id, 1)
        .find((item) => item.recordType === "contact")?.record,
    ).toMatchObject({
      name: ANONYMIZED_CONTACT_NAME,
      email: null,
      phone: null,
    });

    const receiptPage = await get(runtime, "/admin/retention", cookie);
    const receiptHtml = await receiptPage.text();
    expect(receiptHtml).toContain("Application data anonymized");
    expect(receiptHtml).toContain("Backup rotation pending");
    expect(receiptHtml).toContain("awaiting the next backup cycle");
    expect(receiptHtml).not.toContain("Deletion complete");
  });

  it("refuses a stale version, names the conflict, and leaves identity intact", async () => {
    const { runtime, season, signup, cookie } = await boot();
    const action = `/admin/retention/${signup.contact.id}/anonymize`;
    const page = await get(runtime, "/admin/retention", cookie);
    const csrf = await csrfFrom(page, action);
    vi.setSystemTime(new Date("2030-02-15T12:00:00.000Z"));
    runtime.core.seasons.updateContact(
      signup.contact.id,
      signup.contact.version,
      { name: "Synthetic Host revised" },
    );
    vi.setSystemTime(new Date("2033-01-15T12:00:00.000Z"));

    const refused = await post(
      runtime,
      action,
      cookie,
      new URLSearchParams({
        _csrf: csrf,
        version: String(signup.contact.version),
        confirmation: "anonymize",
      }),
    );
    const html = await refused.text();

    expect(refused.status).toBe(409);
    expect(html).toContain("Synthetic Host revised");
    expect(html).toContain("changed since you opened this page");
    expect(runtime.core.retention.listReceipts()).toHaveLength(0);
    expect(
      runtime.core.queue
        .listForOrganizer(season.id, 1)
        .find((item) => item.recordType === "contact")?.record.name,
    ).toBe("Synthetic Host revised");
  });

  it("requires the organizer's explicit irreversible-action confirmation", async () => {
    const { runtime, signup, cookie } = await boot();
    const action = `/admin/retention/${signup.contact.id}/anonymize`;
    const page = await get(runtime, "/admin/retention", cookie);

    const refused = await post(
      runtime,
      action,
      cookie,
      new URLSearchParams({
        _csrf: await csrfFrom(page, action),
        version: String(signup.contact.version),
      }),
    );

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Confirm this irreversible action");
    expect(runtime.core.retention.listReceipts()).toHaveLength(0);
  });

  it("refuses unauthenticated requests to both retention routes", async () => {
    const { runtime, signup } = await boot();

    expect(
      (await runtime.request(`${PUBLIC_BASE_URL}/admin/retention`)).status,
    ).toBe(401);
    expect(
      (
        await runtime.request(
          `${PUBLIC_BASE_URL}/admin/retention/${signup.contact.id}/anonymize`,
          { method: "POST" },
        )
      ).status,
    ).toBe(401);
  });

  it("refuses a cookie-authenticated anonymization from another origin", async () => {
    const { runtime, signup, cookie } = await boot();
    const action = `/admin/retention/${signup.contact.id}/anonymize`;

    const refused = await post(
      runtime,
      action,
      cookie,
      new URLSearchParams(),
      "https://unrelated.example",
    );

    expect(refused.status).toBe(403);
    expect(runtime.core.retention.listReceipts()).toHaveLength(0);
  });
});
