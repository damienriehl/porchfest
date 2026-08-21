import { expect } from "vitest";
import type { EmailPort } from "../src/index.js";

export async function emailPortContract(
  create: () => EmailPort,
): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe("boolean");

  const result = await adapter.deliver({
    recipients: ["contract-recipient"],
    subject: "Contract subject",
    html: "<p>Contract body</p>",
    text: "Contract body",
  });

  expect(["sent", "skipped"]).toContain(result.status);
}
