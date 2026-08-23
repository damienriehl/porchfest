import { describe, expect, it } from "vitest";
import {
  PerIpRateLimiter,
  UnconfiguredAntibotGuard,
  resolveClientIp,
} from "../src/index.js";

describe("resolveClientIp", () => {
  it("ignores a spoofed X-Forwarded-For value when proxy trust is unset", () => {
    expect(
      resolveClientIp({
        socketPeerAddress: "192.0.2.10",
        forwardedFor: "198.51.100.1",
      }),
    ).toBe("192.0.2.10");
  });

  it("selects the client before the configured number of trusted proxies", () => {
    expect(
      resolveClientIp({
        socketPeerAddress: "10.0.0.3",
        forwardedFor: "198.51.100.8, 10.0.0.2",
        trustedProxyHops: 2,
      }),
    ).toBe("198.51.100.8");
  });

  it("falls back to the peer when the forwarded chain is too short", () => {
    expect(
      resolveClientIp({
        socketPeerAddress: "10.0.0.3",
        forwardedFor: "198.51.100.8",
        trustedProxyHops: 2,
      }),
    ).toBe("10.0.0.3");
  });

  it("uses a shared unknown key when no peer address is available", () => {
    expect(
      resolveClientIp({
        socketPeerAddress: null,
        forwardedFor: "198.51.100.8",
        trustedProxyHops: 1,
      }),
    ).toBe("unknown");
  });

  it("refuses an invalid trusted-proxy hop count", () => {
    expect(() =>
      resolveClientIp({
        socketPeerAddress: "10.0.0.3",
        trustedProxyHops: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe("PerIpRateLimiter", () => {
  it("limits a burst from one IP while leaving another IP independent", () => {
    let now = 1_000;
    const limiter = new PerIpRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.consume("192.0.2.1")).toMatchObject({ allowed: true });
    expect(limiter.consume("192.0.2.1")).toMatchObject({ allowed: true });
    expect(limiter.consume("192.0.2.1")).toMatchObject({
      allowed: false,
      retryAfterMs: 1_000,
    });
    expect(limiter.consume("192.0.2.2")).toMatchObject({ allowed: true });

    now += 1_000;
    expect(limiter.consume("192.0.2.1")).toMatchObject({ allowed: true });
  });
});

describe("UnconfiguredAntibotGuard", () => {
  it("rate-limits repeated clean submissions even with no external adapter", () => {
    const guard = new UnconfiguredAntibotGuard({ limit: 2 });
    const request = {
      socketPeerAddress: "192.0.2.10",
      forwardedFor: null,
      honeypot: "",
    };

    expect(guard.check(request)).toMatchObject({ status: "passed" });
    expect(guard.check(request)).toMatchObject({ status: "passed" });
    expect(guard.check(request)).toMatchObject({
      status: "failed",
      code: "rate-limited",
    });
  });

  it("does not let a spoofed forwarded address reset the cap", () => {
    const guard = new UnconfiguredAntibotGuard({ limit: 1 });

    expect(
      guard.check({
        socketPeerAddress: "192.0.2.10",
        forwardedFor: "198.51.100.1",
        honeypot: "",
      }),
    ).toMatchObject({ status: "passed", ipAddress: "192.0.2.10" });
    expect(
      guard.check({
        socketPeerAddress: "192.0.2.10",
        forwardedFor: "198.51.100.2",
        honeypot: "",
      }),
    ).toMatchObject({ status: "failed", code: "rate-limited" });
  });

  it("refuses a filled honeypot", () => {
    const guard = new UnconfiguredAntibotGuard();

    expect(
      guard.check({
        socketPeerAddress: "192.0.2.10",
        honeypot: "I am a bot",
      }),
    ).toEqual({
      status: "failed",
      code: "honeypot",
      reason: "The anti-bot honeypot field was filled.",
      ipAddress: "192.0.2.10",
      remaining: 4,
      retryAfterMs: 0,
    });
  });

  it("uses the configured trusted-proxy hop count in the real guard chain", () => {
    const guard = new UnconfiguredAntibotGuard({
      limit: 1,
      trustedProxyHops: 1,
    });

    expect(
      guard.check({
        socketPeerAddress: "10.0.0.3",
        forwardedFor: "198.51.100.1",
        honeypot: "",
      }),
    ).toMatchObject({ status: "passed", ipAddress: "198.51.100.1" });
    expect(
      guard.check({
        socketPeerAddress: "10.0.0.3",
        forwardedFor: "198.51.100.2",
        honeypot: "",
      }),
    ).toMatchObject({ status: "passed", ipAddress: "198.51.100.2" });
  });
});
