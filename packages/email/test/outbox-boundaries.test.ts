import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoneEmailAdapter } from "../src/none.js";
import {
  createOutboxRepository,
  OutboxConflictError,
} from "../../core/src/outbox.js";
import { createSeasonRepository } from "../../core/src/season.js";
import { createSeasonSetup } from "../../core/src/setup.js";
import {
  openTestDatabase,
  type TestDatabase,
} from "../../core/test/support/db.js";

describe("outbox persistence boundaries", () => {
  let database: TestDatabase;
  let outbox: ReturnType<typeof createOutboxRepository>;
  let seasons: ReturnType<typeof createSeasonRepository>;
  let seasonId: number;
  beforeEach(async () => {
    database = await openTestDatabase("outbox-boundaries-");
    seasonId = createSeasonSetup(database.db).createSeason({
      year: 2105,
      displayName: "Synthetic Festival",
      timezone: "UTC",
      eventDate: "2105-09-12",
      eventCity: "Exampleton",
      eventState: "WI",
      timeSlots: [],
      openSignups: true,
    }).season.id;
    seasons = createSeasonRepository(database.db);
    outbox = createOutboxRepository(database.db, {
      email: new NoneEmailAdapter(),
    });
  });
  afterEach(async () => database.close());
  function contact(email: string | null = "host@example.invalid") {
    return seasons.createHostSignup({
      seasonId,
      contact: { name: "Synthetic Host", email },
      venue: {
        title: "Synthetic Porch",
        address: "100 Example St",
        spaceDescription: "Porch",
        hasPower: true,
        rainBackup: false,
        notes: null,
      },
      gear: [],
      drinks: [],
      amenities: [],
    }).contact;
  }
  function adHoc(ids: number[], label = "notice") {
    return outbox.createAdHocWave({
      seasonId,
      label,
      subject: "Update",
      text: "Bring <water> & chairs",
      recipientContactIds: ids,
    });
  }

  it("rolls back the wave and earlier messages when any recipient is unknown", () => {
    const host = contact();
    expect(() => adHoc([host.id, 999999])).toThrow(/contact .* does not exist/);
    expect(outbox.listWaves(seasonId)).toEqual([]);
    expect(
      database.sqlite
        .prepare("select count(*) as count from outbox_messages")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.sqlite
        .prepare("select count(*) as count from outbox_recipients")
        .get(),
    ).toEqual({ count: 0 });
    expect(adHoc([host.id]).messages).toHaveLength(1);
  });

  it("deduplicates repeated recipients and keeps reviewed bytes when the label is reused", () => {
    const host = contact();
    const first = adHoc([host.id, host.id]);
    const edited = outbox.editMessage(
      first.messages[0]!.id,
      first.messages[0]!.version,
      { text: "Reviewed" },
    );
    const repeated = outbox.createAdHocWave({
      seasonId,
      label: "notice",
      subject: "Replacement",
      text: "Replacement",
      recipientContactIds: [host.id],
    });
    expect(repeated.messages).toHaveLength(1);
    expect(repeated.messages[0]).toEqual(edited);
    expect(repeated.messages[0]!.recipients).toHaveLength(1);
  });

  it("keeps empty waves open across settle and purge and exports an empty selection", () => {
    const wave = outbox.generateWave({ seasonId, kind: "match" });
    expect(wave.messages).toEqual([]);
    outbox.purgeCompletedWaves(seasonId);
    expect(outbox.listWaves(seasonId)[0]!.status).toBe("open");
    expect(
      outbox.exportSelection({ waveId: wave.wave.id, messageIds: [] }),
    ).toEqual([]);
  });

  it("exports a contact without email without inventing a recipient and never records delivery", async () => {
    const wave = adHoc([contact(null).id]);
    expect(wave.messages[0]!.recipients).toEqual([]);
    const exported = outbox.exportSelection({
      waveId: wave.wave.id,
      messageIds: [wave.messages[0]!.id],
    })[0]!;
    expect(exported.eml).toContain("To: \r\n");
    expect(exported.text).toBe("Bring <water> & chairs");
    await expect(
      outbox.sendSelection({
        waveId: wave.wave.id,
        messageIds: [wave.messages[0]!.id],
        expectedVersions: { [wave.messages[0]!.id]: wave.messages[0]!.version },
      }),
    ).rejects.toThrow(/no email provider/);
    expect(outbox.listSendHistory(seasonId)).toEqual([]);
    expect(outbox.getMessage(wave.messages[0]!.id).sentAt).toBeNull();
  });

  it("rejects stale edits atomically while preserving the latest HTML and subject", () => {
    const original = adHoc([contact().id]).messages[0]!;
    const edited = outbox.editMessage(original.id, original.version, {
      subject: "Approved",
      text: "<approved>",
    });
    expect(() =>
      outbox.editMessage(original.id, original.version, {
        subject: "Stale",
        text: "Discard",
      }),
    ).toThrow(OutboxConflictError);
    expect(outbox.getMessage(original.id)).toEqual(edited);
    expect(edited.htmlBody).toBe("<p>&lt;approved&gt;</p>");
  });

  it("rejects exports across wave boundaries without changing either message", () => {
    const host = contact();
    const first = adHoc([host.id]);
    const second = adHoc([host.id], "second");
    expect(() =>
      outbox.exportSelection({
        waveId: first.wave.id,
        messageIds: [second.messages[0]!.id],
      }),
    ).toThrow(/does not belong/);
    expect(outbox.getMessage(first.messages[0]!.id)).toEqual(first.messages[0]);
    expect(outbox.getMessage(second.messages[0]!.id)).toEqual(
      second.messages[0],
    );
  });

  it("rejects a label reused for another kind and manual generation without leaving a new wave", () => {
    adHoc([]);
    expect(() =>
      outbox.generateWave({ seasonId, kind: "thank_you", label: "notice" }),
    ).toThrow(/already exists as a ad_hoc wave/);
    expect(() => outbox.generateWave({ seasonId, kind: "ad_hoc" })).toThrow(
      /createAdHocWave/,
    );
    expect(outbox.listWaves(seasonId)).toHaveLength(1);
  });

  it("reports missing wave and message identities through public read and edit paths", () => {
    expect(() => outbox.listMessages(999999)).toThrow(/wave .* does not exist/);
    expect(() => outbox.getMessage(999999)).toThrow(
      /message .* does not exist/,
    );
    expect(() => outbox.editMessage(999999, 1, { text: "unused" })).toThrow(
      /message .* does not exist/,
    );
    expect(() => outbox.listWaves(999999)).toThrow(/season .* does not exist/);
  });
  it("removes unreviewed withdrawn targets and their unsent recipient rows on regeneration", () => {
    contact();
    const venue = seasons.listSeasonVenues(seasonId)[0]!;
    const generated = outbox.generateWave({ seasonId, kind: "thank_you" });
    expect(generated.messages).toHaveLength(1);
    seasons.setRecordStatus("venue", venue.id, venue.version, "withdrawn");
    expect(
      outbox.generateWave({ seasonId, kind: "thank_you" }).messages,
    ).toEqual([]);
    expect(
      database.sqlite
        .prepare("select count(*) as count from outbox_recipients")
        .get(),
    ).toEqual({ count: 0 });
    expect(outbox.listWaves(seasonId)[0]!.status).toBe("open");
  });

  it("retains organizer-edited messages when a venue leaves the audience", () => {
    contact();
    const venue = seasons.listSeasonVenues(seasonId)[0]!;
    const original = outbox.generateWave({ seasonId, kind: "thank_you" })
      .messages[0]!;
    const reviewed = outbox.editMessage(original.id, original.version, {
      text: "Personal followup",
    });
    seasons.setRecordStatus("venue", venue.id, venue.version, "withdrawn");
    expect(
      outbox.generateWave({ seasonId, kind: "thank_you" }).messages,
    ).toEqual([reviewed]);
  });

  it("restores an edited-stale message after its source is repaired without losing reviewed text", () => {
    contact();
    const venue = seasons.listSeasonVenues(seasonId)[0]!;
    const original = outbox.generateWave({ seasonId, kind: "thank_you" })
      .messages[0]!;
    const reviewed = outbox.editMessage(original.id, original.version, {
      text: "Personal followup",
    });
    seasons.updateVenue(venue.id, venue.version, { address: "200 Example St" });
    expect(outbox.getMessage(original.id).state).toBe("edited_stale");
    const changed = seasons.listSeasonVenues(seasonId)[0]!;
    seasons.updateVenue(venue.id, changed.version, { address: venue.address });
    const restored = outbox.getMessage(original.id);
    expect(restored.state).toBe("edited");
    expect(restored.textBody).toBe(reviewed.textBody);
    expect(restored.version).toBe(reviewed.version);
  });

  it("treats whitespace-only address corrections as no-ops and changes real addresses once", () => {
    const host = contact();
    const original = adHoc([host.id]).messages[0]!;
    outbox.onContactAddressChanged(host.id, host.email, `  ${host.email}  `);
    expect(outbox.getMessage(original.id)).toEqual(original);
    outbox.onContactAddressChanged(host.id, host.email, "new@example.invalid");
    const changed = outbox.getMessage(original.id);
    expect(changed.recipients[0]).toMatchObject({
      address: "new@example.invalid",
      previousAddress: host.email,
      version: original.recipients[0]!.version + 1,
    });
    outbox.onContactAddressChanged(host.id, host.email, "new@example.invalid");
    expect(outbox.getMessage(original.id)).toEqual(changed);
  });
});
