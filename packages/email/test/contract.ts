import { expect } from "vitest";
import type { EmailPort } from "../src/index.js";

export async function emailPortContract(
  create: () => EmailPort,
): Promise<void> {
  const adapter = create();
  expect(adapter.name.length).toBeGreaterThan(0);
  expect(typeof adapter.configured).toBe("boolean");

  const result = await adapter.deliver({
    recipients: ["contract-recipient@porchfest.example.invalid"],
    subject: "Contract subject",
    html: "<p>Contract body</p>",
    text: "Contract body",
  });

  // R12/KTD6: an adapter reports an outcome, it never throws at the outbox. A
  // provider that is unreachable must surface as `failed` with a reason so the
  // outbox can leave the recipient unsent, not as an exception that loses the
  // send state entirely.
  expect(["sent", "skipped", "failed"]).toContain(result.status);
  if (result.status === "failed") {
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
  }
}
