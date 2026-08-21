import { describe, expect, it } from "vitest";
import { NullAntibotAdapter } from "../src/index.js";
import { antibotPortContract } from "./contract.js";

describe("NullAntibotAdapter", () => {
  it("passes the shared anti-bot port contract", async () => {
    await antibotPortContract(() => new NullAntibotAdapter());
  });

  it("reports that no external challenge is configured", async () => {
    const adapter = new NullAntibotAdapter();
    const result = await adapter.verify({
      token: null,
      ipAddress: "127.0.0.1",
    });

    expect(adapter.configured).toBe(false);
    expect(result.status).toBe("not-configured");
  });
});
