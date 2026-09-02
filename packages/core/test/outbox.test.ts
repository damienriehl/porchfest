import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
} from "../src/ports/index.js";
import { formatZonedWindow } from "../src/matching.js";
import {
  buildActSchedule,
  createOutboxRepository,
  OutboxLifecycleError,
  type OutboxRepository,
} from "../src/outbox.js";
import { createSeasonRepository } from "../src/season.js";
import { createSeasonSetup } from "../src/setup.js";
import type { Contact, Season, Venue } from "../src/storage/schema.js";
import { openTestDatabase, type TestDatabase } from "./support/db.js";

interface FixtureFile {
  readonly season: {
    readonly year: number;
    readonly displayName: string;
    readonly timezone: string;
    readonly eventDate: string;
    readonly timeSlots: readonly { startsAt: string; endsAt: string }[];
    readonly publicMapUrl: string;
    readonly senderName: string;
    readonly senderEmail: string;
    readonly openSignups: boolean;
  };
  readonly hosts: readonly {
    readonly key: string;
    readonly contact: { name: string; email: string; phone: string | null };
    readonly venue: {
      title: string;
      address: string;
      spaceDescription: string;
      hasPower: boolean;
      rainBackup: boolean;
      notes: string | null;
      requestedActNames: string | null;
      genrePreferences: string | null;
    };
    readonly gear: readonly string[];
    readonly drinks: readonly string[];
    readonly amenities: readonly string[];
  }[];
  readonly performers: readonly {
    readonly key: string;
    readonly contact: { name: string; email: string; phone: string | null };
    readonly act: {
      name: string;
      durationMinutes: number;
      requiresAmplification: boolean;
      genre: string;
      description: string;
      links: string;
      housePreference: string | null;
      canLendGear: boolean;
      notes: string | null;
      sharedMemberNote: string | null;
    };
  }[];
  readonly assignments: readonly {
    host: string;
    act: string;
    slot: number;
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/outbox-season.json", import.meta.url),
    "utf8",
  ),
) as FixtureFile;

