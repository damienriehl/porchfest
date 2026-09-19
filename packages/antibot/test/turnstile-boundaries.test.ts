import { describe, expect, it } from "vitest";
import {
  InMemorySingleUseTokenStore,
  TurnstileAntibotAdapter,
} from "../src/index.js";

const keys = { secretKey: "synthetic-secret", siteKey: "synthetic-public" };
const request = { token: "synthetic-token", ipAddress: "192.0.2.1" };

describe("Turnstile validation and replay lifecycle", () => {
  it.each(
    [
      null,
      [],
      true,
      {},
      { success: null },
      { success: true, "error-codes": null },
      { success: false, "error-codes": [1] },
    ].map((body) => ({ body })),
  )("rejects malformed provider JSON $body", async ({ body }) => {
    const adapter = new TurnstileAntibotAdapter({
      ...keys,
      fetcher: async () => Response.json(body),
    });
    expect(await adapter.verify(request)).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("malformed"),
    });
  });
  it.each([{ codes: undefined }, { codes: [] }])(
    "formats a rejection with no provider error details (%j)",
    async ({ codes }) => {
      const adapter = new TurnstileAntibotAdapter({
        ...keys,
        fetcher: async () =>
          Response.json({ success: false, "error-codes": codes }),
      });
      expect(await adapter.verify(request)).toEqual({
        status: "failed",
        reason: "Turnstile rejected the challenge.",
      });
    },
  );
  it.each(["secretKey", "siteKey"] as const)("rejects a blank %s", (field) => {
    expect(
      () => new TurnstileAntibotAdapter({ ...keys, [field]: " \n" }),
    ).toThrow(TypeError);
  });
  it.each([0, -1, NaN, Infinity])(
    "rejects invalid time budget %s for both timers",
    (value) => {
      expect(
        () => new TurnstileAntibotAdapter({ ...keys, timeoutMs: value }),
      ).toThrow(RangeError);
      expect(
        () => new TurnstileAntibotAdapter({ ...keys, replayTtlMs: value }),
      ).toThrow(RangeError);
    },
  );
  it("shares actual replay storage across adapters and releases claims at the exact TTL boundary", async () => {
    let now = 100;
    let calls = 0;
    const store = new InMemorySingleUseTokenStore(() => now);
    const options = {
      ...keys,
      now: () => now,
      replayStore: store,
      replayTtlMs: 50,
      fetcher: async () => {
        calls++;
        return Response.json({ success: true });
      },
    };
    const first = new TurnstileAntibotAdapter(options);
    const second = new TurnstileAntibotAdapter(options);
    expect(await first.verify(request)).toEqual({ status: "passed" });
    now = 149;
    expect(
      await second.verify({ ...request, ipAddress: "192.0.2.2" }),
    ).toMatchObject({ status: "failed" });
    expect(calls).toBe(1);
    now = 150;
    expect(await second.verify(request)).toEqual({ status: "passed" });
    expect(calls).toBe(2);
  });
  it("consumes a token even when the provider is unavailable, without blocking unrelated tokens", async () => {
    let calls = 0;
    const adapter = new TurnstileAntibotAdapter({
      ...keys,
      fetcher: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
    });
    expect((await adapter.verify(request)).status).toBe("unavailable");
    expect((await adapter.verify(request)).status).toBe("failed");
    expect((await adapter.verify({ ...request, token: "other" })).status).toBe(
      "unavailable",
    );
    expect(calls).toBe(2);
  });
  it("rejects whitespace-only tokens before claiming them", async () => {
    const store = new InMemorySingleUseTokenStore();
    const adapter = new TurnstileAntibotAdapter({
      ...keys,
      replayStore: store,
      fetcher: async () => {
        throw new Error("provider must not be reached");
      },
    });
    expect(await adapter.verify({ ...request, token: " \t\n" })).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("required"),
    });
  });
  it("exposes only trimmed public configuration in deeply frozen browser challenge metadata", () => {
    const adapter = new TurnstileAntibotAdapter({
      ...keys,
      siteKey: " public-key ",
    });
    expect(adapter.clientChallenge.mountAttributes["data-sitekey"]).toBe(
      "public-key",
    );
    expect(JSON.stringify(adapter.clientChallenge)).not.toContain(
      keys.secretKey,
    );
    expect(Object.isFrozen(adapter.clientChallenge)).toBe(true);
    expect(Object.isFrozen(adapter.clientChallenge.mountAttributes)).toBe(true);
    expect(Object.isFrozen(adapter.clientChallenge.contentSecurityPolicy)).toBe(
      true,
    );
    expect(
      Object.isFrozen(adapter.clientChallenge.contentSecurityPolicy.scriptSrc),
    ).toBe(true);
  });
});
