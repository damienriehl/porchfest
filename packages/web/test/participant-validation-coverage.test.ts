import { describe, expect, it } from "vitest";
import {
  enforceParticipantFieldLengths,
  parseSetDurationMinutes,
  CONTACT_EMAIL_PATTERN,
} from "../src/participant-validation.js";
import { renderTextarea, firstValue } from "../src/views/signup-view.js";

describe("participant answer boundaries", () => {
  it.each([
    ["contact_name", 200],
    ["contact_email", 320],
    ["contact_phone", 60],
    ["venue_title", 200],
    ["venue_address", 300],
    ["space_description", 4000],
    ["requested_act_names", 2000],
    ["genre_preferences", 2000],
    ["notes", 4000],
    ["participant_notes", 4000],
    ["act_name", 200],
    ["genres", 300],
    ["description", 4000],
    ["links", 2000],
    ["house_preference", 2000],
    ["shared_member_note", 2000],
    ["performer_notes", 4000],
    ["duration_minutes", 10],
    ["season_id", 20],
    ["antibot_token", 4096],
    ["unknown_answer", 300],
  ] as const)(
    "accepts the exact limit and rejects the next character for %s",
    (field, limit) => {
      const values = { [field]: ["a".repeat(limit)] };
      expect(enforceParticipantFieldLengths(values)).toEqual({
        ok: true,
        values,
      });
      const result = enforceParticipantFieldLengths({
        [field]: ["short", "a".repeat(limit + 1)],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({
          field,
          label: "Submission",
          message: `Shorten this answer to ${limit} characters or fewer.`,
        });
        expect(Object.hasOwn(result.values, field)).toBe(false);
      }
    },
  );

  it("keeps empty arrays, empty values, and the original successful input", () => {
    const values = Object.freeze({
      notes: Object.freeze([]),
      contact_name: Object.freeze([""]),
    });
    expect(enforceParticipantFieldLengths(values)).toEqual({
      ok: true,
      values,
    });
    expect(enforceParticipantFieldLengths(values).values).toBe(values);
    expect(enforceParticipantFieldLengths({})).toEqual({
      ok: true,
      values: {},
    });
  });

  it("renders a real correction field without reflecting an oversized answer", () => {
    const original = {
      notes: ["</textarea><script>".repeat(300)],
      contact_name: ["Preserved"],
    };
    const result = enforceParticipantFieldLengths(original);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected rejected answer");
    const html = renderTextarea({
      id: "notes",
      label: "Notes",
      value: firstValue(result.values, "notes"),
      errors: [result.error],
    });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="notes-error"');
    expect(html).toContain("Shorten this answer to 4000 characters or fewer.");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&lt;script&gt;");
    expect(result.values.contact_name).toEqual(["Preserved"]);
    expect(original.notes[0]).toContain("<script>");
    expect(Object.getPrototypeOf(result.values)).toBeNull();
  });
});

describe("set duration and email parsing", () => {
  it.each(["5", "240", " 45 ", "45.0"])(
    "accepts integral duration %s",
    (raw) => {
      expect(parseSetDurationMinutes(raw)).toBe(Number(raw));
    },
  );
  it.each([
    "",
    " ",
    "4",
    "241",
    "-1",
    "5.5",
    "NaN",
    "Infinity",
    "45 minutes",
    "9007199254740992",
  ])("rejects invalid duration %s", (raw) => {
    expect(parseSetDurationMinutes(raw)).toBeNull();
  });
  it.each(["person@example.invalid", "person+music@sub.example.invalid"])(
    "accepts an ordinary address %s",
    (value) => {
      expect(CONTACT_EMAIL_PATTERN.test(value)).toBe(true);
    },
  );
  it.each([
    "",
    "person@example",
    "@example.invalid",
    "person@@example.invalid",
    " person@example.invalid",
    "person@example.invalid\n",
  ])("rejects malformed address %s", (value) => {
    expect(CONTACT_EMAIL_PATTERN.test(value)).toBe(false);
  });
});
