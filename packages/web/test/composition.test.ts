import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmailMessage, EmailPort } from "@porchfest/core";
import { createRuntime } from "../src/composition.js";

class RecordingEmailAdapter implements EmailPort {
  readonly name = "recording-test-adapter";
  readonly configured = true;
  readonly deliveries: EmailMessage[] = [];

  async deliver(message: EmailMessage) {
    this.deliveries.push(message);
    return { status: "sent" as const, providerMessageId: "recorded" };
  }
}

describe("web composition root", () => {
  it("substitutes an adapter implementation without changing core", async () => {
    const email = new RecordingEmailAdapter();
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-composition-"),
    );
    const runtime = await createRuntime({
      env: {},
      dataDirectory,
      adapterOverrides: { email },
    });

    expect(runtime.adapters.email).toBe(email);
    expect(runtime.core.ports.email).toBe(email);
    expect(runtime.adapters.antibot.configured).toBe(false);
    expect(runtime.adapters.geo.configured).toBe(false);
  });
});
