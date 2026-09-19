import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AntibotClientChallenge } from "@porchfest/core";
import {
  participantAccessRefusal,
  participantHeaders,
} from "../src/participant-http.js";
import { contentSecurityPolicy } from "../src/security-headers.js";
import { createTestingRuntime } from "../src/composition.js";

const challenge: AntibotClientChallenge = {
  scriptUrl: "https://script.example.invalid/api.js",
  mountTag: "div",
  mountAttributes: {},
  responseFieldName: "token",
  label: "Verification",
  contentSecurityPolicy: {
    scriptSrc: [
      "https://script.example.invalid",
      "https://backup.example.invalid",
    ],
    frameSrc: [],
    connectSrc: ["https://verify.example.invalid"],
  },
};

describe("security policy and participant headers", () => {
  it("locks down every directive without a browser challenge", () => {
    expect(contentSecurityPolicy(null).split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "frame-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
  });
  it("keeps asymmetric adapter allowances in their own directive", () => {
    expect(contentSecurityPolicy(challenge).split("; ")).toEqual([
      "default-src 'self'",
      "script-src 'self' https://script.example.invalid https://backup.example.invalid",
      "frame-src 'self'",
      "connect-src 'self' https://verify.example.invalid",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
  });
  it("adds caller headers without mutating default headers or challenge data", () => {
    const extra = Object.freeze({
      "retry-after": "60",
      "content-type": "text/plain",
    });
    const headers = participantHeaders(challenge, extra);
    expect(headers).toMatchObject({
      "retry-after": "60",
      "content-type": "text/plain",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    });
    expect(participantHeaders(null)["content-type"]).toBe(
      "text/html; charset=UTF-8",
    );
    expect(challenge.contentSecurityPolicy.scriptSrc).toHaveLength(2);
  });
  it("constructs a private unauthorized response with the real recovery view", async () => {
    const response = participantAccessRefusal();
    expect(response.status).toBe(401);
    expect(Object.fromEntries(response.headers)).toEqual(
      participantHeaders(null),
    );
    const html = await response.text();
    expect(html).toContain("This link has expired or is no longer available.");
    expect(html).toContain('href="/self-serve/request-link"');
    expect(html).not.toContain('name="token"');
  });
  it("carries refusal security headers through a real unauthenticated HTTP route", async () => {
    const dataDirectory = await mkdtemp(
      join(tmpdir(), "porchfest-http-coverage-"),
    );
    const runtime = await createTestingRuntime({
      dataDirectory,
      env: {
        PUBLIC_BASE_URL: "https://festival.example.invalid",
        PORCHFEST_SESSION_SECRET: "synthetic-coverage-http-session",
        PORCHFEST_SMTP_HOST: "127.0.0.1",
        PORCHFEST_SMTP_FROM: "test@example.invalid",
      },
    });
    try {
      const response = await runtime.request(
        "https://festival.example.invalid/self-serve",
      );
      expect(response.status).toBe(401);
      for (const [name, value] of Object.entries(participantHeaders(null)))
        expect(response.headers.get(name)).toBe(value);
      expect(await response.text()).toContain(
        'href="/self-serve/request-link"',
      );
    } finally {
      runtime.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