class SpyEmailPort implements EmailPort {
  readonly name = "spy";
  configured = true;
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

const pinnedNow = new Date("2105-09-05T12:00:00.000Z");

describe("outbox", () => {
  let database: TestDatabase;
  let seasons: ReturnType<typeof createSeasonRepository>;
  let outbox: OutboxRepository;
  let port: SpyEmailPort;
  let season: Season;
  let venueIds: Map<string, Venue>;
  let actIds: Map<string, { id: number; contact: Contact }>;

  beforeEach(async () => {
    database = await openTestDatabase("porchfest-outbox-");
    seasons = createSeasonRepository(database.db, { now: () => pinnedNow });
    port = new SpyEmailPort();
    outbox = createOutboxRepository(
      database.db,
      { email: port },
      { now: () => pinnedNow },
    );

    const setup = createSeasonSetup(database.db, () => pinnedNow);
    season = setup.createSeason({
      year: fixture.season.year,
      displayName: fixture.season.displayName,
      timezone: fixture.season.timezone,
      eventDate: fixture.season.eventDate,
      eventCity: "Exampleton",
      eventState: "WI",
      timeSlots: fixture.season.timeSlots,
      publicMapUrl: fixture.season.publicMapUrl,
      senderName: fixture.season.senderName,
      senderEmail: fixture.season.senderEmail,
      openSignups: fixture.season.openSignups,
    }).season;

    venueIds = new Map();
    const hostContacts = new Map<string, Contact>();
    for (const host of fixture.hosts) {
      const signup = seasons.createHostSignup({
        seasonId: season.id,
        contact: host.contact,
        venue: host.venue,
        gear: host.gear as never,
        drinks: host.drinks as never,
        amenities: host.amenities as never,
      });
      venueIds.set(host.key, signup.venue);
      hostContacts.set(host.key, signup.contact);
    }
    actIds = new Map();
    for (const performer of fixture.performers) {
      const signup = seasons.createPerformerSignup({
        seasonId: season.id,
        contact: performer.contact,
        act: performer.act,
        availabilities: [],
      });
      actIds.set(performer.key, {
        id: signup.act.id,
        contact: signup.contact,
      });
    }
    for (const assignment of fixture.assignments) {
      const venue = venueIds.get(assignment.host)!;
      const slot = seasons.listVenueSlots(venue.id)[assignment.slot]!;
      seasons.assignSlot(slot.id, slot.version, actIds.get(assignment.act)!.id);
    }
  });

  afterEach(async () => {
    await database.close();
  });

  function matchWave() {
    return outbox.generateWave({ seasonId: season.id, kind: "match" });
  }

  function hostContactId(key: string): number {
    return venueIds.get(key)!.hostContactId!;
  }

  function contactVersion(contactId: number): number {
    return (
      database.sqlite
        .prepare("select version from contacts where id = ?")
        .get(contactId) as { version: number }
    ).version;
  }

  // --- AE8: staleness ------------------------------------------------------

  it("marks an edited message stale with its edits intact and never regenerates it", () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    expect(message.state).toBe("generated");

    const edited = outbox.editMessage(message.id, message.version, {
      subject: "A subject the organizer wrote",
      text: "We moved you to the side yard. Everything else stands.",
    });
    expect(edited.state).toBe("edited");

    const venue = venueIds.get("maple")!;
    seasons.updateVenue(venue.id, venue.version, {
      address: "101 Maple Street",
    });

    const stale = outbox.getMessage(message.id);
    expect(stale.state).toBe("edited_stale");
    expect(stale.subject).toBe("A subject the organizer wrote");
    expect(stale.textBody).toContain("We moved you to the side yard");

    matchWave();
    const afterRegeneration = outbox.getMessage(message.id);
    expect(afterRegeneration.state).toBe("edited_stale");
    expect(afterRegeneration.textBody).toContain(
      "We moved you to the side yard",
    );
    expect(afterRegeneration.textBody).not.toContain("101 Maple Street");
  });

  it("stales a generated message on drift, restores it on repair, and replaces it on regeneration", () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    expect(message.textBody).toContain("100 Maple Street");

    let venue = seasons.getVenue(venueIds.get("maple")!.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "101 Maple Street",
    });
    expect(outbox.getMessage(message.id).state).toBe("generated_stale");

    venue = seasons.getVenue(venue.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "100 Maple Street",
    });
    expect(outbox.getMessage(message.id).state).toBe("generated");

