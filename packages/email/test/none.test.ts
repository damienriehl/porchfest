import { describe, expect, it } from "vitest";
import { NoneEmailAdapter } from "../src/none.js";
import { emailPortContract } from "./contract.js";

describe("NoneEmailAdapter", () => {
  it("passes the shared email port contract", async () => {
    await emailPortContract(() => new NoneEmailAdapter(), "skipped");
  });

  it("reports copy-paste mode without sending", async () => {
    const adapter = new NoneEmailAdapter();
    const result = await adapter.deliver({
      recipients: [],
      subject: "",
      html: "",
      text: "",
    });

    expect(adapter.configured).toBe(false);
    expect(result.status).toBe("skipped");
  });

  it("is re-exported from the package entry point", async () => {
    const entry = await import("../src/index.js");
    expect(entry.NoneEmailAdapter).toBe(NoneEmailAdapter);
  });
});
