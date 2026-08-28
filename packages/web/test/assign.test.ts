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
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-assign-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createTestingRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "assignment-test-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);

  const bootstrapToken =
    announced.join("\n").match(/token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  const signIn = await get(runtime, `/admin/sign-in?token=${bootstrapToken}`);
  const signInCsrf = csrf(await signIn.text(), "/admin/sign-in");
  const signedIn = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`, {
    method: "POST",
    headers: {
      origin: PUBLIC_BASE_URL,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      _csrf: signInCsrf,
      token: bootstrapToken,
      display_name: "Synthetic Organizer",
      email: "organizer@example.invalid",
    }),
  });
  const cookie =
    (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  const { season } = runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "America/Chicago",
    eventDate: "2031-09-13",
    timeSlots: [
      { startsAt: "18:00", endsAt: "19:00" },
      { startsAt: "19:00", endsAt: "20:00" },
    ],
    openSignups: true,
  });
  const maple = createVenue(
    runtime,
    season.id,
    "Maple Street Porch",
    "18 Maple Street",
    true,
    "The Porch Cats",
  );
  const oak = createVenue(
    runtime,
    season.id,
    "Oak Avenue Stage",
    "22 Oak Avenue",
    false,
  );
  const cats = createAct(runtime, season.id, "The Porch Cats", false, {
    genre: "Folk",
    housePreference: "Maple Street Porch",
    sharedMemberNote: "A drummer also plays elsewhere",
  });
  const acoustic = createAct(runtime, season.id, "Acoustic Neighbors", false);
  const amplified = createAct(runtime, season.id, "Amplified Friends", true);
  return { runtime, cookie, season, maple, oak, cats, acoustic, amplified };
}

function createVenue(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  title: string,
  address: string,
  hasPower: boolean,
  requestedActNames: string | null = null,
) {
  return runtime.core.seasons.createHostSignup({
    seasonId,
    contact: {
      name: `${title} Host`,
      email: `${title.toLowerCase().replaceAll(" ", "-")}@example.invalid`,
    },
    venue: {
      title,
      address,
      spaceDescription: "Synthetic porch",
      hasPower,
      rainBackup: false,
      requestedActNames,
      genrePreferences: "Folk",
      notes: null,
    },
    gear: [],
    drinks: [],
    amenities: [],
  });
}

function createAct(
  runtime: PorchfestTestingRuntime,
  seasonId: number,
  name: string,
  requiresAmplification: boolean,
  overrides: {
    genre?: string;
    housePreference?: string | null;
    sharedMemberNote?: string | null;
  } = {},
) {
  return runtime.core.seasons.createPerformerSignup({
    seasonId,
    contact: {
      name: `${name} Contact`,
      email: `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`,
    },
    act: {
      name,
      durationMinutes: 45,
      requiresAmplification,
      genre: overrides.genre ?? "Folk",
      description: `${name} description`,
      links: "",
      housePreference: overrides.housePreference ?? null,
      sharedMemberNote: overrides.sharedMemberNote ?? null,
      canLendGear: false,
      notes: null,
    },
    availabilities: [],
  });
}

function get(runtime: PorchfestRuntime, path: string, cookie = "") {
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    headers: cookie ? { cookie, accept: "text/html" } : undefined,
  });
}

function post(
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

function csrf(html: string, action: string): string {
  const escaped = action.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
  return (
    html.match(
      new RegExp(
        `action="${escaped}"[\\s\\S]{0,700}?name="_csrf" value="([^"]+)"`,
      ),
    )?.[1] ?? ""
  );
}

function slotFor(
  runtime: PorchfestTestingRuntime,
  venueId: number,
  position = 0,
) {
  return runtime.core.seasons.ensureVenueSlots(venueId)[position]!;
}

async function assignmentCsrf(
  runtime: PorchfestRuntime,
  cookie: string,
  venueId: number,
  slotId: number,
) {
  const page = await get(runtime, `/admin/venues/${venueId}/assign`, cookie);
  return csrf(await page.text(), `/admin/slots/${slotId}/assign`);
}

