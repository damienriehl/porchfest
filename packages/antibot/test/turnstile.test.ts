import { describe, expect, it, vi } from "vitest";
import {
  InMemorySingleUseTokenStore,
  TurnstileAntibotAdapter,
  type SingleUseTokenStore,
} from "../src/index.js";
import { antibotPortContract } from "./contract.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TurnstileAntibotAdapter", () => {
  it("passes the shared anti-bot port contract", async () => {
    await antibotPortContract(
      () =>
        new TurnstileAntibotAdapter({
          secretKey: "test-secret",
          fetcher: async () => jsonResponse({ success: false }),
        }),
    );
  });

  it("passes a valid challenge through the siteverify endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ success: true }),
    );
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher,
      createId: () => "server-generated-id",
    });

    await expect(
      adapter.verify({ token: "valid-token", ipAddress: "203.0.113.7" }),
    ).resolves.toEqual({ status: "passed" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(init?.body).toBeInstanceOf(URLSearchParams);
    expect((init?.body as URLSearchParams).toString()).toBe(
      "secret=test-secret&response=valid-token&remoteip=203.0.113.7&idempotency_key=server-generated-id",
    );
  });

  it("returns failed when Turnstile rejects a challenge", async () => {
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher: async () =>
        jsonResponse({
          success: false,
          "error-codes": ["invalid-input-response"],
        }),
    });

    await expect(
      adapter.verify({ token: "bad-token", ipAddress: "203.0.113.7" }),
    ).resolves.toEqual({
      status: "failed",
      reason: "Turnstile rejected the challenge: invalid-input-response.",
    });
  });

  it("fails a missing challenge without calling Turnstile", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher,
    });

    await expect(
      adapter.verify({ token: null, ipAddress: "203.0.113.7" }),
    ).resolves.toEqual({
      status: "failed",
      reason: "A Turnstile challenge token is required.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["transport error", async () => Promise.reject(new Error("offline"))],
    ["non-2xx response", async () => jsonResponse({}, 503)],
    ["malformed JSON", async () => new Response("not-json")],
    ["malformed body", async () => jsonResponse({ success: "yes" })],
  ])("maps a %s to unavailable", async (_label, fetcher) => {
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher,
    });

    const result = await adapter.verify({
      token: `token-${_label}`,
      ipAddress: "203.0.113.7",
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("times out an unreachable configured challenge and returns unavailable", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new TurnstileAntibotAdapter({
        secretKey: "test-secret",
        timeoutMs: 50,
        fetcher: () => new Promise(() => undefined),
      });

      const pending = adapter.verify({
        token: "slow-token",
        ipAddress: "203.0.113.7",
      });
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({
        status: "unavailable",
        reason: "Turnstile verification timed out.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores only a hash and refuses a replay before a second provider call", async () => {
    const claims: string[] = [];
    const claimed = new Set<string>();
    const replayStore: SingleUseTokenStore = {
      claim: async (tokenHash) => {
        claims.push(tokenHash);
        if (claimed.has(tokenHash)) return false;
        claimed.add(tokenHash);
        return true;
      },
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ success: true }),
    );
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher,
      replayStore,
    });

    await expect(
      adapter.verify({ token: "one-time-token", ipAddress: "203.0.113.7" }),
    ).resolves.toEqual({ status: "passed" });
    await expect(
      adapter.verify({ token: "one-time-token", ipAddress: "203.0.113.7" }),
    ).resolves.toEqual({
      status: "failed",
      reason: "This Turnstile challenge token has already been used.",
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(claims[0]).not.toContain("one-time-token");
  });

  it("atomically refuses a concurrent replay", async () => {
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      await providerReleased;
      return jsonResponse({ success: true });
    });
    const adapter = new TurnstileAntibotAdapter({
      secretKey: "test-secret",
      fetcher,
      replayStore: new InMemorySingleUseTokenStore(),
    });

    const first = adapter.verify({
      token: "concurrent-token",
      ipAddress: "203.0.113.7",
    });
    const second = adapter.verify({
      token: "concurrent-token",
      ipAddress: "203.0.113.7",
    });

    await expect(second).resolves.toMatchObject({ status: "failed" });
    releaseProvider();
    await expect(first).resolves.toEqual({ status: "passed" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
