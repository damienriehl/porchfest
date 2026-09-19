import { describe, expect, it } from "vitest";
import type { AntibotClientChallenge } from "@porchfest/core";
import {
  allValues,
  escapeHtml,
  firstValue,
  renderBooleanChoices,
  renderChallenge,
  renderChallengeScript,
  renderCheckboxGroup,
  renderField,
  renderFieldError,
  renderHostPreview,
  renderPerformerPreview,
  renderTextarea,
} from "../src/views/signup-view.js";
import { renderHostForm } from "../src/views/host-form.js";

const error = {
  field: "answer",
  label: "Answer",
  message: 'Fix <this> & "that"',
};

describe("signup field rendering and accessibility", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [0, "0"],
    [false, "false"],
    [`<&>"'`, "&lt;&amp;&gt;&quot;&#39;"],
  ])("escapes %s without dropping false or zero", (value, expected) => {
    expect(escapeHtml(value)).toBe(expected);
  });
  it("reads first and all repeated answers and handles absent or empty answers", () => {
    const values = { gear: ["pa", "water"], empty: [] };
    expect(firstValue(values, "gear")).toBe("pa");
    expect(allValues(values, "gear")).toEqual(["pa", "water"]);
    for (const key of ["missing", "empty"]) {
      expect(firstValue(values, key)).toBe("");
      expect(allValues(values, key)).toEqual([]);
    }
  });
  it("connects field errors and help and preserves explicit numeric constraints", () => {
    const html = renderField({
      id: "answer",
      name: "duration_minutes",
      label: "Duration",
      value: '45" autofocus="true',
      errors: [error],
      help: "Whole minutes",
      type: "number",
      required: true,
      autocomplete: "off",
      inputmode: "numeric",
      min: "5",
      max: "240",
      step: "1",
      audience: "organizer",
    });
    expect(html).toContain('name="duration_minutes"');
    expect(html).toContain('aria-describedby="answer-error answer-help"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('min="5" max="240" step="1"');
    expect(html).toContain('inputmode="numeric"');
    expect(html).toContain('value="45&quot; autofocus=&quot;true"');
    expect(html).toContain("Fix &lt;this&gt; &amp; &quot;that&quot;");
    expect(html).toContain('data-audience-label="Organizer-only"');
  });
  it("leaves an unrelated error off an optional field", () => {
    const html = renderField({
      id: "other",
      label: "Other",
      value: "",
      errors: [error],
    });
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("required");
    expect(html).toContain('type="text"');
    expect(renderFieldError("other", undefined)).toBe(
      '<div class="field-error-slot"></div>',
    );
  });
  it("keeps textarea contents inside the control and connects help without an error", () => {
    const html = renderTextarea({
      id: "answer",
      label: "Notes",
      value: "</textarea><script>alert(1)</script>",
      errors: [],
      help: "Keep it brief",
      required: true,
      audience: "match",
    });
    expect(html).toContain(
      "&lt;/textarea&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>",
    );
    expect(html).toContain('aria-describedby="answer-help"');
    expect(html).not.toContain("aria-invalid");
    expect(html).toContain("Shared with a confirmed match");
  });
  it.each(["yes", "no", ""])(
    "selects only the submitted boolean answer %s",
    (value) => {
      const html = renderBooleanChoices({
        id: "answer",
        label: "Power",
        value,
        errors: [error],
      });
      expect(html.match(/ checked/g) ?? []).toHaveLength(value ? 1 : 0);
      if (value) expect(html).toContain(`value="${value}" checked required`);
      expect(html).toContain("Fix &lt;this&gt;");
    },
  );
  it("selects checkbox values by exact membership and escapes choice labels", () => {
    const html = renderCheckboxGroup({
      id: "gear",
      label: "Gear",
      selected: ["pa", "unlisted"],
      choices: [
        { value: "pa", label: "PA & speaker" },
        { value: "p", label: "Other" },
      ],
      errors: [],
      help: "Choose any",
      audience: "match",
    });
    expect(html).toContain('value="pa" checked');
    expect(html).toContain('value="p"><span>Other');
    expect(html).toContain("PA &amp; speaker");
    expect(html).not.toContain('value="unlisted"');
    expect(html.match(/ checked/g)).toHaveLength(1);
  });
});

describe("preview privacy and challenge rendering", () => {
  it("renders empty previews with helpful fallback text", () => {
    expect(renderHostPreview({})).toContain("Your porch");
    const performer = renderPerformerPreview({});
    expect(performer).toContain("Your act");
    expect(performer).toContain("Keep filling in the form");
  });
  it("includes only public host answers in the preview", () => {
    const html = renderHostPreview({
      venue_title: ["<Porch>"],
      venue_address: ["Synthetic address"],
      contact_email: ["private@example.invalid"],
      notes: ["private gate instructions"],
    });
    expect(html).toContain("&lt;Porch&gt;");
    expect(html).toContain("Synthetic address");
    expect(html).not.toContain("private");
    expect(html).not.toContain("data-preview-description");
  });
  it("includes public performer description without contact or organizer notes", () => {
    const html = renderPerformerPreview({
      act_name: ["The & Notes"],
      genres: ["Jazz"],
      description: ["<Live>"],
      performer_notes: ["private transport"],
      contact_email: ["private@example.invalid"],
    });
    expect(html).toContain("The &amp; Notes");
    expect(html).toContain("&lt;Live&gt;");
    expect(html).toContain('data-preview-description-field="description"');
    expect(html).not.toContain("private");
  });
  it("omits absent challenges and scripts", () => {
    expect(renderChallenge(null, [])).toBe("");
    expect(renderChallengeScript(null)).toBe("");
  });
  it("renders the adapter descriptor and its own error with escaped attributes", () => {
    const challenge: AntibotClientChallenge = {
      scriptUrl: 'https://challenge.example.invalid/?a=1&b="2"',
      mountTag: "div",
      mountAttributes: { "data-sitekey": 'public"key' },
      responseFieldName: "answer",
      label: "Verify & continue",
      contentSecurityPolicy: { scriptSrc: [], frameSrc: [], connectSrc: [] },
    };
    const html = renderChallenge(challenge, [error]);
    expect(html).toContain('data-sitekey="public&quot;key"');
    expect(html).toContain("Verify &amp; continue");
    expect(html).toContain("Fix &lt;this&gt;");
    expect(html).toContain("<noscript>");
    expect(renderChallengeScript(challenge)).toContain(
      "?a=1&amp;b=&quot;2&quot;",
    );
    expect(renderChallengeScript({ ...challenge, scriptUrl: null })).toBe("");
  });
  it("integrates host form fields, privacy labels, and preview in the real form renderer", () => {
    const html = renderHostForm({
      seasonId: "1",
      csrfToken: "synthetic-csrf",
      challenge: null,
      values: {
        venue_title: ["Synthetic & Porch"],
        contact_email: ["synthetic@example.invalid"],
      },
      errors: [],
    });
    expect(html).toContain('name="venue_title"');
    expect(html).toContain("Synthetic &amp; Porch");
    expect(html).toContain('data-audience-label="Public map"');
    expect(html).toContain(
      'data-audience-label="Shared with a confirmed match"',
    );
  });
});
