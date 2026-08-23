// The Tuesday-night loop at the HTTP layer: see what is new, open a record, fix a
// typo, and be told rather than overwritten when someone else got there first.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";

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

async function boot() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-admin-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "admin-records-test-secret",
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
  const alice = await cookieFor(
    bootstrapToken,
    "Alice",
    "alice@example.invalid",
  );

  const { season } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "UTC",
    eventDate: "2031-09-13",
    timeSlots: [],
    openSignups: true,
  });

  const invite = runtime.core.access.issueInvite(
    "bob@example.invalid",
    runtime.core.access.listOrganizers()[0]?.id ?? 0,
  );
  const bob = await cookieFor(invite.token, "Bob");

  const signup = runtime.core.seasons.createHostSignup({
    seasonId: season.id,
    contact: { name: "Host", email: "host@example.invalid", phone: null },
    venue: {
      title: "The Test Porch",
      address: "1 Test St",
      spaceDescription: "Porch",
      hasPower: true,
      rainBackup: false,
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });

  return { runtime, season, alice, bob, signup };
}

function get(runtime: PorchfestRuntime, path: string, cookie: string) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, { headers: { cookie } });
}

async function post(
  runtime: PorchfestRuntime,
  path: string,
  cookie: string,
  body: URLSearchParams,
) {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      origin: PUBLIC_BASE_URL,
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

async function csrfFrom(response: Response) {
  return (
    (await response.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? ""
  );
}

describe("the activity queue", () => {
  it("shows a new signup to an organizer", async () => {
    const { runtime, season, alice } = await boot();

    const page = await get(runtime, `/admin?season=${season.id}`, alice);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("The Test Porch");
    expect(html).toContain("need your review");
  });

  it("clears an item for one organizer without hiding it from another", async () => {
    const { runtime, season, alice, bob, signup } = await boot();
    const page = await get(runtime, `/admin?season=${season.id}`, alice);
    const csrf = await csrfFrom(page);

    const dismissed = await post(
      runtime,
      "/admin/queue/dismiss",
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        record_type: "venue",
        record_id: String(signup.venue.id),
        version: String(signup.venue.version),
      }),
    );
    expect(dismissed.status).toBe(303);

    const aliceAfter = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();
    const bobAfter = await (
      await get(runtime, `/admin?season=${season.id}`, bob)
    ).text();

    // R5. Alice's "reviewed" is Alice's alone.
    expect(aliceAfter).toContain("Everything in this season");
    expect(bobAfter).toContain("need your review");
  });

  it("brings a record back after a participant edits it", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(runtime, `/admin?season=${season.id}`, alice);
    await post(
      runtime,
      "/admin/queue/dismiss",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page),
        season: String(season.id),
        record_type: "venue",
        record_id: String(signup.venue.id),
        version: String(signup.venue.version),
      }),
    );

    runtime.core.seasons.updateVenue(signup.venue.id, signup.venue.version, {
      address: "2 Corrected St",
    });

    // R15.
    const after = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();
    expect(after).toContain("need your review");
  });

  it("refuses the queue to someone who is not signed in", async () => {
    const { runtime, season } = await boot();

    const page = await runtime.request(
      `${PUBLIC_BASE_URL}/admin?season=${season.id}`,
    );

    expect(page.status).toBe(401);
  });
});

describe("the record editor", () => {
  it("saves a corrected field", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const csrf = await csrfFrom(page);

    const saved = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: String(signup.venue.version),
        title: "The Oak Street Porch",
        address: "2205 Scudder St",
        spaceDescription: "Porch",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );

    expect(saved.status).toBe(303);
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.title).toBe(
      "The Oak Street Porch",
    );
  });

  it("names the conflict instead of overwriting a newer save", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const csrf = await csrfFrom(page);
    const staleVersion = signup.venue.version;

    // Bob saves first, straight through core.
    runtime.core.seasons.updateVenue(signup.venue.id, staleVersion, {
      title: "Bob's Title",
    });

    const refused = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: String(staleVersion),
        title: "Alice's Title",
        address: "1 Test St",
        spaceDescription: "Porch",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );
    const html = await refused.text();

    // R32 / AE11: refused, named, and Alice's typing survives.
    expect(refused.status).toBe(409);
    expect(html).toContain("Someone else saved this first");
    expect(html).toContain("Alice&#39;s Title");
    expect(html).toContain("Bob&#39;s Title");
    // The stored value is unchanged: a refusal is not a partial write.
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.title).toBe(
      "Bob's Title",
    );
  });

  it("re-arms the refused form so a second save can go through", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const csrf = await csrfFrom(page);
    runtime.core.seasons.updateVenue(signup.venue.id, signup.venue.version, {
      title: "Bob's Title",
    });

    const refused = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: String(signup.venue.version),
        title: "Alice's Title",
        address: "1 Test St",
        spaceDescription: "Porch",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );
    const refreshedVersion =
      (await refused.text()).match(/name="version" value="(\d+)"/)?.[1] ?? "";

    const second = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: refreshedVersion,
        title: "Alice's Title",
        address: "1 Test St",
        spaceDescription: "Porch",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );

    // A deliberate overwrite, one click later — not a retype.
    expect(second.status).toBe(303);
  });

  it("leaves the original submission readable after an edit", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );

    await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page),
        season: String(season.id),
        version: String(signup.venue.version),
        title: "Renamed",
        address: "1 Test St",
        spaceDescription: "Porch",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );

    // R6: the contact who submitted it is untouched by a venue rename.
    const contact = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "contact");
    expect(contact?.recordType === "contact" && contact.record.email).toBe(
      "host@example.invalid",
    );
  });

  it("refuses a record from a season the organizer did not ask for", async () => {
    const { runtime, alice, signup } = await boot();

    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=999`,
      alice,
    );

    expect(page.status).toBe(404);
  });

  it("refuses the editor to someone who is not signed in", async () => {
    const { runtime, season, signup } = await boot();

    const page = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/records/venue/${signup.venue.id}?season=${season.id}`,
    );

    expect(page.status).toBe(401);
  });
});