describe("organizer assignment screens", () => {
  it("refuses unauthenticated and CSRF-less GET/POST requests", async () => {
    const { runtime, cookie, maple, cats } = await boot();
    const slot = slotFor(runtime, maple.venue.id);

    expect(
      (await get(runtime, `/admin/venues/${maple.venue.id}/assign`)).status,
    ).toBe(401);
    expect(
      (
        await post(
          runtime,
          `/admin/slots/${slot.id}/assign`,
          "",
          new URLSearchParams({
            act: String(cats.act.id),
            version: String(slot.version),
            return_to: "venue",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          runtime,
          `/admin/slots/${slot.id}/assign`,
          cookie,
          new URLSearchParams({
            act: String(cats.act.id),
            version: String(slot.version),
            return_to: "venue",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("materializes slots, shows visible reasons in both views, and ranks acoustic before amplified without power", async () => {
    const { runtime, cookie, maple, oak, cats, acoustic, amplified } =
      await boot();
    const venueResponse = await get(
      runtime,
      `/admin/venues/${maple.venue.id}/assign`,
      cookie,
    );
    const venueHtml = await venueResponse.text();
    const actHtml = await (
      await get(runtime, `/admin/acts/${cats.act.id}/assign`, cookie)
    ).text();
    const oakHtml = await (
      await get(runtime, `/admin/venues/${oak.venue.id}/assign`, cookie)
    ).text();

    expect(venueResponse.status).toBe(200);
    expect(runtime.core.seasons.ensureVenueSlots(maple.venue.id)).toHaveLength(
      2,
    );
    expect(venueHtml).toContain("18:00–19:00");
    expect(venueHtml).toContain("Why this match:");
    expect(venueHtml).toContain(
      "The host and act requested each other by name",
    );
    expect(actHtml).toContain("The host and act requested each other by name");
    expect(venueHtml).not.toMatch(/title="[^"]*(requested|available|power)/i);
    expect(oakHtml.indexOf(acoustic.act.name)).toBeLessThan(
      oakHtml.indexOf(amplified.act.name),
    );
  });

  it("assigns and unassigns, and names duplicate-act and filled-slot conflicts", async () => {
    const { runtime, cookie, maple, oak, cats, acoustic } = await boot();
    const mapleSlot = slotFor(runtime, maple.venue.id);
    const oakSlot = slotFor(runtime, oak.venue.id);
    const token = await assignmentCsrf(
      runtime,
      cookie,
      maple.venue.id,
      mapleSlot.id,
    );
    let response = await post(
      runtime,
      `/admin/slots/${mapleSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(cats.act.id),
        version: String(mapleSlot.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(303);
    expect(
      await (
        await get(runtime, response.headers.get("location") ?? "", cookie)
      ).text(),
    ).toContain(`>${cats.act.name}</a>`);

    const oakToken = await assignmentCsrf(
      runtime,
      cookie,
      oak.venue.id,
      oakSlot.id,
    );
    response = await post(
      runtime,
      `/admin/slots/${oakSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: oakToken,
        act: String(cats.act.id),
        version: String(oakSlot.version),
        return_to: "venue",
      }),
    );
    const duplicateBody = await response.text();
    expect(response.status).toBe(409);
    expect(duplicateBody).toContain("Maple Street Porch");
    expect(duplicateBody).toContain("6:00–7:00 PM");

    const refreshedMapleSlot = slotFor(runtime, maple.venue.id);
    response = await post(
      runtime,
      `/admin/slots/${mapleSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(acoustic.act.id),
        version: String(refreshedMapleSlot.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/already filled.*Porch Cats/i);

    const assignment = runtime.core.seasons.listAssignments(
      cats.act.seasonId,
    )[0]!;
    const assignedPage = await get(
      runtime,
      `/admin/venues/${maple.venue.id}/assign`,
      cookie,
    );
    const unassignToken = csrf(
      await assignedPage.text(),
      `/admin/assignments/${assignment.id}/unassign`,
    );
    response = await post(
      runtime,
      `/admin/assignments/${assignment.id}/unassign`,
      cookie,
      new URLSearchParams({
        _csrf: unassignToken,
        version: String(assignment.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(303);
    expect(slotFor(runtime, maple.venue.id).state).toBe("open");
  });

  it("requires and records a shared-member override", async () => {
    const { runtime, cookie, maple, oak, cats, acoustic, season } =
      await boot();
    runtime.core.seasons.linkActs({
      seasonId: season.id,
      actId: cats.act.id,
      linkedActId: acoustic.act.id,
    });
    const mapleSlot = slotFor(runtime, maple.venue.id);
    const oakSlot = slotFor(runtime, oak.venue.id);
    runtime.core.seasons.assignSlot(
      mapleSlot.id,
      mapleSlot.version,
      cats.act.id,
    );
    const token = await assignmentCsrf(
      runtime,
      cookie,
      oak.venue.id,
      oakSlot.id,
    );
    let response = await post(
      runtime,
      `/admin/slots/${oakSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(acoustic.act.id),
        version: String(oakSlot.version),
        return_to: "act",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/shares a member.*override/i);

    response = await post(
      runtime,
      `/admin/slots/${oakSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(acoustic.act.id),
        version: String(oakSlot.version),
        return_to: "act",
        override_reason: "Members confirmed separate set coverage",
      }),
    );
    expect(response.status).toBe(303);
    expect(
      runtime.core.seasons
        .listAssignments(season.id)
        .find((assignment) => assignment.actId === acoustic.act.id)
        ?.sharedMemberOverride,
    ).toBe("Members confirmed separate set coverage");
  });

  it("holds and releases a slot with its fallback offered", async () => {
    const { runtime, cookie, maple, oak, cats } = await boot();
    const slot = slotFor(runtime, maple.venue.id);
    let pageHtml = await (
      await get(runtime, `/admin/venues/${maple.venue.id}/assign`, cookie)
    ).text();
    const holdToken = csrf(pageHtml, `/admin/slots/${slot.id}/hold`);
    let response = await post(
      runtime,
      `/admin/slots/${slot.id}/hold`,
      cookie,
      new URLSearchParams({
        _csrf: holdToken,
        version: String(slot.version),
        return_to: "venue",
        held_for: "Expected Guests",
        decide_by: "2031-09-01",
        fallback_venue: String(oak.venue.id),
      }),
    );
    expect(response.status).toBe(303);
    pageHtml = await (
      await get(runtime, response.headers.get("location") ?? "", cookie)
    ).text();
    expect(pageHtml).toContain("Held for Expected Guests");
    expect(pageHtml).toContain("Fallback: Oak Avenue Stage");
    expect(pageHtml).not.toContain(`action="/admin/slots/${slot.id}/assign"`);

    const held = slotFor(runtime, maple.venue.id);
    const releaseToken = csrf(pageHtml, `/admin/slots/${slot.id}/release`);
    response = await post(
      runtime,
      `/admin/slots/${slot.id}/release`,
      cookie,
      new URLSearchParams({
        _csrf: releaseToken,
        version: String(held.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      `released_to=${oak.venue.id}`,
    );
    expect(
      await (
        await get(runtime, response.headers.get("location") ?? "", cookie)
      ).text(),
    ).toContain(`Assign at ${oak.venue.title}`);
    expect(slotFor(runtime, maple.venue.id).state).toBe("open");

    const fallbackSlot = slotFor(runtime, oak.venue.id);
    const fallbackToken = await assignmentCsrf(
      runtime,
      cookie,
      oak.venue.id,
      fallbackSlot.id,
    );
    response = await post(
      runtime,
      `/admin/slots/${fallbackSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: fallbackToken,
        act: String(cats.act.id),
        version: String(fallbackSlot.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(303);
    expect(
      runtime.core.seasons
        .listAssignments(cats.act.seasonId)
        .find((assignment) => assignment.actId === cats.act.id)?.slotId,
    ).toBe(fallbackSlot.id);
  });

  it("links and unlinks acts through versioned organizer forms", async () => {
    const { runtime, cookie, cats, acoustic } = await boot();
    let actHtml = await (
      await get(runtime, `/admin/acts/${cats.act.id}/assign`, cookie)
    ).text();
    const linkToken = csrf(actHtml, `/admin/acts/${cats.act.id}/links`);
    let response = await post(
      runtime,
      `/admin/acts/${cats.act.id}/links`,
      cookie,
      new URLSearchParams({
        _csrf: linkToken,
        linked_act: String(acoustic.act.id),
        note: "Shared drummer",
      }),
    );
    expect(response.status).toBe(303);
    const link = runtime.core.seasons.listActLinksForAct(cats.act.id)[0]!;
    actHtml = await (
      await get(runtime, response.headers.get("location") ?? "", cookie)
    ).text();
    expect(actHtml).toContain("Shared drummer");
    const unlinkToken = csrf(actHtml, `/admin/act-links/${link.id}/unlink`);
    response = await post(
      runtime,
      `/admin/act-links/${link.id}/unlink`,
      cookie,
      new URLSearchParams({
        _csrf: unlinkToken,
        version: String(link.version),
        act: String(cats.act.id),
      }),
    );
    expect(response.status).toBe(303);
    expect(runtime.core.seasons.listActLinksForAct(cats.act.id)).toEqual([]);
  });

  it("names locked-state and stale-slot refusals and keeps unknown ids at 404", async () => {
    const { runtime, cookie, season, maple, cats } = await boot();
    const slot = slotFor(runtime, maple.venue.id);
    const pageHtml = await (
      await get(runtime, `/admin/venues/${maple.venue.id}/assign`, cookie)
    ).text();
    const token = csrf(pageHtml, `/admin/slots/${slot.id}/assign`);
    runtime.core.seasons.holdSlot(slot.id, slot.version, {
      heldForName: "Temporary Hold",
      decideBy: new Date("2031-09-01T12:00:00.000Z"),
    });
    const held = slotFor(runtime, maple.venue.id);
    runtime.core.seasons.releaseSlotHold(held.id, held.version);
    let response = await post(
      runtime,
      `/admin/slots/${slot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(cats.act.id),
        version: String(slot.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/slot changed.*look again/i);

    const current = runtime.core.seasons.getSeason(season.id);
    runtime.core.seasons.transitionSeason(season.id, current.version, "locked");
    const lockedPage = await get(
      runtime,
      `/admin/venues/${maple.venue.id}/assign`,
      cookie,
    );
    const lockedHtml = await lockedPage.text();
    expect(lockedHtml).toContain("season state is locked");
    expect(lockedHtml).not.toContain(">Assign The Porch Cats</button>");
    const freshSlot = slotFor(runtime, maple.venue.id);
    response = await post(
      runtime,
      `/admin/slots/${freshSlot.id}/assign`,
      cookie,
      new URLSearchParams({
        _csrf: token,
        act: String(cats.act.id),
        version: String(freshSlot.version),
        return_to: "venue",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("season state is locked");
    expect(
      (await get(runtime, "/admin/venues/999999/assign", cookie)).status,
    ).toBe(404);
  });
});
