import { describe, expect, it } from "vitest";
import { NullEmailAdapter } from "../src/none.js";
import { emailPortContract } from "./contract.js";

describe("NullEmailAdapter", () => {
  it("passes the shared email port contract", async () => {
    await emailPortContract(() => new NullEmailAdapter());
  });

  it("reports copy-paste mode without sending", async () => {
    const adapter = new NullEmailAdapter();
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
    expect(entry.NullEmailAdapter).toBe(NullEmailAdapter);
  });
});
