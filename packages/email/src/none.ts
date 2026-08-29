import type { EmailMessage, EmailPort } from "@porchfest/core";

/**
 * KD5/AE1: with no provider configured the platform never pretends to send.
 * The outbox reads `configured === false` and offers copy-paste/export instead,
 * so this adapter reports `skipped` rather than failing a send that was never
 * attempted — a failure would look like something to retry.
 */
export class NoneEmailAdapter implements EmailPort {
  readonly name = "none";
  readonly configured = false;

  async deliver(_message: EmailMessage) {
    return {
      status: "skipped" as const,
      reason: "No email provider is configured; use copy-paste delivery.",
    };
  }
}
