import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
} from "@porchfest/core";
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

/**
 * A provider that records what it was handed. `configured` is what AE1 turns
 * on: the same app with `configured === false` must offer export only.
 */
class SpyEmailPort implements EmailPort {
  readonly name = "spy";
  readonly configured = true;
  readonly deliveries: EmailMessage[] = [];
  respond: (message: EmailMessage) => EmailDeliveryResult = () => ({
    status: "sent",
    providerMessageId: "provider-1",
  });

  async deliver(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.deliveries.push(message);
    return this.respond(message);
  }
}

const PORCHES = [
  { title: "Maple Street Porch", address: "18 Maple Street" },
  { title: "Oak Avenue Stage", address: "22 Oak Avenue" },
  { title: "Birch Lane Landing", address: "31 Birch Lane" },
  { title: "Cedar Court Steps", address: "44 Cedar Court" },
] as const;

const BANDS = [
  "The Porch Cats",
  "Acoustic Neighbors",
  "Amplified Friends",
  "The Gutter Choir",
] as const;

async function boot(options: { email?: EmailPort } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-outbox-web-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createTestingRuntime({
    dataDirectory,
    adapterOverrides: options.email ? { email: options.email } : undefined,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "outbox-test-secret",
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
    publicMapUrl: "https://map.example.invalid/porchfest",
    senderName: "Synthetic Organizers",
    senderEmail: "organizers@example.invalid",
    openSignups: true,
  });

  const venues = PORCHES.map((porch) =>
    runtime.core.seasons.createHostSignup({
      seasonId: season.id,
      contact: {
        name: `${porch.title} Host`,
        email: `${slug(porch.title)}@example.invalid`,
      },
      venue: {
        title: porch.title,
        address: porch.address,
        spaceDescription: "Synthetic porch",
        hasPower: true,
        rainBackup: false,
        requestedActNames: null,
        genrePreferences: "Folk",
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    }),
  );
  const acts = BANDS.map((name) =>
    runtime.core.seasons.createPerformerSignup({
      seasonId: season.id,
      contact: {
        name: `${name} Contact`,
        email: `${slug(name)}@example.invalid`,
      },
      act: {
        name,
        durationMinutes: 45,
        requiresAmplification: false,
        genre: "Folk",
        description: `${name} description`,
        links: "",
        housePreference: null,
        sharedMemberNote: null,
        canLendGear: false,
        notes: null,
      },
      availabilities: [],
    }),
  );
  // Every porch is matched, so the match wave renders one message per venue
  // with two recipients: the host and the performer.
  venues.forEach((venue, index) => {
    const slot = runtime.core.seasons.ensureVenueSlots(venue.venue.id)[0]!;
    runtime.core.seasons.assignSlot(slot.id, slot.version, acts[index]!.act.id);
  });

  return { runtime, cookie, season, venues, acts };
}

/** Just enough of a checkbox for `admin.js` to run against. */
function makeBox() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    checked: false,
    indeterminate: false,
    addEventListener(name: string, handler: () => void) {
      (listeners[name] ??= []).push(handler);
    },
    fire(name: string) {
      for (const handler of listeners[name] ?? []) handler();
    },
  };
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
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

async function generateMatchWave(
  runtime: PorchfestTestingRuntime,
  cookie: string,
  seasonId: number,
) {
  const page = await get(runtime, `/admin/seasons/${seasonId}/outbox`, cookie);
  const token = csrf(
    await page.text(),
    `/admin/seasons/${seasonId}/outbox/generate`,
  );
  const response = await post(
    runtime,
    `/admin/seasons/${seasonId}/outbox/generate`,
    cookie,
    new URLSearchParams({ _csrf: token, kind: "match" }),
  );
  const location = response.headers.get("location") ?? "";
  const waveId = Number(location.match(/waves\/(\d+)/)?.[1]);
  return {
    response,
    location,
    waveId,
    generateCsrf: token,
    messages: runtime.core.outbox.listMessages(waveId),
  };
}

