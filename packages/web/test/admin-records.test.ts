// The Tuesday-night loop at the HTTP layer: see what is new, open a record, fix a
// typo, and be told rather than overwritten when someone else got there first.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeasonActionError, SeasonLifecycleError } from "@porchfest/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestingRuntime,
  type PorchfestRuntime,
  type PorchfestTestingRuntime,
} from "../src/composition.js";
import {
  lifecycleRefusal,
  placeholderSeasonRefusal,
} from "../src/routes/admin-records.js";
import { renderRecordPage } from "../src/views/admin-records.js";

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
  const runtime = await createTestingRuntime({
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

function createPerformer(
  runtime: PorchfestRuntime,
  seasonId: number,
  name: string,
  email: string,
) {
  return runtime.core.seasons.createPerformerSignup({
    seasonId,
    contact: { name: `${name} contact`, email, phone: null },
    act: {
      name,
      durationMinutes: 45,
      requiresAmplification: false,
      genre: "Test genre",
      description: `${name} description`,
      links: "",
      housePreference: null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [],
  });
}

function assignAct(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  venueId: number,
  actId: number,
  hour: number,
): void {
  const slot = runtime.coreTesting.createSlot({
    seasonId,
    venueId,
    startsAt: new Date(
      `2031-09-13T${String(hour).padStart(2, "0")}:00:00.000Z`,
    ),
    endsAt: new Date(
      `2031-09-13T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
    ),
  });
  runtime.core.seasons.assignSlot(slot.id, slot.version, actId);
}

/** A page can carry several forms, each with its own path-bound token, so pick
 *  the one belonging to the form under test rather than the first on the page. */
async function csrfFrom(response: Response, action?: string) {
  const html = await response.text();
  if (!action) return html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
  const pattern = new RegExp(
    `action="${action.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}"[\\s\\S]{0,400}?name="_csrf" value="([^"]+)"`,
  );
  return html.match(pattern)?.[1] ?? "";
}

describe("the activity queue", () => {
  it("shows a new signup to an organizer", async () => {
    const { runtime, season, alice } = await boot();

    const page = await get(runtime, `/admin?season=${season.id}`, alice);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("The Test Porch");
    expect(html).toContain("need your review");
    expect(html).toContain("/admin/placeholders/act/new");
    expect(html).toContain("/admin/placeholders/venue/new");
  });

  it("does not invite or arm placeholder creation after archival", async () => {
    const { runtime, season, alice } = await boot();
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const queueBody = await queue.text();
    const placeholder = await get(
      runtime,
      `/admin/placeholders/act/new?season=${season.id}`,
      alice,
    );
    const placeholderBody = await placeholder.text();

    expect(queue.status).toBe(200);
    expect(queueBody).not.toContain("/admin/placeholders/act/new");
    expect(queueBody).not.toContain("/admin/placeholders/venue/new");
    expect(queueBody).toContain("Review participant retention");
    expect(placeholder.status).toBe(409);
    expect(placeholderBody).toContain(
      "This season is archived, so placeholders can no longer be added.",
    );
    expect(placeholderBody).not.toContain('action="/admin/placeholders/act"');
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

describe("placeholder and supersession actions", () => {
  it("renders lifecycle forms while live and static values after archival", async () => {
    const { runtime, season, alice, signup } = await boot();
    const placeholder = runtime.core.seasons.createPlaceholderAct({
      seasonId: season.id,
      reach: { reachViaContactId: signup.contact.id },
      act: { name: "Read-only Placeholder" },
    });
    createPerformer(
      runtime,
      season.id,
      "Read-only Candidate",
      "read-only-candidate@example.invalid",
    );
    const recordPath = `/admin/records/act/${placeholder.id}`;

    const live = await get(runtime, `${recordPath}?season=${season.id}`, alice);
    const liveBody = await live.text();

    expect(live.status).toBe(200);
    for (const action of [
      `${recordPath}/status`,
      `${recordPath}/promote`,
      `${recordPath}/supersede`,
      recordPath,
    ]) {
      expect(liveBody).toContain(`action="${action}"`);
    }

    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );
    const archived = await get(
      runtime,
      `${recordPath}?season=${season.id}`,
      alice,
    );
    const archivedBody = await archived.text();

    expect(archived.status).toBe(200);
    expect(archivedBody).toContain(
      "This season is archived. Records can no longer be changed.",
    );
    for (const action of [
      `${recordPath}/status`,
      `${recordPath}/promote`,
      `${recordPath}/supersede`,
      recordPath,
    ]) {
      expect(archivedBody).not.toContain(`action="${action}"`);
    }
    expect(archivedBody).toContain(
      "<dt>Act name</dt><dd>Read-only Placeholder</dd>",
    );
    expect(archivedBody).toContain("<dt>Status</dt><dd>Tentative</dd>");
    expect(archivedBody).toContain("<dt>Genres</dt><dd>(empty)</dd>");
    expect(archivedBody).toContain("<dt>Amplification</dt><dd>(empty)</dd>");
    expect(archivedBody).toContain("<dt>Can lend gear</dt><dd>(empty)</dd>");
  });

  it("creates a host-reached act and promotes its real submission", async () => {
    const { runtime, season, alice, signup } = await boot();
    const createPage = await get(
      runtime,
      `/admin/placeholders/act/new?season=${season.id}`,
      alice,
    );
    const createHtml = await createPage.clone().text();

    expect(createPage.status).toBe(200);
    expect(createPage.headers.get("cache-control")).toBe("no-store, private");
    expect(createHtml).toContain('action="/admin/placeholders/act"');
    expect(createHtml).toContain('name="manual_email"');
    expect(createHtml).toContain(`value="${signup.contact.id}"`);

    const created = await post(
      runtime,
      "/admin/placeholders/act",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(createPage, "/admin/placeholders/act"),
        season: String(season.id),
        name: "The Host's Favorite Band",
        genre: "Folk",
        notes: "Reach them through the host.",
        reach_via_contact_id: String(signup.contact.id),
      }),
    );
    expect(created.status).toBe(303);

    const placeholder = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find(
        (item) =>
          item.recordType === "act" &&
          item.record.name === "The Host's Favorite Band",
      );
    expect(placeholder?.recordType).toBe("act");
    if (!placeholder || placeholder.recordType !== "act") {
      throw new Error("placeholder act was not created");
    }
    expect(placeholder.record).toMatchObject({
      placeholder: true,
      reachViaContactId: signup.contact.id,
    });

    const submission = createPerformer(
      runtime,
      season.id,
      "The Filed Band Name",
      "band@example.invalid",
    );
    const recordPage = await get(
      runtime,
      `/admin/records/act/${placeholder.record.id}?season=${season.id}`,
      alice,
    );
    const recordHtml = await recordPage.clone().text();
    expect(recordHtml).toContain(
      `action="/admin/records/act/${placeholder.record.id}/promote"`,
    );
    expect(recordHtml).toContain("The Filed Band Name");

    const promoted = await post(
      runtime,
      `/admin/records/act/${placeholder.record.id}/promote`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          recordPage,
          `/admin/records/act/${placeholder.record.id}/promote`,
        ),
        season: String(season.id),
        version: String(placeholder.record.version),
        submission: `${submission.act.id}:${submission.act.version}`,
      }),
    );

    expect(promoted.status).toBe(303);
    const acts = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .filter((item) => item.recordType === "act");
    expect(acts).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          id: placeholder.record.id,
          name: "The Filed Band Name",
          placeholder: false,
          reachViaContactId: submission.contact.id,
        }),
      }),
    );
    expect(acts.some((item) => item.record.id === submission.act.id)).toBe(
      false,
    );
  });

  it("creates a venue with a manually entered email address", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/placeholders/venue/new?season=${season.id}`,
      alice,
    );
    const created = await post(
      runtime,
      "/admin/placeholders/venue",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page, "/admin/placeholders/venue"),
        season: String(season.id),
        title: "The Future Porch",
        address: "22 Future St",
        manual_name: "Future host",
        manual_email: "future@example.invalid",
      }),
    );

    expect(created.status).toBe(303);
    const venue = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find(
        (item) =>
          item.recordType === "venue" &&
          item.record.title === "The Future Porch",
      );
    expect(venue?.recordType === "venue" && venue.record.placeholder).toBe(
      true,
    );
    const reachContact = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find(
        (item) =>
          item.recordType === "contact" &&
          item.record.email === "future@example.invalid",
      );
    expect(
      venue?.recordType === "venue" &&
        reachContact?.recordType === "contact" &&
        venue.record.reachViaContactId === reachContact.record.id,
    ).toBe(true);
    if (!venue || venue.recordType !== "venue") {
      throw new Error("placeholder venue was not created");
    }

    const recordPage = await get(
      runtime,
      `/admin/records/venue/${venue.record.id}?season=${season.id}`,
      alice,
    );
    expect(await recordPage.clone().text()).toContain("The Test Porch");
    const promoted = await post(
      runtime,
      `/admin/records/venue/${venue.record.id}/promote`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          recordPage,
          `/admin/records/venue/${venue.record.id}/promote`,
        ),
        season: String(season.id),
        version: String(venue.record.version),
        submission: `${signup.venue.id}:${signup.venue.version}`,
      }),
    );
    expect(promoted.status).toBe(303);
    const venues = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .filter((item) => item.recordType === "venue");
    expect(venues).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          id: venue.record.id,
          title: "The Test Porch",
          placeholder: false,
        }),
      }),
    );
    expect(venues.some((item) => item.record.id === signup.venue.id)).toBe(
      false,
    );
  });

  it("refuses a selected contact that became stale instead of creating a duplicate", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/placeholders/act/new?season=${season.id}`,
      alice,
    );
    const canonical = runtime.core.seasons.createHostSignup({
      seasonId: season.id,
      contact: { name: "Current contact", email: "current@example.invalid" },
      venue: {
        title: "Current Porch",
        address: "3 Current St",
        spaceDescription: "Porch",
        hasPower: true,
        rainBackup: false,
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    });
    runtime.core.seasons.supersedeContact(
      signup.contact.id,
      signup.contact.version,
      canonical.contact.id,
    );

    const refused = await post(
      runtime,
      "/admin/placeholders/act",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page, "/admin/placeholders/act"),
        season: String(season.id),
        name: "Should Not Exist",
        reach_via_contact_id: String(signup.contact.id),
        manual_name: "Accidental duplicate",
        manual_email: "duplicate@example.invalid",
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(400);
    expect(body).toContain("selected contact is no longer available");
    expect(body).toContain('value="Should Not Exist"');
    expect(
      runtime.core.queue
        .listForOrganizer(season.id, 1)
        .some(
          (item) =>
            item.recordType === "contact" &&
            item.record.email === "duplicate@example.invalid",
        ),
    ).toBe(false);
  });

  it("uses the signup email rule for manually reached placeholders", async () => {
    const { runtime, season, alice } = await boot();
    const page = await get(
      runtime,
      `/admin/placeholders/venue/new?season=${season.id}`,
      alice,
    );

    const refused = await post(
      runtime,
      "/admin/placeholders/venue",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page, "/admin/placeholders/venue"),
        season: String(season.id),
        title: "Bad Email Porch",
        manual_name: "Host",
        manual_email: "host@gmail",
      }),
    );

    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("valid email address");
  });

  it("re-renders an archived-season placeholder with the typed values", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/placeholders/act/new?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      "/admin/placeholders/act",
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page, "/admin/placeholders/act"),
        season: String(season.id),
        name: "Preserved Archived Act",
        reach_via_contact_id: String(signup.contact.id),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("This season is archived");
    expect(body).toContain('value="Preserved Archived Act"');
  });

  it("renders an assigned-act promotion collision as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const placeholder = runtime.core.seasons.createPlaceholderAct({
      seasonId: season.id,
      reach: { reachViaContactId: signup.contact.id },
      act: { name: "Assigned Placeholder" },
    });
    const submission = createPerformer(
      runtime,
      season.id,
      "Assigned Submission",
      "assigned-submission@example.invalid",
    );
    assignAct(runtime, season.id, signup.venue.id, placeholder.id, 14);
    assignAct(runtime, season.id, signup.venue.id, submission.act.id, 16);
    const page = await get(
      runtime,
      `/admin/records/act/${placeholder.id}?season=${season.id}`,
      alice,
    );

    const refused = await post(
      runtime,
      `/admin/records/act/${placeholder.id}/promote`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/act/${placeholder.id}/promote`,
        ),
        season: String(season.id),
        version: String(placeholder.version),
        submission: `${submission.act.id}:${submission.act.version}`,
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("promotion could not be completed");
    expect(body).toContain("act promotion would merge assignments");
    expect(body).toContain("Review the records&#39; schedule assignments");
  });

  it("renders an archived-season promotion as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const placeholder = runtime.core.seasons.createPlaceholderAct({
      seasonId: season.id,
      reach: { reachViaContactId: signup.contact.id },
      act: { name: "Archived Placeholder" },
    });
    const submission = createPerformer(
      runtime,
      season.id,
      "Archived Submission",
      "archived-submission@example.invalid",
    );
    const page = await get(
      runtime,
      `/admin/records/act/${placeholder.id}?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/records/act/${placeholder.id}/promote`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/act/${placeholder.id}/promote`,
        ),
        season: String(season.id),
        version: String(placeholder.version),
        submission: `${submission.act.id}:${submission.act.version}`,
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("promotion could not be completed");
    expect(body).toContain("season is archived");
    expect(body).toContain("records were left unchanged");
  });

  it("renders assigned canonical supersession as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const source = createPerformer(
      runtime,
      season.id,
      "Assigned Source",
      "assigned-source@example.invalid",
    );
    const canonical = createPerformer(
      runtime,
      season.id,
      "Assigned Canonical",
      "assigned-canonical@example.invalid",
    );
    assignAct(runtime, season.id, signup.venue.id, source.act.id, 14);
    assignAct(runtime, season.id, signup.venue.id, canonical.act.id, 16);
    const page = await get(
      runtime,
      `/admin/records/act/${source.act.id}?season=${season.id}`,
      alice,
    );

    const refused = await post(
      runtime,
      `/admin/records/act/${source.act.id}/supersede`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/act/${source.act.id}/supersede`,
        ),
        season: String(season.id),
        version: String(source.act.version),
        canonical_id: String(canonical.act.id),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("supersession could not be completed");
    expect(body).toContain(
      `canonical act ${canonical.act.id} is already assigned in season ${season.id}`,
    );
  });

  it("renders archived-season supersession as an actionable refusal", async () => {
    const { runtime, season, alice } = await boot();
    const source = createPerformer(
      runtime,
      season.id,
      "Archived Source",
      "archived-source@example.invalid",
    );
    const canonical = createPerformer(
      runtime,
      season.id,
      "Archived Canonical",
      "archived-canonical@example.invalid",
    );
    const page = await get(
      runtime,
      `/admin/records/act/${source.act.id}?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/records/act/${source.act.id}/supersede`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/act/${source.act.id}/supersede`,
        ),
        season: String(season.id),
        version: String(source.act.version),
        canonical_id: String(canonical.act.id),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("supersession could not be completed");
    expect(body).toContain("season is archived");
  });

  it.each([
    ["older into newer", 0, 1],
    ["newer into older", 1, 0],
  ])(
    "reconciles a resubmission %s",
    async (_label, sourceIndex, targetIndex) => {
      const { runtime, season, alice } = await boot();
      const submissions = [
        createPerformer(
          runtime,
          season.id,
          "First Filing",
          "first@example.invalid",
        ),
        createPerformer(
          runtime,
          season.id,
          "Second Filing",
          "second@example.invalid",
        ),
      ];
      const source = submissions[sourceIndex]?.act;
      const target = submissions[targetIndex]?.act;
      if (!source || !target) throw new Error("missing resubmission fixture");
      const page = await get(
        runtime,
        `/admin/records/act/${source.id}?season=${season.id}`,
        alice,
      );
      const html = await page.clone().text();
      expect(html).toContain(
        `action="/admin/records/act/${source.id}/supersede"`,
      );
      expect(html).toContain(target.name);

      const reconciled = await post(
        runtime,
        `/admin/records/act/${source.id}/supersede`,
        alice,
        new URLSearchParams({
          _csrf: await csrfFrom(
            page,
            `/admin/records/act/${source.id}/supersede`,
          ),
          season: String(season.id),
          version: String(source.version),
          canonical_id: String(target.id),
        }),
      );

      expect(reconciled.status).toBe(303);
      const actIds = runtime.core.queue
        .listForOrganizer(season.id, 1)
        .filter((item) => item.recordType === "act")
        .map((item) => item.record.id);
      expect(actIds).toContain(target.id);
      expect(actIds).not.toContain(source.id);
    },
  );

  it("refuses stale promotion and supersession versions against SQLite", async () => {
    const { runtime, season, alice, signup } = await boot();
    const placeholder = runtime.core.seasons.createPlaceholderAct({
      seasonId: season.id,
      reach: { reachViaContactId: signup.contact.id },
      act: { name: "Stale Placeholder" },
    });
    const promotionTarget = createPerformer(
      runtime,
      season.id,
      "Promotion Target",
      "promotion@example.invalid",
    );
    const promotionPage = await get(
      runtime,
      `/admin/records/act/${placeholder.id}?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.updateAct(placeholder.id, placeholder.version, {
      genre: "Someone else's placeholder genre",
    });
    const refusedPromotion = await post(
      runtime,
      `/admin/records/act/${placeholder.id}/promote`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          promotionPage,
          `/admin/records/act/${placeholder.id}/promote`,
        ),
        season: String(season.id),
        version: String(placeholder.version),
        submission: `${promotionTarget.act.id}:${promotionTarget.act.version}`,
      }),
    );
    expect(refusedPromotion.status).toBe(409);
    expect(await refusedPromotion.text()).toContain(
      "Someone else saved this first",
    );

    const supersedeSource = createPerformer(
      runtime,
      season.id,
      "Stale Source",
      "source@example.invalid",
    );
    const supersedeTarget = createPerformer(
      runtime,
      season.id,
      "Canonical Target",
      "target@example.invalid",
    );
    const supersedePage = await get(
      runtime,
      `/admin/records/act/${supersedeSource.act.id}?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.updateAct(
      supersedeSource.act.id,
      supersedeSource.act.version,
      { genre: "Someone else's genre" },
    );
    const refusedSupersession = await post(
      runtime,
      `/admin/records/act/${supersedeSource.act.id}/supersede`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          supersedePage,
          `/admin/records/act/${supersedeSource.act.id}/supersede`,
        ),
        season: String(season.id),
        version: String(supersedeSource.act.version),
        canonical_id: String(supersedeTarget.act.id),
      }),
    );
    expect(refusedSupersession.status).toBe(409);
    expect(await refusedSupersession.text()).toContain(
      "Someone else saved this first",
    );
    const acts = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .filter((item) => item.recordType === "act");
    expect(acts.some((item) => item.record.id === supersedeSource.act.id)).toBe(
      true,
    );
  });

  it("refuses every lifecycle route without organizer authentication", async () => {
    const { runtime, season } = await boot();
    const paths = [
      `/admin/placeholders/act/new?season=${season.id}`,
      `/admin/placeholders/venue/new?season=${season.id}`,
    ];
    for (const path of paths) {
      expect((await runtime.request(`${PUBLIC_BASE_URL}${path}`)).status).toBe(
        401,
      );
    }
    for (const path of [
      "/admin/placeholders/act",
      "/admin/placeholders/venue",
      "/admin/records/act/1/promote",
      "/admin/records/venue/1/promote",
      "/admin/records/act/1/supersede",
      "/admin/records/venue/1/supersede",
      "/admin/records/contact/1/supersede",
    ]) {
      const response = await runtime.request(`${PUBLIC_BASE_URL}${path}`, {
        method: "POST",
      });
      expect(response.status).toBe(401);
    }
  });

  it("refuses every lifecycle write from an unrelated origin", async () => {
    const { runtime, alice } = await boot();
    for (const path of [
      "/admin/placeholders/act",
      "/admin/placeholders/venue",
      "/admin/records/act/1/promote",
      "/admin/records/venue/1/promote",
      "/admin/records/act/1/supersede",
      "/admin/records/venue/1/supersede",
      "/admin/records/contact/1/supersede",
    ]) {
      const response = await runtime.request(`${PUBLIC_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          origin: "https://unrelated.example",
          cookie: alice,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(),
      });
      expect(response.status).toBe(403);
    }
  });
});

describe("refusal copy helpers", () => {
  // Correction-gated routes currently only refuse archived seasons. These
  // defensive branches stay explicit in case a future catch reaches them.
  it("guards placeholder copy for a non-archived state routes cannot produce", () => {
    const refusal = placeholderSeasonRefusal(
      new SeasonActionError("locked", "hold"),
    );

    expect(refusal).toContain("current state is locked");
    expect(refusal).not.toContain("season is archived");
    expect(refusal).toContain("Your answers are still here");
  });

  it("guards lifecycle copy for a non-archived state routes cannot produce", () => {
    const refusal = lifecycleRefusal(
      "status change",
      new SeasonActionError("locked", "hold"),
    );

    expect(refusal.message).toContain("current state is locked");
    expect(refusal.message).not.toContain("season is archived");
    expect(refusal.message).toContain("records were left unchanged");
  });

  it("names a non-archived state in the closed-corrections banner", () => {
    const body = renderRecordPage({
      recordType: "venue",
      recordId: 1,
      seasonId: 1,
      title: "Synthetic Porch",
      version: 1,
      values: { title: "Synthetic Porch" },
      staticValues: { title: "Synthetic Porch" },
      csrfToken: "synthetic-csrf",
      correctionsClosed: true,
      seasonState: "locked",
    });

    expect(body).toContain("current state is locked");
    expect(body).not.toContain("This season is archived");
  });

  it("does not expose a missing record id as lifecycle refusal guidance", () => {
    const refusal = lifecycleRefusal(
      "change request",
      new SeasonLifecycleError("act 42 does not exist"),
    );

    expect(refusal.message).toContain("record is no longer available");
    expect(refusal.message).toContain("Reload the activity queue");
    expect(refusal.message).toContain("records were left unchanged");
    expect(refusal.message).not.toContain("42");
    expect(refusal.message).not.toContain("schedule assignments");
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
    const csrf = await csrfFrom(
      page,
      `/admin/records/venue/${signup.venue.id}`,
    );

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
    const csrf = await csrfFrom(
      page,
      `/admin/records/venue/${signup.venue.id}`,
    );
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

  it("shows stored values if corrections close while a conflict is rendered", () => {
    const body = renderRecordPage({
      recordType: "venue",
      recordId: 1,
      seasonId: 1,
      title: "Stored Porch",
      version: 2,
      values: { title: "Typed Never Saved" },
      staticValues: { title: "Stored Porch" },
      csrfToken: "synthetic-csrf",
      correctionsClosed: true,
      seasonState: "archived",
      conflicts: [
        {
          field: "title",
          label: "Porch name",
          attempted: "Typed Never Saved",
          stored: "Stored Porch",
        },
      ],
    });

    expect(body).toContain("<dt>Porch name</dt><dd>Stored Porch</dd>");
    expect(body).not.toContain("Typed Never Saved");
    expect(body).not.toContain("Someone else saved this first");
  });

  it("renders an archived-season field edit as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const proposedAddress = "synthetic-refused-address";
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress,
    });
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}&change_request=${request.id}`,
      alice,
    );
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(page, `/admin/records/venue/${signup.venue.id}`),
        season: String(season.id),
        version: String(signup.venue.version),
        change_request: String(request.id),
        title: "Preserved Refused Venue",
        address: proposedAddress,
        spaceDescription: "synthetic-space-description",
        hasPower: "yes",
        rainBackup: "no",
        notes: "synthetic-refused-notes",
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("correction could not be completed");
    expect(body).toContain("season is archived");
    expect(body).toContain("records were left unchanged");
    expect(body).toContain("<dt>Porch name</dt><dd>The Test Porch</dd>");
    expect(body).not.toContain("Preserved Refused Venue");
    expect(body).not.toContain(
      `action="/admin/records/venue/${signup.venue.id}"`,
    );
    expect(body).not.toContain('class="signup-form"');
    expect(
      body.match(
        /This season is archived\. Records can no longer be changed\./g,
      ),
    ).toHaveLength(1);
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.title).toBe(
      signup.venue.title,
    );
  });

  it("re-arms the refused form so a second save can go through", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const csrf = await csrfFrom(
      page,
      `/admin/records/venue/${signup.venue.id}`,
    );
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
        _csrf: await csrfFrom(page, `/admin/records/venue/${signup.venue.id}`),
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

describe("record status", () => {
  it("withdraws an act and says so on the record", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const statusCsrf = await csrfFrom(
      page,
      `/admin/records/venue/${signup.venue.id}/status`,
    );

    const set = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}/status`,
      alice,
      new URLSearchParams({
        _csrf: statusCsrf,
        season: String(season.id),
        version: String(signup.venue.version),
        status: "withdrawn",
      }),
    );

    expect(set.status).toBe(303);
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "withdrawn",
    );
  });

  it("names a stale status change instead of applying it", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const statusCsrf = await csrfFrom(
      page,
      `/admin/records/venue/${signup.venue.id}/status`,
    );

    // Someone else moves it first.
    runtime.core.seasons.setRecordStatus(
      "venue",
      signup.venue.id,
      signup.venue.version,
      "confirmed",
    );

    const refused = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}/status`,
      alice,
      new URLSearchParams({
        _csrf: statusCsrf,
        season: String(season.id),
        version: String(signup.venue.version),
        status: "withdrawn",
      }),
    );

    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("Someone else saved this first");
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "confirmed",
    );
  });

  it("renders an archived-season status change as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}/status`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/venue/${signup.venue.id}/status`,
        ),
        season: String(season.id),
        version: String(signup.venue.version),
        status: "withdrawn",
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("status change could not be completed");
    expect(body).toContain("season is archived");
    expect(body).toContain("records were left unchanged");
    expect(body).toContain(
      "This season is archived. Records can no longer be changed.",
    );
    expect(body).not.toContain(
      `action="/admin/records/venue/${signup.venue.id}/status"`,
    );
    expect(body).not.toContain(
      `action="/admin/records/venue/${signup.venue.id}"`,
    );
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "tentative",
    );
  });

  it("returns not found for a status change targeting an unknown record", async () => {
    const { runtime, season, alice, signup } = await boot();
    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}`,
      alice,
    );
    const unknownRecordId = signup.venue.id + 10_000;

    const refused = await post(
      runtime,
      `/admin/records/venue/${unknownRecordId}/status`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          page,
          `/admin/records/venue/${signup.venue.id}/status`,
        ),
        season: String(season.id),
        version: "0",
        status: "withdrawn",
      }),
    );

    expect(refused.status).toBe(404);
    expect(await refused.text()).toContain("No such record in this season");
  });

  it("offers no status control on a contact", async () => {
    const { runtime, season, alice, signup } = await boot();

    const page = await get(
      runtime,
      `/admin/records/contact/${signup.contact.id}?season=${season.id}`,
      alice,
    );

    expect(await page.text()).not.toContain("/status");
  });
});

describe("participant change requests", () => {
  it("shows an approve-or-reject queue item without changing the confirmed record", async () => {
    const { runtime, season, alice, signup } = await boot();
    runtime.core.seasons.setRecordStatus(
      "venue",
      signup.venue.id,
      signup.venue.version,
      "confirmed",
    );
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version + 1,
      kind: "address",
      proposedAddress: "22 Proposed Avenue",
    });

    const page = await get(runtime, `/admin?season=${season.id}`, alice);
    const body = await page.text();

    expect(page.status).toBe(200);
    expect(body).toContain("Address correction");
    expect(body).toContain("22 Proposed Avenue");
    expect(body).toContain(`/admin/change-requests/${request.id}/apply`);
    expect(body).toContain(`/admin/change-requests/${request.id}/reject`);
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.address).toBe(
      "1 Test St",
    );
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "confirmed",
    );
  });

  it("routes an accepted address correction into the editor with proposed and stored values", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress: "22 Proposed Avenue",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const accepted = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );

    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(
      `/admin/records/venue/${signup.venue.id}?season=${season.id}&change_request=${request.id}`,
    );
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
    const editor = await get(
      runtime,
      accepted.headers.get("location") ?? "",
      alice,
    );
    const body = await editor.clone().text();
    expect(editor.status).toBe(200);
    // Assert the view edit landed: the proposal is editable and is honestly
    // distinguished from the still-stored value.
    expect(body).toContain(
      'name="address" type="text" value="22 Proposed Avenue"',
    );
    expect(body).toContain("Review the participant's proposed correction");
    expect(body).toContain("saving this form accepts the proposal");
    expect(body).toContain(
      "<strong>Participant proposed:</strong> 22 Proposed Avenue",
    );
    expect(body).toContain("<strong>Stored:</strong> 1 Test St");
    expect(body).toContain(`name="change_request" value="${request.id}"`);
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.address).toBe(
      "1 Test St",
    );

    const saved = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          editor,
          `/admin/records/venue/${signup.venue.id}`,
        ),
        season: String(season.id),
        version: String(signup.venue.version),
        change_request: String(request.id),
        title: signup.venue.title,
        address: "22 Proposed Avenue",
        spaceDescription: signup.venue.spaceDescription ?? "",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );

    expect(saved.status).toBe(303);
    const afterSave = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(afterSave?.recordType === "venue" && afterSave.record.address).toBe(
      "22 Proposed Avenue",
    );
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "applied",
    );
  });

  it("renders an archived address-request bookmark as a stored record lookup", async () => {
    const { runtime, season, alice, signup } = await boot();
    const proposedAddress = "synthetic-proposed-address";
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress,
    });
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const page = await get(
      runtime,
      `/admin/records/venue/${signup.venue.id}?season=${season.id}&change_request=${request.id}`,
      alice,
    );
    const body = await page.text();

    expect(page.status).toBe(200);
    expect(body).toContain(
      `<dt>Street address</dt><dd>${signup.venue.address}</dd>`,
    );
    expect(body).not.toContain(proposedAddress);
    expect(body).not.toContain("participant's proposed correction");
    expect(body).not.toContain("saving this form accepts the proposal");
    expect(body).not.toContain("<form");
  });

  it("refuses an archived-season address request before opening the editor", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress: "synthetic-proposed-address",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("change request could not be completed");
    expect(body).toContain("season is archived");
    expect(body).toContain("records were left unchanged");
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
  });

  it("reports a venue save as successful when its linked review is malformed", async () => {
    const { runtime, season, alice, signup } = await boot();
    const proposedAddress = "synthetic-corrupted-review-address";
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress,
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const review = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );
    const editor = await get(
      runtime,
      review.headers.get("location") ?? "",
      alice,
    );
    const editorCsrf = await csrfFrom(
      editor,
      `/admin/records/venue/${signup.venue.id}`,
    );
    runtime.coreTesting.corruptChangeRequestProposal(request.id, null);

    const saved = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: editorCsrf,
        season: String(season.id),
        version: String(signup.venue.version),
        change_request: String(request.id),
        title: signup.venue.title,
        address: proposedAddress,
        spaceDescription: signup.venue.spaceDescription ?? "",
        hasPower: "yes",
        rainBackup: "no",
        notes: "",
      }),
    );

    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(
      `/admin/records/venue/${signup.venue.id}?season=${season.id}&saved=1`,
    );
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.address).toBe(
      proposedAddress,
    );
    expect(runtime.coreTesting.readChangeRequestStatus(request.id)).toEqual({
      status: "pending",
    });
  });

  it("leaves an address correction pending when the saved address differs", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress: "synthetic-proposed-address",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const review = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );
    const editor = await get(
      runtime,
      review.headers.get("location") ?? "",
      alice,
    );

    const saved = await post(
      runtime,
      `/admin/records/venue/${signup.venue.id}`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          editor,
          `/admin/records/venue/${signup.venue.id}`,
        ),
        season: String(season.id),
        version: String(signup.venue.version),
        change_request: String(request.id),
        title: signup.venue.title,
        address: "synthetic-organizer-address",
        spaceDescription: signup.venue.spaceDescription ?? "",
        hasPower: "yes",
        rainBackup: "no",
        notes: "Reviewed without accepting the address proposal",
      }),
    );

    expect(saved.status).toBe(303);
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
    const afterSave = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();
    expect(afterSave).toContain("synthetic-proposed-address");
    expect(afterSave).toContain(`/admin/change-requests/${request.id}/reject`);
  });

  it("keeps an abandoned address review pending and listed", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "address",
      proposedAddress: "44 Still Pending St",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const review = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );

    expect(review.status).toBe(303);
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
    const reloaded = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();
    expect(reloaded).toContain("44 Still Pending St");
    expect(reloaded).toContain(`/admin/change-requests/${request.id}/apply`);
  });

  it("shows stale requests with only a reject action", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "withdrawal",
    });
    runtime.core.seasons.updateVenue(signup.venue.id, signup.venue.version, {
      notes: "Changed after filing",
    });

    const body = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();

    expect(body).toContain("This record changed after the request was filed");
    expect(body).not.toContain(`/admin/change-requests/${request.id}/apply`);
    expect(body).toContain(`/admin/change-requests/${request.id}/reject`);
  });

  it("renders the ending date for availability that crosses UTC midnight", async () => {
    const { runtime, season, alice } = await boot();
    const performer = createPerformer(
      runtime,
      season.id,
      "Midnight Act",
      "midnight@example.invalid",
    );
    runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [
        {
          startsAt: new Date("2031-09-13T23:00:00.000Z"),
          endsAt: new Date("2031-09-14T01:00:00.000Z"),
        },
      ],
    });

    const body = await (
      await get(runtime, `/admin?season=${season.id}`, alice)
    ).text();
    expect(body).toContain("2031-09-13 23:00–2031-09-14 01:00 UTC");
  });

  it("rejects a request without touching its target", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "withdrawal",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);

    const rejected = await post(
      runtime,
      `/admin/change-requests/${request.id}/reject`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/reject`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );

    expect(rejected.status).toBe(303);
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "rejected",
    );
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "tentative",
    );
  });

  it("rejects a malformed request that the queue cannot render", async () => {
    const { runtime, season, alice } = await boot();
    const performer = createPerformer(
      runtime,
      season.id,
      "Malformed Proposal Act",
      "malformed-proposal@example.invalid",
    );
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [],
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const csrf = await csrfFrom(
      queue,
      `/admin/change-requests/${request.id}/reject`,
    );
    runtime.coreTesting.corruptChangeRequestProposal(
      request.id,
      "malformed-proposal",
    );

    const rejected = await post(
      runtime,
      `/admin/change-requests/${request.id}/reject`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: String(request.version),
      }),
    );

    expect(rejected.status).toBe(303);
    expect(runtime.coreTesting.readChangeRequestStatus(request.id)).toEqual({
      status: "rejected",
    });
  });

  it("refuses to apply a malformed request instead of returning a server error", async () => {
    const { runtime, season, alice } = await boot();
    const performer = createPerformer(
      runtime,
      season.id,
      "Malformed Apply Act",
      "malformed-apply@example.invalid",
    );
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "act",
      recordId: performer.act.id,
      recordVersion: performer.act.version,
      kind: "availability",
      proposedAvailability: [],
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    const csrf = await csrfFrom(
      queue,
      `/admin/change-requests/${request.id}/apply`,
    );
    runtime.coreTesting.corruptChangeRequestProposal(
      request.id,
      "malformed-apply-proposal",
    );

    const refused = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: csrf,
        season: String(season.id),
        version: String(request.version),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("could not be applied");
    expect(body).toContain("Reject it from the activity queue");
    expect(runtime.coreTesting.readChangeRequestStatus(request.id)).toEqual({
      status: "pending",
    });
  });

  it("renders a stale apply as a conflict and leaves the request pending", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "withdrawal",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    runtime.core.seasons.updateVenue(signup.venue.id, signup.venue.version, {
      notes: "Concurrent correction",
    });

    const refused = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );

    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("could not be applied");
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
  });

  it("renders an archived-season withdrawal request as an actionable refusal", async () => {
    const { runtime, season, alice, signup } = await boot();
    const request = runtime.core.changeRequests.record({
      seasonId: season.id,
      recordType: "venue",
      recordId: signup.venue.id,
      recordVersion: signup.venue.version,
      kind: "withdrawal",
    });
    const queue = await get(runtime, `/admin?season=${season.id}`, alice);
    runtime.core.seasons.transitionSeason(
      season.id,
      season.version,
      "archived",
    );

    const refused = await post(
      runtime,
      `/admin/change-requests/${request.id}/apply`,
      alice,
      new URLSearchParams({
        _csrf: await csrfFrom(
          queue,
          `/admin/change-requests/${request.id}/apply`,
        ),
        season: String(season.id),
        version: String(request.version),
      }),
    );
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).toContain("change request could not be completed");
    expect(body).toContain("season is archived");
    expect(body).toContain("records were left unchanged");
    expect(runtime.core.changeRequests.find(request.id)?.status).toBe(
      "pending",
    );
    const stored = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .find((item) => item.recordType === "venue");
    expect(stored?.recordType === "venue" && stored.record.status).toBe(
      "tentative",
    );
  });

  it("refuses unauthenticated and unrelated-origin writes to both routes", async () => {
    const { runtime, alice } = await boot();
    for (const path of [
      "/admin/change-requests/1/apply",
      "/admin/change-requests/1/reject",
    ]) {
      expect(
        (await runtime.request(`${PUBLIC_BASE_URL}${path}`, { method: "POST" }))
          .status,
      ).toBe(401);
      expect(
        (
          await runtime.request(`${PUBLIC_BASE_URL}${path}`, {
            method: "POST",
            headers: {
              origin: "https://unrelated.example",
              cookie: alice,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(),
          })
        ).status,
      ).toBe(403);
    }
  });
});
