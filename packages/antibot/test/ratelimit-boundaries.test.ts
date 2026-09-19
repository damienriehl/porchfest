import { describe, expect, it } from "vitest";
import {
  PerIpRateLimiter,
  UnconfiguredAntibotGuard,
  resolveClientIp,
} from "../src/index.js";

describe("rate limit boundaries and guard integration", () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limit %s",
    (limit) => {
      expect(() => new PerIpRateLimiter({ limit })).toThrow(RangeError);
    },
  );
  it.each([0, -1, NaN, Infinity])("rejects invalid window %s", (windowMs) => {
    expect(() => new PerIpRateLimiter({ windowMs })).toThrow(RangeError);
  });
  it("expires only the oldest attempt at the exact rolling boundary", () => {
    let now = 0;
    const limiter = new PerIpRateLimiter({
      limit: 2,
      windowMs: 100,
      now: () => now,
    });
    expect(limiter.consume("a").allowed).toBe(true);
    now = 40;
    expect(limiter.consume("a").remaining).toBe(0);
    now = 99;
    expect(limiter.consume("a")).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1,
    });
    now = 100;
    expect(limiter.consume("a")).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    expect(limiter.consume("a")).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 40,
    });
  });
  it("evicts inactive addresses while retaining an address with a recent attempt", () => {
    let now = 0;
    const limiter = new PerIpRateLimiter({ windowMs: 100, now: () => now });
    limiter.consume("old");
    limiter.consume("active");
    now = 50;
    limiter.consume("active");
    now = 100;
    limiter.consume("new");
    expect(limiter.trackedAddresses).toBe(2);
    now = 200;
    limiter.consume("newest");
    expect(limiter.trackedAddresses).toBe(1);
  });
  it("resolves repeated proxy headers and shares the budget across split and combined guard entrypoints", () => {
    let now = 0;
    const guard = new UnconfiguredAntibotGuard({
      trustedProxyHops: 2,
      limit: 2,
      windowMs: 100,
      now: () => now,
    });
    const request = {
      socketPeerAddress: " proxy ",
      forwardedFor: ["spoof, client ,", " edge "],
    };
    expect(guard.resolveAddress(request)).toBe("client");
    expect(guard.resolveAddress(request)).toBe("client");
    expect(guard.consumeAttempt(request)).toEqual({
      ipAddress: "client",
      decision: { allowed: true, remaining: 1, retryAfterMs: 0 },
    });
    expect(guard.checkHoneypot(" \t\n")).toBe(true);
    expect(guard.check({ ...request, honeypot: "bot" })).toMatchObject({
      status: "failed",
      code: "honeypot",
      remaining: 0,
    });
    expect(guard.check(request)).toMatchObject({
      status: "failed",
      code: "rate-limited",
      retryAfterMs: 100,
    });
    now = 100;
    expect(guard.check(request)).toMatchObject({
      status: "passed",
      remaining: 1,
    });
  });
  it("groups missing socket peers even when forwarded headers claim distinct clients", () => {
    const guard = new UnconfiguredAntibotGuard({
      trustedProxyHops: 1,
      limit: 1,
    });
    expect(
      guard.check({ socketPeerAddress: " ", forwardedFor: "a" }).status,
    ).toBe("passed");
    expect(
      guard.check({ socketPeerAddress: null, forwardedFor: "b" }),
    ).toMatchObject({ code: "rate-limited", ipAddress: "unknown" });
  });
  it("ignores empty forwarded fragments and falls back when too few remain", () => {
    expect(
      resolveClientIp({
        socketPeerAddress: " peer ",
        trustedProxyHops: 2,
        forwardedFor: [", ,", "client,"],
      }),
    ).toBe("peer");
  });
});
