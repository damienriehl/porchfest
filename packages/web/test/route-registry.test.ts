import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { RouteRegistry } from "../src/router/registry.js";
import { renderSignInPage } from "../src/views/admin-shell.js";

describe("central route registry", () => {
  it("renders a tokenless sign-in refusal's actual error", () => {
    const html = renderSignInPage({
      token: "",
      csrfToken: "synthetic-csrf",
      needsEmail: false,
      errors: ["That sign-in link is incomplete."],
    });

    expect(html).toContain("That sign-in link is incomplete.");
    expect(html).toContain('role="alert"');
  });

  it("refuses a route with no trust tier and leaves it unreachable", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);

    expect(() =>
      routes.register({
        method: "GET",
        path: "/missing-tier",
        handler: () => new Response("should never run"),
      }),
    ).toThrow(/missing or unknown trust tier/i);

    expect((await app.request("/missing-tier")).status).toBe(404);
  });

  it("refuses an unknown trust tier and leaves it unreachable", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);

    expect(() =>
      routes.register({
        method: "GET",
        path: "/unknown-tier",
        tier: "trusted-somehow",
        handler: () => new Response("should never run"),
      }),
    ).toThrow(/missing or unknown trust tier/i);

    expect((await app.request("/unknown-tier")).status).toBe(404);
  });

  it("denies protected tiers until an authorizer grants access", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);
    routes.register({
      method: "GET",
      path: "/organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/organizer");

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("keeps an HTML organizer GET on JSON 401 when no sign-in path is configured", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);
    routes.register({
      method: "GET",
      path: "/organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/organizer", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("redirects an organizer HTML GET without depending on mutation protection", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      undefined,
      undefined,
      {},
      {
        signInPath: "/organizer-sign-in",
      },
    );
    routes.register({
      method: "GET",
      path: "/organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/organizer", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/organizer-sign-in");
  });

  it("never redirects the organizer sign-in destination to itself", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      undefined,
      undefined,
      {},
      {
        signInPath: "/organizer-sign-in",
      },
    );
    routes.register({
      method: "GET",
      path: "/organizer-sign-in",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/organizer-sign-in", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("explains an unauthorized organizer HTML mutation without redirecting", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      undefined,
      undefined,
      {},
      {
        signInPath: "/organizer-sign-in",
      },
    );
    routes.register({
      method: "POST",
      path: "/organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/organizer", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    const html = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('href="/organizer-sign-in"');
    expect(html).toContain("Your changes were not submitted");
  });

  it("lets a defensive organizer GET check reuse the registry HTML refusal", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      () => true,
      undefined,
      {},
      {
        signInPath: "/organizer-sign-in",
      },
    );
    routes.register({
      method: "GET",
      path: "/organizer/record",
      tier: "organizer",
      handler: (context: Context) => routes.organizerGetRefusal(context),
    });

    const response = await app.request("/organizer/record?season=synthetic", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/organizer-sign-in");
  });

  it("explains how an unauthenticated participant can request a fresh link", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(
      app,
      undefined,
      {
        allowedOrigin: null,
        validateCsrf: () => true,
      },
      {},
      { signInPath: "/organizer-sign-in" },
    );
    routes.register({
      method: "GET",
      path: "/participant",
      tier: "participant",
      handler: (context: Context) => context.text("participant"),
    });

    const response = await app.request("/participant", {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.text()).toContain("/self-serve/request-link");
  });

  it("snapshots a declaration so caller mutations cannot remove protection", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);
    const declaration: Record<string, unknown> = {
      method: "GET",
      path: "/protected-snapshot",
      tier: "organizer",
      handler: (context: { text: (body: string) => Response }) =>
        context.text("organizer"),
    };

    const registered = routes.register(declaration);
    declaration.tier = "public";
    declaration.handler = () => new Response("replacement");

    expect(registered).not.toBe(declaration);
    expect(Object.isFrozen(registered)).toBe(true);
    expect((await app.request("/protected-snapshot")).status).toBe(401);
  });

  it("returns frozen declarations so registry consumers cannot remove protection", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app);
    routes.register({
      method: "GET",
      path: "/listed-protected-route",
      tier: "participant",
      handler: (context: Context) => context.text("participant"),
    });

    const listed = routes.list()[0];
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listed as { tier: string }).tier = "public";
    }).toThrow(TypeError);
    expect((await app.request("/listed-protected-route")).status).toBe(401);
  });

  it("runs an organizer route when the authorizer grants that tier", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, (tier) => tier === "organizer");
    routes.register({
      method: "GET",
      path: "/authorized-organizer",
      tier: "organizer",
      handler: (context: Context) => context.text("organizer"),
    });

    const response = await app.request("/authorized-organizer");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("organizer");
  });

  it("refuses a request whose host does not match the configured origin", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: () => true,
    });
    routes.register({
      method: "GET",
      path: "/public-page",
      tier: "public",
      handler: (context: Context) => context.text("public"),
    });

    const response = await app.request(
      "https://unrecognized.example/public-page",
    );

    expect(response.status).toBe(421);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("centrally refuses a mutation from the wrong origin", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: (token) => token === "valid-token",
    });
    routes.register({
      method: "POST",
      path: "/public-mutation",
      tier: "public",
      handler: (context: Context) => context.text("mutated"),
    });

    const response = await app.request(
      "https://porchfest.example/public-mutation",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://marketing.example",
        },
        body: new URLSearchParams({ _csrf: "valid-token" }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("centrally refuses a mutation without its form CSRF token", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: (token) => token === "valid-token",
    });
    routes.register({
      method: "POST",
      path: "/public-mutation",
      tier: "public",
      handler: (context: Context) => context.text("mutated"),
    });

    const response = await app.request(
      "https://porchfest.example/public-mutation",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://porchfest.example",
        },
        body: new URLSearchParams(),
      },
    );

    expect(response.status).toBe(403);
  });

  it("centrally refuses a simple text content type before the handler", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: () => true,
    });
    routes.register({
      method: "POST",
      path: "/public-mutation",
      tier: "public",
      handler: (context: Context) => context.text("mutated"),
    });

    const response = await app.request(
      "https://porchfest.example/public-mutation",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://porchfest.example",
          "x-csrf-token": "valid-token",
        },
        body: "mutation",
      },
    );

    expect(response.status).toBe(415);
  });

  it("centrally refuses an oversized mutation before parsing its form body", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: () => true,
    });
    routes.register({
      method: "POST",
      path: "/public-mutation",
      tier: "public",
      handler: (context: Context) => context.text("mutated"),
    });

    const response = await app.request(
      "https://porchfest.example/public-mutation",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://porchfest.example",
        },
        body: new URLSearchParams({
          _csrf: "valid-token",
          oversized: "x".repeat(65 * 1024),
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store, private");
  });

  it("admits an exact-origin mutation carrying a valid form token", async () => {
    const app = new Hono();
    const routes = new RouteRegistry(app, undefined, {
      allowedOrigin: "https://porchfest.example",
      validateCsrf: (token, route) =>
        token === "valid-token" && route.path === "/public-mutation",
    });
    routes.register({
      method: "POST",
      path: "/public-mutation",
      tier: "public",
      handler: (context: Context) => context.text("mutated"),
    });

    const response = await app.request(
      "https://porchfest.example/public-mutation",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://porchfest.example",
        },
        body: new URLSearchParams({ _csrf: "valid-token" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mutated");
  });
});
