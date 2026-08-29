import { expect } from "vitest";
import type { EmailDeliveryResult, EmailPort } from "../src/index.js";

/**
 * The behaviour every email adapter owes the outbox.
 *
 * The expected status is the caller's to state, and is asserted for equality.
 * An earlier version accepted any member of the status union, which is the
 * whole union - so an adapter that failed every delivery passed the contract,
 * including against a working server.
 */
export async function emailPortContract(
  create: () => EmailPort,
  expected: EmailDeliveryResult["status"],
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
  expect(result.status, result.reason ?? "no reason given").toBe(expected);
  if (result.status === "failed") {
    expect(result.reason?.length ?? 0).toBeGreaterThan(0);
  }
}
