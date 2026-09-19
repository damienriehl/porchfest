import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  parseOriginalSubmission,
  serializeOriginalSubmission,
} from "../src/original-submission.js";
import { createSeasonSetup } from "../src/setup.js";
import { createSeasonRepository } from "../src/season.js";
import { contacts } from "../src/storage/schema.js";
import { openTestDatabase } from "./support/db.js";

describe("snapshot decoding boundaries", () => {
  it.each([
    null,
    "",
    "{",
    "null",
    "[]",
    "true",
    "1",
    '"snapshot"',
    '{"version":1}',
    '{"version":"1","values":{}}',
    '{"version":1,"values":null}',
    '{"version":1,"values":[]}',
    '{"version":1,"values":{"items":[]}}',
  ])("rejects invalid snapshot %s", (value) => {
    expect(parseOriginalSubmission(value)).toBeNull();
  });
  it("retains empty and false values, special keys, and escaped Unicode text", () => {
    const values = {
      ["__proto__"]: "ordinary value",
      constructor: "text",
      empty: "",
      zero: 0,
      false: false,
      text: '♫\n"porch"',
    };
    expect(
      parseOriginalSubmission(serializeOriginalSubmission(values)),
    ).toEqual(values);
    expect(parseOriginalSubmission(serializeOriginalSubmission({}))).toEqual(
      {},
    );
  });
  it("reads the original signup from SQLite after organizer edits change the current contact", async () => {
    const database = await openTestDatabase("snapshot-boundary-");
    try {
      const now = () => new Date("2030-01-01T00:00:00Z");
      const { season } = createSeasonSetup(database.db, now).createSeason({
        year: 2030,
        displayName: "Snapshot",
        timezone: "UTC",
        eventDate: "2030-09-01",
        eventCity: "Example",
        eventState: "WI",
        timeSlots: [],
        openSignups: true,
      });
      const repo = createSeasonRepository(database.db, { now });
      const signup = repo.createHostSignup({
        seasonId: season.id,
        contact: { name: "Original ♫", email: "original@example.invalid" },
        venue: {
          title: "Porch",
          address: "101 Example",
          spaceDescription: "",
          hasPower: false,
          rainBackup: false,
          notes: null,
        },
        gear: [],
        drinks: [],
        amenities: [],
      });
      repo.updateContact(signup.contact.id, signup.contact.version, {
        name: "Edited",
      });
      const persisted = database.db
        .select()
        .from(contacts)
        .where(eq(contacts.id, signup.contact.id))
        .get()!;
      expect(persisted.name).toBe("Edited");
      expect(parseOriginalSubmission(persisted.originalSubmission)).toEqual({
        name: "Original ♫",
        email: "original@example.invalid",
        phone: null,
      });
      expect(
        parseOriginalSubmission(signup.venue.originalSubmission),
      ).toMatchObject({ hasPower: false, notes: null });
    } finally {
      await database.close();
    }
  });
});