    venue = seasons.getVenue(venue.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "101 Maple Street",
    });
    matchWave();
    const replaced = outbox.getMessage(message.id);
    expect(replaced.state).toBe("generated");
    expect(replaced.textBody).toContain("101 Maple Street");
  });

  // --- KTD6 / AE9: per-recipient send state --------------------------------

  it("records one send per recipient and keeps the address it went to", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    expect(message.recipients).toHaveLength(3);

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    expect(report.sent).toBe(3);
    expect(port.deliveries).toHaveLength(3);
    expect(
      port.deliveries.every(({ recipients }) => recipients.length === 1),
    ).toBe(true);
    const history = outbox.listSendHistory(season.id);
    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.address).sort()).toEqual([
      "alder@example.invalid",
      "ash@example.invalid",
      "wren@example.invalid",
    ]);
    expect(history.every((entry) => entry.outcome === "sent")).toBe(true);
    expect(history.every((entry) => entry.messageId === message.id)).toBe(true);
    expect(outbox.getMessage(message.id).state).toBe("sent");
  });

  it("clears a corrected recipient's send state and keeps the old address in the log", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    const contactId = hostContactId("maple");
    const contact = seasons.updateContact(
      contactId,
      contactVersion(contactId),
      {
        email: "wren.new@example.invalid",
      },
    );
    expect(contact.email).toBe("wren.new@example.invalid");

    const corrected = outbox.getMessage(message.id);
    const recipient = corrected.recipients.find(
      (row) => row.contactId === contactId,
    )!;
    expect(recipient.sentAt).toBeNull();
    expect(recipient.outcome).toBeNull();
    expect(recipient.address).toBe("wren.new@example.invalid");
    expect(recipient.previousAddress).toBe("wren@example.invalid");
    expect(corrected.state).not.toBe("sent");
    expect(corrected.sentAt).toBeNull();
    expect(
      corrected.recipients.filter((row) => row.sentAt !== null),
    ).toHaveLength(2);

    const history = outbox.listSendHistory(season.id);
    expect(history).toHaveLength(3);
    expect(
      history.some((entry) => entry.address === "wren@example.invalid"),
    ).toBe(true);
  });

  it("records a failed delivery without stamping the recipient or the log", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    port.respond = (email) =>
      email.recipients[0] === "ash@example.invalid"
        ? { status: "failed", reason: "mailbox rejected the message" }
        : { status: "sent", providerMessageId: "provider-1" };

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    expect(report.sent).toBe(2);
    expect(report.failed).toBe(1);
    const stored = outbox.getMessage(message.id);
    const failed = stored.recipients.find(
      (row) => row.address === "ash@example.invalid",
    )!;
    expect(failed.sentAt).toBeNull();
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain("mailbox rejected");
    expect(stored.state).not.toBe("sent");
    expect(outbox.listSendHistory(season.id)).toHaveLength(2);
  });

  it("records a thrown adapter error as a failure rather than a partial stamp", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    port.respond = () => {
      throw new Error("connection reset by the relay");
    };

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    expect(report.sent).toBe(0);
    expect(report.failed).toBe(3);
    const stored = outbox.getMessage(message.id);
    expect(stored.recipients.every((row) => row.sentAt === null)).toBe(true);
    expect(
      stored.recipients.every((row) =>
        row.reason?.includes("connection reset"),
      ),
    ).toBe(true);
    expect(outbox.listSendHistory(season.id)).toHaveLength(0);
  });

  // --- R30: a sent message is immutable ------------------------------------

  it("refuses to edit a sent message and leaves it out of regeneration", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });
    const sent = outbox.getMessage(message.id);
    expect(sent.state).toBe("sent");

    expect(() =>
      outbox.editMessage(message.id, sent.version, { text: "rewritten" }),
    ).toThrow(OutboxLifecycleError);
    expect(() =>
      outbox.editMessage(message.id, sent.version, { text: "rewritten" }),
    ).toThrow(/immutable/);

    const venue = seasons.getVenue(venueIds.get("maple")!.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "101 Maple Street",
    });
    matchWave();
    const afterRegeneration = outbox.getMessage(message.id);
    expect(afterRegeneration.state).toBe("sent");
    expect(afterRegeneration.subject).toBe(sent.subject);
  });

  // --- R12 / AE1: no provider ---------------------------------------------

  it("refuses to send with no provider and exports copy-paste text and an eml", async () => {
    port.configured = false;
    const generated = matchWave();
    const message = generated.messages[0]!;

    await expect(
      outbox.sendSelection({
        waveId: generated.wave.id,
        messageIds: [message.id],
        expectedVersions: { [message.id]: message.version },
      }),
    ).rejects.toBeInstanceOf(OutboxLifecycleError);
    expect(port.deliveries).toHaveLength(0);

    const exported = outbox.exportSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]!.text).toContain("100 Maple Street");
    const eml = exported[0]!.eml;
    expect(eml.split("\r\n")).toContain("From: organizers@example.invalid");
    expect(eml).toContain("wren@example.invalid");
    expect(eml).toContain("multipart/alternative");
    for (const codePoint of eml) {
      expect(codePoint.codePointAt(0)!).toBeLessThan(128);
    }
  });

  it("transmits nothing while generating", () => {
    matchWave();
    outbox.generateWave({ seasonId: season.id, kind: "thank_you" });
    outbox.generateWave({ seasonId: season.id, kind: "post_event" });
    expect(port.deliveries).toHaveLength(0);
  });

  // --- wave scale ----------------------------------------------------------

  it("sends thirty-five selected messages in one call and leaves the rest untouched", async () => {
    for (let index = 0; index < 34; index += 1) {
      seasons.createHostSignup({
        seasonId: season.id,
        contact: {
          name: `Extra Host ${index}`,
          email: `extra-${index}@example.invalid`,
          phone: null,
        },
        venue: {
          title: `Extra Porch ${index}`,
          address: `${index} Extra Street`,
          spaceDescription: "A porch",
          hasPower: false,
          rainBackup: false,
          notes: null,
        },
        gear: [],
        drinks: [],
        amenities: [],
      });
    }

    const generated = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    expect(generated.messages.length).toBe(36);
    const selected = generated.messages.slice(0, 35);
    const untouched = generated.messages[35]!;

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: selected.map((message) => message.id),
      expectedVersions: Object.fromEntries(
        selected.map((message) => [message.id, message.version]),
      ),
    });

    expect(report.sent).toBe(35);
    expect(port.deliveries).toHaveLength(35);
    expect(outbox.listSendHistory(season.id)).toHaveLength(35);
    const skipped = outbox.getMessage(untouched.id);
    expect(skipped.state).toBe("generated");
    expect(skipped.sentAt).toBeNull();
    expect(skipped.recipients.every((row) => row.sentAt === null)).toBe(true);
  });

  // --- KTD8: purge ---------------------------------------------------------

  it("purges bodies once a wave completes and keeps recipients and history", async () => {
    const generated = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: generated.messages.map((message) => message.id),
      expectedVersions: Object.fromEntries(
        generated.messages.map((message) => [message.id, message.version]),
      ),
    });

    const waves = outbox.listWaves(season.id);
    const wave = waves.find((row) => row.id === generated.wave.id)!;
    expect(wave.status).toBe("complete");
    for (const message of outbox.listMessages(generated.wave.id)) {
      expect(message.state).toBe("sent");
      expect(message.textBody).toBeNull();
      expect(message.htmlBody).toBeNull();
      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.recipients.length).toBeGreaterThan(0);
      expect(message.recipients.every((row) => row.sentAt !== null)).toBe(true);
    }
    expect(outbox.listSendHistory(season.id)).toHaveLength(2);
  });

  it("leaves a message regenerated after the purge intact", async () => {
    const generated = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: generated.messages.map((message) => message.id),
      expectedVersions: Object.fromEntries(
        generated.messages.map((message) => [message.id, message.version]),
      ),
    });
    expect(
      outbox.listWaves(season.id).find((row) => row.id === generated.wave.id)!
        .status,
    ).toBe("complete");

    // A late signup lands in the completed wave; the purge must not empty it.
    seasons.createHostSignup({
      seasonId: season.id,
      contact: {
        name: "Late Hollis",
        email: "late@example.invalid",
        phone: null,
      },
      venue: {
        title: "Late Lane Porch",
        address: "9 Late Lane",
        spaceDescription: "A wide stoop",
        hasPower: true,
        rainBackup: false,
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    });
    const regenerated = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    const fresh = regenerated.messages.find(
      (message) => message.state === "generated",
    )!;
    expect(fresh.textBody).toContain("9 Late Lane");

    outbox.purgeCompletedWaves(season.id);
    const afterPurge = outbox.getMessage(fresh.id);
    expect(afterPurge.textBody).toContain("9 Late Lane");
    expect(afterPurge.htmlBody).not.toBeNull();
    expect(
      outbox.listWaves(season.id).find((row) => row.id === generated.wave.id)!
        .status,
    ).toBe("open");
  });

  // --- R10: determinism and byte-traceability ------------------------------

  it("renders every contact, venue, and gear value straight from the rows", () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    const text = message.textBody!;
    const venue = venueIds.get("maple")!;
    const slots = seasons.listVenueSlots(venue.id);

    expect(text).toContain("- Address: 100 Maple Street");
    expect(text).toContain("- Space: Front porch with a wide step");
    expect(text).toContain("- Power: Yes");
    expect(text).toContain("- The host can provide: PA, microphone");
    expect(text).toContain("- Drinks on offer: water");
    expect(text).toContain("- On site: seating, shade");
    expect(text).toContain("Park on the north side of the street.");
    expect(text).toContain(
      `- Ash Reedy — ash@example.invalid — synthetic-notes-phone`,
    );
    expect(text).toContain("- Alder Quill — alder@example.invalid");
    expect(text).toContain(
      `- ${formatZonedWindow(slots[0]!, fixture.season.timezone)} — The Synthetic Notes`,
    );
    expect(text).toContain("The Synthetic Notes requires amplification");
    expect(text).toContain("https://porchfest.example.invalid/map");
    expect(text).toContain("September 12, 2105");
    expect(text).not.toContain("{{");

    // Contacts are ordered by name, not by the order they signed up in.
    const contactOrder = ["Alder Quill", "Ash Reedy", "Wren Hostwood"].map(
      (name) => text.indexOf(name),
    );
    expect(contactOrder.every((position) => position >= 0)).toBe(true);
    expect([...contactOrder].sort((a, b) => a - b)).toEqual(contactOrder);
  });

  it("renders the current porch title, address, and neutral amplification wording", () => {
    const original = venueIds.get("maple")!;
    seasons.updateVenue(original.id, original.version, {
      title: "Garden Gate Stage",
      address: "204 Cedar Crescent",
    });

    const message = matchWave().messages[0]!;
    for (const body of [message.textBody!, message.htmlBody!]) {
      expect(body).toContain("Garden Gate Stage");
      expect(body).toContain("204 Cedar Crescent");
      expect(body).toContain("The Synthetic Notes requires amplification");
      expect(body).not.toContain("Maple Street Porch");
      expect(body).not.toContain("need amplification");
    }
  });

  it("shares disclosed match details without sending organizer-only performer answers to the host", () => {
    const message = matchWave().messages[0]?.textBody ?? "";

    expect(message).toContain("wren@example.invalid");
    expect(message).toContain("ash@example.invalid");
    expect(message).toContain("Park on the north side of the street.");
    expect(message).not.toContain("folk / jazz");
    expect(message).not.toContain("A porch with a roof");
    expect(message).not.toContain("can lend gear");
  });

  it("renders every ordered continuation window in an act schedule", () => {
    const venue = venueIds.get("oak")!;
    const slots = seasons.listVenueSlots(venue.id);
    const act = actIds.get("floating")!;
    const first = seasons.assignSlot(slots[0]!.id, slots[0]!.version, act.id);
    const single = buildActSchedule(
      {
        assignments: seasons.listAssignments(season.id),
        slotsById: new Map(slots.map((slot) => [slot.id, slot])),
        venues: [venue],
      },
      act.id,
      "Sorrel and the Vanes",
      fixture.season.timezone,
    );
    const firstWindow = formatZonedWindow(slots[0]!, fixture.season.timezone);
    expect(single.slotLines).toBe(`- ${firstWindow} — Sorrel and the Vanes`);
    expect(single.slotSummary).toBe(firstWindow);

    const continuation = seasons.assignSlot(
      slots[1]!.id,
      slots[1]!.version,
      act.id,
      {
        continuesAssignmentFromSlotId: slots[0]!.id,
      },
    );
    const continued = buildActSchedule(
      {
        assignments: seasons.listAssignments(season.id),
        slotsById: new Map(slots.map((slot) => [slot.id, slot])),
        venues: [venue],
      },
      act.id,
      "Sorrel and the Vanes",
      fixture.season.timezone,
    );
    const secondWindow = formatZonedWindow(slots[1]!, fixture.season.timezone);
    expect(continued.bookings.map(({ assignment }) => assignment.id)).toEqual([
      first.id,
      continuation.id,
    ]);
    expect(continued.slotLines).toBe(
      `- ${firstWindow} — Sorrel and the Vanes\n- ${secondWindow} — Sorrel and the Vanes`,
    );
    expect(continued.slotSummary).toBe(`${firstWindow}, ${secondWindow}`);
  });

  it("regenerates byte-identical messages from unchanged data", () => {
    const first = matchWave().messages[0]!;
    const second = matchWave().messages[0]!;
    expect(second.subject).toBe(first.subject);
    expect(second.textBody).toBe(first.textBody);
    expect(second.htmlBody).toBe(first.htmlBody);
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(second.version).toBe(first.version);
  });

  it("addresses unmatched venues and floating performers with their own letters", () => {
    const thankYou = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    expect(thankYou.messages).toHaveLength(2);
    expect(
      thankYou.messages.every((message) => message.recordType === "venue"),
    ).toBe(true);
    expect(thankYou.messages[0]!.subject).toContain("thank you");

    const floating = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
      recipientRule: "unmatched_acts",
    });
    expect(floating.wave.id).not.toBe(thankYou.wave.id);
    expect(floating.messages).toHaveLength(1);
    expect(floating.messages[0]!.recordType).toBe("act");
    expect(floating.messages[0]!.subject).toContain("Sorrel and the Vanes");
    expect(floating.messages[0]!.textBody).toContain(
      "Can only play after 7pm.",
    );
    expect(floating.messages[0]!.recipients.map((row) => row.address)).toEqual([
      "sorrel@example.invalid",
    ]);
  });

  it("generates a post-event follow-up for every participant with an editable body", () => {
    const generated = outbox.generateWave({
      seasonId: season.id,
      kind: "post_event",
    });
    // Three venues plus the one act nobody matched.
    expect(generated.messages).toHaveLength(4);
    const addresses = new Set(
      generated.messages.flatMap((message) =>
        message.recipients.map((row) => row.address),
      ),
    );
    expect(addresses).toEqual(
      new Set([
        "wren@example.invalid",
        "ash@example.invalid",
        "alder@example.invalid",
        "juniper@example.invalid",
        "linden@example.invalid",
        "sorrel@example.invalid",
      ]),
    );

    const message = generated.messages[0]!;
    expect(message.subject).toContain("Thank you for being part of");
    const edited = outbox.editMessage(message.id, message.version, {
      text: `${message.textBody!}\n\nPhotos are up on the site.`,
    });
    expect(edited.state).toBe("edited");
    expect(edited.htmlBody).toContain("Photos are up on the site.");
  });

  it("stores an organizer-authored ad-hoc wave verbatim", () => {
    const created = outbox.createAdHocWave({
      seasonId: season.id,
      label: "porch-swap",
      subject: "Can you swap porches?",
      text: "We need to move one act down the block. Are you free?",
      recipientContactIds: [hostContactId("maple"), hostContactId("oak")],
    });

    expect(created.wave.kind).toBe("ad_hoc");
    expect(created.wave.recipientRule).toBe("manual");
    expect(created.messages).toHaveLength(2);
    expect(created.messages[0]!.subject).toBe("Can you swap porches?");
    expect(created.messages[0]!.textBody).toBe(
      "We need to move one act down the block. Are you free?",
    );

    const venue = seasons.getVenue(venueIds.get("maple")!.id);
    seasons.updateVenue(venue.id, venue.version, {
      address: "101 Maple Street",
    });
    // An organizer-authored body has no generated source, so nothing can
    // silently invalidate it.
    expect(outbox.getMessage(created.messages[0]!.id).state).toBe("generated");
  });

  // --- U7D review findings -------------------------------------------------

  it("keeps recipients that were already sent when a message leaves the wave", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    expect(message.recipients).toHaveLength(3);
    port.respond = (email) =>
      email.recipients[0] === "alder@example.invalid"
        ? { status: "failed", reason: "mailbox rejected the message" }
        : { status: "sent", providerMessageId: "provider-1" };

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });
    expect(report.sent).toBe(2);
    expect(outbox.getMessage(message.id).sentAt).toBeNull();

    // The venue loses its acts, so it is no longer a matched venue and the
    // next generation no longer has a target for this message.
    for (const assignment of seasons.listAssignments(season.id)) {
      seasons.unassignSlot(assignment.id, assignment.version);
    }
    matchWave();

    const stamped = database.sqlite
      .prepare(
        "select count(*) as total from outbox_recipients where message_id = ? and sent_at is not null",
      )
      .get(message.id) as { total: number };
    expect(stamped.total).toBe(2);
    const survivor = outbox.getMessage(message.id);
    expect(
      survivor.recipients.filter((row) => row.sentAt !== null),
    ).toHaveLength(2);
    expect(outbox.listSendHistory(season.id)).toHaveLength(2);
  });

  it("refuses to send a message whose expected version the caller never supplied", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;

    await expect(
      outbox.sendSelection({
        waveId: generated.wave.id,
        messageIds: [message.id],
        expectedVersions: {},
      }),
    ).rejects.toBeInstanceOf(OutboxLifecycleError);
    expect(port.deliveries).toHaveLength(0);
    expect(outbox.getMessage(message.id).state).toBe("generated");
  });

  it("refuses to stamp a message sent when an edit landed after the plan was built", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    const transmitted: string[] = [];
    let rewritten = false;
    port.respond = (email) => {
      transmitted.push(email.subject);
      if (!rewritten) {
        rewritten = true;
        const current = outbox.getMessage(message.id);
        outbox.editMessage(current.id, current.version, {
          subject: "ORGANIZER REWROTE THIS",
          text: "A different letter entirely.",
        });
      }
      return { status: "sent", providerMessageId: "provider-1" };
    };

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    // Every recipient got the reviewed bytes, so the stored row must not be
    // frozen as `sent` around the organizer's newer text.
    expect(report.sent).toBe(3);
    expect(new Set(transmitted)).toEqual(new Set([message.subject]));
    expect(report.completedMessageIds).toEqual([]);
    const stored = outbox.getMessage(message.id);
    expect(stored.state).not.toBe("sent");
    expect(stored.sentAt).toBeNull();
    expect(stored.subject).toBe("ORGANIZER REWROTE THIS");
  });

  it("reports a failed outcome it could not record against the recipient", async () => {
    const generated = matchWave();
    const message = generated.messages[0]!;
    const target = message.recipients[0]!;
    port.respond = (email) => {
      if (email.recipients[0] !== target.address) {
        return { status: "sent", providerMessageId: "provider-1" };
      }
      // Something else moved this row on between the plan and the stamp.
      database.sqlite
        .prepare(
          "update outbox_recipients set version = version + 1 where id = ?",
        )
        .run(target.id);
      return { status: "failed", reason: "mailbox rejected the message" };
    };

    const report = await outbox.sendSelection({
      waveId: generated.wave.id,
      messageIds: [message.id],
      expectedVersions: { [message.id]: message.version },
    });

    const outcome = report.recipients.find(
      (row) => row.recipientId === target.id,
    )!;
    expect(outcome.status).toBe("failed");
    expect(outcome.recorded).toBe(false);
    expect(report.recipients.filter((row) => row.recorded)).toHaveLength(2);
  });

  it("renders without consulting the host's default collation", () => {
    const original = String.prototype.localeCompare;
    // A container whose ICU default differs must not reorder a message and
    // stale a whole season through the fingerprint.
    String.prototype.localeCompare = function (
      this: string,
      that: string,
      locales?: Intl.LocalesArgument,
      options?: Intl.CollatorOptions,
    ): number {
      if (locales === undefined) {
        throw new Error("the host's default collation was consulted");
      }
      return original.call(this, that, locales, options);
    };
    try {
      const generated = matchWave();
      const text = generated.messages[0]!.textBody!;
      const order = ["Alder Quill", "Ash Reedy", "Wren Hostwood"].map((name) =>
        text.indexOf(name),
      );
      expect(order.every((position) => position >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("refuses to reuse a wave label under a different recipient rule", () => {
    const thankYou = outbox.generateWave({
      seasonId: season.id,
      kind: "thank_you",
    });
    expect(thankYou.wave.recipientRule).toBe("unmatched_venues");

    expect(() =>
      outbox.generateWave({
        seasonId: season.id,
        kind: "thank_you",
        label: "thank_you",
        recipientRule: "unmatched_acts",
      }),
    ).toThrow(OutboxLifecycleError);
    expect(
      outbox.listWaves(season.id).find((row) => row.id === thankYou.wave.id)!
        .recipientRule,
    ).toBe("unmatched_venues");
    expect(
      outbox
        .listMessages(thankYou.wave.id)
        .every((message) => message.recordType === "venue"),
    ).toBe(true);
  });
});
