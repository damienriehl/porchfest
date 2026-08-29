import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmailMessage, EmailPort } from "@porchfest/core";
import { SmtpEmailAdapter } from "@porchfest/email";
import { createAdapterSet, createRuntime } from "../src/composition.js";

const SMTP_HOST = "smtp.porchfest.example.invalid";
const SMTP_FROM = "Porchfest <organizers@porchfest.example.invalid>";

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
    runtime.close();
  });

  it.each([
    [{}, 24],
    [{ PORCHFEST_RETENTION_MONTHS: "invalid" }, 24],
    [{ PORCHFEST_RETENTION_MONTHS: "0" }, 24],
    [{ PORCHFEST_RETENTION_MONTHS: "18" }, 18],
  ])(
    "configures retention from the deployment environment",
    async (env, expected) => {
      const dataDirectory = await mkdtemp(
        join(tmpdir(), "porchfest-retention-composition-"),
      );
      const runtime = await createRuntime({ env, dataDirectory });

      expect(runtime.core.retention.retentionMonths).toBe(expected);
      runtime.close();
    },
  );
});

describe("email provider selection", () => {
  it("runs the copy-paste adapter when no SMTP variable is set", () => {
    const adapters = createAdapterSet(
      {},
      { PORCHFEST_TURNSTILE_SITE_KEY: undefined },
    );

    expect(adapters.email.name).toBe("none");
    expect(adapters.email.configured).toBe(false);
  });

  it("selects SMTP on port 587 when only host and from are configured", () => {
    const adapters = createAdapterSet(
      {},
      { PORCHFEST_SMTP_HOST: SMTP_HOST, PORCHFEST_SMTP_FROM: SMTP_FROM },
    );
    const email = adapters.email;

    expect(email.name).toBe("smtp");
    expect(email.configured).toBe(true);
    expect(email).toBeInstanceOf(SmtpEmailAdapter);
    if (!(email instanceof SmtpEmailAdapter)) return;
    expect(email.endpoint).toBe(`${SMTP_HOST}:587`);
    expect(email.authenticated).toBe(false);
  });

  it("honors an explicit port and implicit TLS", () => {
    const adapters = createAdapterSet(
      {},
      {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
        PORCHFEST_SMTP_PORT: "465",
        PORCHFEST_SMTP_SECURE: "true",
        PORCHFEST_SMTP_STARTTLS: "false",
        PORCHFEST_SMTP_USERNAME: "outbox-sender",
        PORCHFEST_SMTP_PASSWORD: "configured-in-the-environment",
      },
    );
    const email = adapters.email;

    expect(email).toBeInstanceOf(SmtpEmailAdapter);
    if (!(email instanceof SmtpEmailAdapter)) return;
    expect(email.endpoint).toBe(`${SMTP_HOST}:465`);
    expect(email.authenticated).toBe(true);
  });

  it("reads the password from a mounted file, never from the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "porchfest-smtp-secret-"));
    const passwordFile = join(directory, "smtp-password");
    await writeFile(passwordFile, "mounted-secret-value\n", { mode: 0o600 });

    const adapters = createAdapterSet(
      {},
      {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
        PORCHFEST_SMTP_USERNAME: "outbox-sender",
        PORCHFEST_SMTP_PASSWORD_FILE: passwordFile,
      },
    );
    const email = adapters.email;

    expect(email).toBeInstanceOf(SmtpEmailAdapter);
    if (!(email instanceof SmtpEmailAdapter)) return;
    expect(email.authenticated).toBe(true);
    // KTD15: the credential is never surfaced by the adapter it configured.
    expect(JSON.stringify(email)).not.toContain("mounted-secret-value");
  });

  it.each([
    [{ PORCHFEST_SMTP_HOST: SMTP_HOST }, "PORCHFEST_SMTP_FROM"],
    [{ PORCHFEST_SMTP_FROM: SMTP_FROM }, "PORCHFEST_SMTP_HOST"],
    [{ PORCHFEST_SMTP_PORT: "587" }, "PORCHFEST_SMTP_HOST"],
    [
      {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
        PORCHFEST_SMTP_USERNAME: "outbox-sender",
      },
      "PORCHFEST_SMTP_PASSWORD",
    ],
    [
      {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
        PORCHFEST_SMTP_PASSWORD: "configured-in-the-environment",
      },
      "PORCHFEST_SMTP_USERNAME",
    ],
    [
      {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
        PORCHFEST_SMTP_PASSWORD_FILE: "/nonexistent/porchfest-smtp-password",
      },
      "PORCHFEST_SMTP_USERNAME",
    ],
  ])(
    "refuses to boot a half-configured provider instead of silently not sending",
    (env, missing) => {
      expect(() => createAdapterSet({}, env)).toThrow(TypeError);
      expect(() => createAdapterSet({}, env)).toThrow(missing);
    },
  );

  it("rejects a from value that is not a plausible address", () => {
    expect(() =>
      createAdapterSet(
        {},
        {
          PORCHFEST_SMTP_HOST: SMTP_HOST,
          PORCHFEST_SMTP_FROM: "Porchfest Organizers",
        },
      ),
    ).toThrow("PORCHFEST_SMTP_FROM");
  });

  it("rejects a port that is not a TCP port number", () => {
    expect(() =>
      createAdapterSet(
        {},
        {
          PORCHFEST_SMTP_HOST: SMTP_HOST,
          PORCHFEST_SMTP_FROM: SMTP_FROM,
          PORCHFEST_SMTP_PORT: "not-a-port",
        },
      ),
    ).toThrow("PORCHFEST_SMTP_PORT");
  });

  it("boots the runtime with the SMTP adapter the environment selected", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-smtp-boot-"));
    const runtime = await createRuntime({
      dataDirectory,
      env: {
        PORCHFEST_SMTP_HOST: SMTP_HOST,
        PORCHFEST_SMTP_FROM: SMTP_FROM,
      },
    });

    expect(runtime.adapters.email.name).toBe("smtp");
    expect(runtime.core.ports.email).toBe(runtime.adapters.email);
    runtime.close();
  });
});