describe("organizer outbox screens", () => {
  it("refuses unauthenticated and CSRF-less outbox requests", async () => {
    const { runtime, cookie, season } = await boot();

    expect(
      (await get(runtime, `/admin/seasons/${season.id}/outbox`)).status,
    ).toBe(401);
    expect(
      (
        await post(
          runtime,
          `/admin/seasons/${season.id}/outbox/generate`,
          "",
          new URLSearchParams({ kind: "match" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          runtime,
          `/admin/seasons/${season.id}/outbox/generate`,
          cookie,
          new URLSearchParams({ kind: "match" }),
        )
      ).status,
    ).toBe(403);

    const { waveId } = await generateMatchWave(runtime, cookie, season.id);
    expect((await get(runtime, `/admin/outbox/waves/${waveId}`)).status).toBe(
      401,
    );
    expect(
      (
        await post(
          runtime,
          `/admin/outbox/waves/${waveId}/send`,
          cookie,
          new URLSearchParams({ message: "1" }),
        )
      ).status,
    ).toBe(403);
  });

  it("answers 404 for an unknown season, wave and message", async () => {
    const { runtime, cookie, season } = await boot();

    const unknownSeason = await get(
      runtime,
      "/admin/seasons/9999/outbox",
      cookie,
    );
    expect(unknownSeason.status).toBe(404);
    expect(await unknownSeason.text()).toBe("No such season.");

    const unknownWave = await get(runtime, "/admin/outbox/waves/9999", cookie);
    expect(unknownWave.status).toBe(404);
    expect(await unknownWave.text()).toBe("No such outbox wave.");

    const unknownMessage = await get(
      runtime,
      "/admin/outbox/messages/9999",
      cookie,
    );
    expect(unknownMessage.status).toBe(404);
    expect(await unknownMessage.text()).toBe("No such outbox message.");

    const unknownEml = await get(
      runtime,
      "/admin/outbox/messages/9999.eml",
      cookie,
    );
    expect(unknownEml.status).toBe(404);
    expect(await unknownEml.text()).toBe("No such outbox message.");

    // The `.eml` pattern must not swallow the plain message route.
    const { messages } = await generateMatchWave(runtime, cookie, season.id);
    const plain = await get(
      runtime,
      `/admin/outbox/messages/${messages[0]!.id}`,
      cookie,
    );
    expect(plain.headers.get("content-type")).toContain("text/html");
  });

  it("generates a wave and lists every message with its recipients and state", async () => {
    const port = new SpyEmailPort();
    const { runtime, cookie, season } = await boot({ email: port });

    const generated = await generateMatchWave(runtime, cookie, season.id);
    expect(generated.response.status).toBe(303);
    expect(generated.location).toContain("generated=4");
    expect(generated.messages).toHaveLength(4);
    // R11: generation is not transmission.
    expect(port.deliveries).toHaveLength(0);

    const html = await (
      await get(runtime, `/admin/outbox/waves/${generated.waveId}`, cookie)
    ).text();
    for (const porch of PORCHES) expect(html).toContain(porch.address);
    expect(html).toContain("maple-street-porch@example.invalid");
    expect(html).toContain("the-porch-cats@example.invalid");
    expect(html).toContain("Generated");
    expect(html).toContain("Send selected");
    expect(html).toContain("Export selected");
    expect(html).toContain("Sending through spy");

    const seasonHtml = await (
      await get(runtime, `/admin/seasons/${season.id}/outbox`, cookie)
    ).text();
    expect(seasonHtml).toContain("match");
    expect(seasonHtml).toContain(`/admin/outbox/waves/${generated.waveId}`);
    expect(seasonHtml).toContain("4 generated");
  });

  it("marks a message stale when the data behind it changes, keeping edits", async () => {
    const { runtime, cookie, season, venues } = await boot();
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const target = messages.find(
      (message) => message.recordId === venues[0]!.venue.id,
    )!;

    const editPage = await get(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
    );
    const editCsrf = csrf(
      await editPage.text(),
      `/admin/outbox/messages/${target.id}`,
    );
    await post(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
      new URLSearchParams({
        _csrf: editCsrf,
        version: String(target.version),
        subject: target.subject,
        text: "Hand written note for the host.",
      }),
    );

    const venue = runtime.core.seasons.getVenue(venues[0]!.venue.id);
    runtime.core.seasons.updateVenue(venue.id, venue.version, {
      spaceDescription: "A newly rebuilt porch with a wider deck",
    });

    const html = await (
      await get(runtime, `/admin/outbox/waves/${waveId}`, cookie)
    ).text();
    expect(html).toContain("Data changed since this was written");
    // AE8: the edit survives the staleness mark.
    expect(runtime.core.outbox.getMessage(target.id).textBody).toBe(
      "Hand written note for the host.",
    );
    expect(runtime.core.outbox.getMessage(target.id).state).toBe(
      "edited_stale",
    );
  });

  it("persists an edit, regenerates the HTML, and refuses a stale version", async () => {
    const { runtime, cookie, season } = await boot();
    const { messages } = await generateMatchWave(runtime, cookie, season.id);
    const target = messages[0]!;

    const editPage = await get(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
    );
    const editHtml = await editPage.text();
    expect(editPage.status).toBe(200);
    expect(editHtml).toContain('name="text"');
    const editCsrf = csrf(editHtml, `/admin/outbox/messages/${target.id}`);

    const saved = await post(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
      new URLSearchParams({
        _csrf: editCsrf,
        version: String(target.version),
        subject: "A corrected subject",
        text: "First line.\n\n- one bullet",
      }),
    );
    expect(saved.status).toBe(303);

    const stored = runtime.core.outbox.getMessage(target.id);
    expect(stored.subject).toBe("A corrected subject");
    expect(stored.textBody).toBe("First line.\n\n- one bullet");
    expect(stored.htmlBody).toBe(
      "<p>First line.</p>\n<ul>\n<li>one bullet</li>\n</ul>",
    );
    expect(stored.state).toBe("edited");

    const stale = await post(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
      new URLSearchParams({
        _csrf: editCsrf,
        version: String(target.version),
        subject: "A second attempt",
        text: "Second attempt.",
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("error-summary");
    expect(runtime.core.outbox.getMessage(target.id).subject).toBe(
      "A corrected subject",
    );
  });

  it("renders a sent message read-only and refuses to edit it", async () => {
    const port = new SpyEmailPort();
    const { runtime, cookie, season } = await boot({ email: port });
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const target = messages[0]!;

    const wavePage = await get(
      runtime,
      `/admin/outbox/waves/${waveId}`,
      cookie,
    );
    const sendCsrf = csrf(
      await wavePage.text(),
      `/admin/outbox/waves/${waveId}/send`,
    );
    await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      new URLSearchParams({
        _csrf: sendCsrf,
        message: String(target.id),
        [`version_${target.id}`]: String(target.version),
      }),
    );
    expect(runtime.core.outbox.getMessage(target.id).state).toBe("sent");

    const readOnly = await get(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
    );
    const readOnlyHtml = await readOnly.text();
    expect(readOnly.status).toBe(200);
    expect(readOnlyHtml).not.toContain('name="text"');
    expect(readOnlyHtml).toContain("This message was sent and cannot change.");
    expect(readOnlyHtml).toContain("maple-street-porch@example.invalid");

    // The read-only page has no form to lift a token from, which is the point.
    // A stale tab open on another message of the same route carries a valid one.
    const otherHtml = await (
      await get(runtime, `/admin/outbox/messages/${messages[1]!.id}`, cookie)
    ).text();
    const refused = await post(
      runtime,
      `/admin/outbox/messages/${target.id}`,
      cookie,
      new URLSearchParams({
        _csrf: csrf(otherHtml, `/admin/outbox/messages/${messages[1]!.id}`),
        version: String(runtime.core.outbox.getMessage(target.id).version),
        subject: "Too late",
        text: "Too late",
      }),
    );
    expect(refused.status).toBe(409);
  });

  it("offers export only when no provider is configured", async () => {
    const { runtime, cookie, season } = await boot();
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );

    const wavePage = await get(
      runtime,
      `/admin/outbox/waves/${waveId}`,
      cookie,
    );
    const html = await wavePage.text();
    expect(html).not.toContain("Send selected");
    expect(html).toContain(
      "No email provider configured — messages can be copied or exported",
    );
    expect(html).toContain("Export selected");

    const sendCsrf = csrf(html, `/admin/outbox/waves/${waveId}/send`);
    // One form, one token, one path: the export buttons post their intent
    // rather than re-aiming the selection at a GET route, so no CSRF token and
    // no per-message version ever reaches the URL.
    expect(html).toContain('name="intent" value="export-text"');
    expect(html).not.toContain("formmethod=");
    expect(html).not.toContain("/export");

    const exportBody = (intent: string) => {
      const body = new URLSearchParams({ _csrf: sendCsrf, intent });
      // The same id twice must export once (a selection is a set).
      body.append("message", String(messages[0]!.id));
      for (const message of messages)
        body.append("message", String(message.id));
      return body;
    };

    const exported = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      exportBody("export-text"),
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/plain");
    expect(exported.headers.get("cache-control")).toBe("no-store, private");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const text = await exported.text();
    for (const message of messages) expect(text).toContain(message.textBody!);
    expect(text.split("----- next message -----")).toHaveLength(4);

    const emlResponse = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      exportBody("export-eml"),
    );
    expect(emlResponse.status).toBe(200);
    expect(emlResponse.headers.get("content-type")).toContain(
      "application/mbox",
    );
    expect(emlResponse.headers.get("content-disposition")).toContain(
      'filename="outbox-wave-',
    );
    const emlBundle = await emlResponse.text();
    expect(emlBundle).toContain("MIME-Version: 1.0");
    expect(emlBundle.split(/^From porchfest@localhost /m)).toHaveLength(5);

    // No provider is configured, and nothing about an export may reach one.
    const refused = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      new URLSearchParams({ _csrf: sendCsrf, intent: "export-text" }),
    );
    expect(refused.status).toBe(400);
    const refusedHtml = await refused.text();
    expect(refusedHtml).toContain("Nothing was exported");
    expect(refusedHtml).toContain(
      "Select at least one message before exporting.",
    );
    expect(refusedHtml).toContain("Review and send");

    const single = await get(
      runtime,
      `/admin/outbox/messages/${messages[0]!.id}.eml`,
      cookie,
    );
    expect(single.status).toBe(200);
    expect(single.headers.get("content-type")).toContain("message/rfc822");
    expect(single.headers.get("content-disposition")).toContain("attachment");
    expect(single.headers.get("cache-control")).toBe("no-store, private");
    const eml = await single.text();
    expect(eml).toContain("From: organizers@example.invalid");
    expect(eml).toContain("To: maple-street-porch@example.invalid");
    expect(eml).toContain('Content-Type: multipart/alternative; boundary="');
    expect(eml).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(eml).toContain('Content-Type: text/html; charset="utf-8"');
  });

  it("refuses to send when no provider is configured", async () => {
    const { runtime, cookie, season } = await boot();
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const wavePage = await get(
      runtime,
      `/admin/outbox/waves/${waveId}`,
      cookie,
    );
    const sendCsrf = csrf(
      await wavePage.text(),
      `/admin/outbox/waves/${waveId}/send`,
    );

    const refused = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      new URLSearchParams({
        _csrf: sendCsrf,
        message: String(messages[0]!.id),
        [`version_${messages[0]!.id}`]: String(messages[0]!.version),
      }),
    );
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("no email provider is configured");
    expect(runtime.core.outbox.getMessage(messages[0]!.id).sentAt).toBeNull();
  });

  it("sends only the selected messages and records one delivery per recipient", async () => {
    const port = new SpyEmailPort();
    const { runtime, cookie, season } = await boot({ email: port });
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const selected = messages.slice(0, 3);
    const untouched = messages[3]!;

    const wavePage = await get(
      runtime,
      `/admin/outbox/waves/${waveId}`,
      cookie,
    );
    const sendCsrf = csrf(
      await wavePage.text(),
      `/admin/outbox/waves/${waveId}/send`,
    );
    const body = new URLSearchParams({ _csrf: sendCsrf });
    for (const message of selected) {
      body.append("message", String(message.id));
      body.append(`version_${message.id}`, String(message.version));
    }

    const result = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      body,
    );
    // 303, not a rendered 200: a reload of a rendered result re-posts the same
    // body, and a partially sent wave would transmit again unprompted (R11).
    expect(result.status).toBe(303);
    const location = result.headers.get("location") ?? "";
    expect(location).toContain(`/admin/outbox/waves/${waveId}?`);
    const summary = new URLSearchParams(location.split("?")[1] ?? "");
    expect(summary.get("sent")).toBe("6");
    expect(summary.get("failed")).toBe("0");
    expect(summary.get("unrecorded")).toBe("0");

    const resultHtml = await (await get(runtime, location, cookie)).text();
    expect(resultHtml).toContain("6 sent, 0 failed, 0 skipped of 6 attempted.");
    expect(resultHtml).toContain("maple-street-porch@example.invalid");

    expect(port.deliveries).toHaveLength(6);
    for (const message of selected) {
      expect(runtime.core.outbox.getMessage(message.id).state).toBe("sent");
    }
    expect(runtime.core.outbox.getMessage(untouched.id).sentAt).toBeNull();
    expect(runtime.core.outbox.getMessage(untouched.id).state).toBe(
      "generated",
    );
    expect(runtime.core.outbox.listSendHistory(season.id)).toHaveLength(6);
  });

  it("shows a failed delivery on the result page and stamps nothing", async () => {
    const port = new SpyEmailPort();
    port.respond = () => ({ status: "failed", reason: "mailbox unavailable" });
    const { runtime, cookie, season } = await boot({ email: port });
    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const target = messages[0]!;

    const wavePage = await get(
      runtime,
      `/admin/outbox/waves/${waveId}`,
      cookie,
    );
    const sendCsrf = csrf(
      await wavePage.text(),
      `/admin/outbox/waves/${waveId}/send`,
    );
    const result = await post(
      runtime,
      `/admin/outbox/waves/${waveId}/send`,
      cookie,
      new URLSearchParams({
        _csrf: sendCsrf,
        message: String(target.id),
        [`version_${target.id}`]: String(target.version),
      }),
    );

    expect(result.status).toBe(303);
    const location = result.headers.get("location") ?? "";
    expect(
      new URLSearchParams(location.split("?")[1] ?? "").get("failed"),
    ).toBe("2");
    const html = await (await get(runtime, location, cookie)).text();
    expect(html).toContain("0 sent, 2 failed, 0 skipped of 2 attempted.");
    expect(html).toContain("Failed");
    expect(html).toContain("mailbox unavailable");

    const stored = runtime.core.outbox.getMessage(target.id);
    expect(stored.sentAt).toBeNull();
    expect(stored.state).toBe("generated");
    for (const recipient of stored.recipients) {
      expect(recipient.sentAt).toBeNull();
      expect(recipient.outcome).toBe("failed");
    }
    expect(runtime.core.outbox.listSendHistory(season.id)).toHaveLength(0);
  });

  it("creates an ad-hoc wave from organizer text and preserves values on error", async () => {
    const { runtime, cookie, season } = await boot();
    const page = await get(
      runtime,
      `/admin/seasons/${season.id}/outbox`,
      cookie,
    );
    const html = await page.text();
    const adHocCsrf = csrf(html, `/admin/seasons/${season.id}/outbox/ad-hoc`);
    expect(adHocCsrf.length).toBeGreaterThan(0);

    const contacts = runtime.core.queue
      .listForOrganizer(season.id, 1)
      .filter((item) => item.recordType === "contact");
    expect(contacts.length).toBeGreaterThan(0);
    expect(html).toContain(`name="contact" type="checkbox"`);

    const invalid = await post(
      runtime,
      `/admin/seasons/${season.id}/outbox/ad-hoc`,
      cookie,
      new URLSearchParams({
        _csrf: adHocCsrf,
        label: "",
        subject: "A subject worth keeping",
        text: "A body worth keeping",
      }),
    );
    expect(invalid.status).toBe(400);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain("A subject worth keeping");
    expect(invalidHtml).toContain("A body worth keeping");

    const created = await post(
      runtime,
      `/admin/seasons/${season.id}/outbox/ad-hoc`,
      cookie,
      new URLSearchParams({
        _csrf: adHocCsrf,
        label: "weather-warning",
        subject: "Rain on Saturday",
        text: "Bring a tarp.",
        contact: String(contacts[0]!.record.id),
      }),
    );
    expect(created.status).toBe(303);
    const waveId = Number(
      (created.headers.get("location") ?? "").match(/waves\/(\d+)/)?.[1],
    );
    const waveMessages = runtime.core.outbox.listMessages(waveId);
    expect(waveMessages).toHaveLength(1);
    expect(waveMessages[0]!.subject).toBe("Rain on Saturday");
    expect(waveMessages[0]!.textBody).toBe("Bring a tarp.");
  });

  it("links the outbox from the queue and the season lifecycle pages", async () => {
    const { runtime, cookie, season } = await boot();

    const queue = await (
      await get(runtime, `/admin?season=${season.id}`, cookie)
    ).text();
    expect(queue).toContain(`/admin/seasons/${season.id}/outbox`);

    const lifecycle = await (
      await get(runtime, `/admin/seasons/${season.id}`, cookie)
    ).text();
    expect(lifecycle).toContain(`/admin/seasons/${season.id}/outbox`);
  });

  it("escapes markup that reaches a rendered body, preview and .eml", async () => {
    const { runtime, cookie, season } = await boot();
    // A host can type anything into a porch title, and it flows through the
    // match template into every rendered body.
    const hostile = '<script>alert("x")</script> "Porch"';
    const venue = runtime.core.seasons.createHostSignup({
      seasonId: season.id,
      contact: {
        name: "Hostile Title Host",
        email: "hostile-title@example.invalid",
      },
      venue: {
        title: hostile,
        address: "99 Script Street",
        spaceDescription: hostile,
        hasPower: true,
        rainBackup: false,
        requestedActNames: null,
        genrePreferences: "Folk",
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    });
    const act = runtime.core.seasons.createPerformerSignup({
      seasonId: season.id,
      contact: {
        name: "Hostile Title Act Contact",
        email: "hostile-title-act@example.invalid",
      },
      act: {
        name: "The Escapers",
        durationMinutes: 45,
        requiresAmplification: false,
        genre: "Folk",
        description: "The Escapers description",
        links: "",
        housePreference: null,
        sharedMemberNote: null,
        canLendGear: false,
        notes: null,
      },
      availabilities: [],
    });
    const slot = runtime.core.seasons.ensureVenueSlots(venue.venue.id)[0]!;
    runtime.core.seasons.assignSlot(slot.id, slot.version, act.act.id);

    const { waveId, messages } = await generateMatchWave(
      runtime,
      cookie,
      season.id,
    );
    const target = messages.find((message) =>
      (message.textBody ?? "").includes(hostile),
    );
    expect(target).toBeDefined();
    expect(target!.htmlBody).toContain("&lt;script&gt;");
    expect(target!.htmlBody).not.toContain("<script>");

    const wave = await (
      await get(runtime, `/admin/outbox/waves/${waveId}`, cookie)
    ).text();
    expect(wave).toContain("&lt;script&gt;");
    expect(wave).not.toContain("<script>alert");

    // The HTML preview is the one raw interpolation on this surface. It is safe
    // only because every writer of `htmlBody` escapes first; this is the test
    // that fails if that ever stops being true.
    const messagePage = await (
      await get(runtime, `/admin/outbox/messages/${target!.id}`, cookie)
    ).text();
    expect(messagePage).toContain("&lt;script&gt;");
    expect(messagePage).not.toContain("<script>alert");

    // The .eml carries both parts, so the plain-text part holds the raw
    // characters by design; the HTML part must not.
    const eml = await (
      await get(runtime, `/admin/outbox/messages/${target!.id}.eml`, cookie)
    ).text();
    expect(eml).toContain("&lt;script&gt;");
  });

  it("serves the select-all helper script that no-ops without its container", async () => {
    const { runtime, cookie, season } = await boot();
    const { waveId } = await generateMatchWave(runtime, cookie, season.id);

    const html = await (
      await get(runtime, `/admin/outbox/waves/${waveId}`, cookie)
    ).text();
    expect(html).toContain('src="/admin/assets/admin.js"');
    expect(html).toContain('name="select_all"');

    const script = await get(runtime, "/admin/assets/admin.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const source = await script.text();
    expect(source).toContain("outbox-selection");

    // KTD3 is in the test's name, so the test executes the script rather than
    // reading it: without its container it must touch nothing and throw
    // nothing, and deleting the guard has to turn this red.
    const run = new Function("document", source) as (document: unknown) => void;
    expect(() => {
      run({
        getElementById: () => null,
      });
    }).not.toThrow();

    const boxes = [makeBox(), makeBox()];
    const toggle = makeBox();
    run({
      getElementById: (id: string) =>
        id === "outbox-selection"
          ? {
              querySelector: () => toggle,
              querySelectorAll: () => boxes,
            }
          : null,
    });
    toggle.checked = true;
    toggle.fire("change");
    expect(boxes.map((box) => box.checked)).toEqual([true, true]);

    // Unticking one message must stop the master box claiming "every unsent".
    boxes[0]!.checked = false;
    boxes[0]!.fire("change");
    expect(toggle.checked).toBe(false);
    expect(toggle.indeterminate).toBe(true);
  });
});
