import { describe, expect, it } from "vitest";
import { NullEmailAdapter } from "../src/index.js";
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
});
