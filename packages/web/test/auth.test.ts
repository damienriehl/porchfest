// R9 and KTD14 at the HTTP boundary. Core's own tests cover the credential
// rules; these prove the way in actually works through a real app: the log line
// a fresh container prints, the cookie it sets, and what a request without one
// gets back.
import { AccessError, type CoreRuntime } from "@porchfest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PorchfestRuntime } from "../src/composition.js";
import { SESSION_COOKIE } from "../src/auth.js";

const PUBLIC_BASE_URL = "https://porchfest.example";
const temporaryRoots: string[] = [];
const runtimes: PorchfestRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function boot() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "porchfest-auth-"));
  temporaryRoots.push(dataDirectory);
  const announced: string[] = [];
  const runtime = await createRuntime({
    dataDirectory,
    env: {
      PUBLIC_BASE_URL,
      PORCHFEST_SESSION_SECRET: "auth-test-session-secret",
    },
    announce: (message) => announced.push(message),
  });
  runtimes.push(runtime);
  return { runtime, announced, core: runtime.core as CoreRuntime };
}

function bootstrapTokenFrom(announced: readonly string[]): string {
  const match = announced.join("\n").match(/token=([A-Za-z0-9_-]+)/);
  expect(match, "a bootstrap link should have been announced").toBeTruthy();
  return match?.[1] ?? "";
}

async function csrfFor(runtime: PorchfestRuntime, path: string, token = "") {
  const response = await runtime.request(
    `${PUBLIC_BASE_URL}${path}?token=${token}`,
  );
  const html = await response.text();
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

/** The sign-out token is bound to its own path, so it is only available from the
 *  authenticated page that renders it. Reading it from anywhere else yields a
 *  token the registry refuses — which is the point of binding it. */
/** The sign-out token is path-bound, so it only exists on the admin shell — and
 *  the shell only renders once a season exists, because before that /admin hands
 *  the organizer to first-run setup. */
async function signOutCsrf(runtime: PorchfestRuntime, cookie: string) {
  runtime.core.setup.createSeason({
    year: 2031,
    displayName: "Synthetic Season",
    timezone: "UTC",
    eventDate: "2031-09-13",
    timeSlots: [],
    openSignups: false,
  });
  const admin = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
    headers: { cookie },
  });
  const html = await admin.text();
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";
}

function post(
  runtime: PorchfestRuntime,
  path: string,
  body: URLSearchParams,
  cookie?: string,
) {
  const headers: Record<string, string> = {
    origin: PUBLIC_BASE_URL,
    "content-type": "application/x-www-form-urlencoded",
  };
  if (cookie) headers.cookie = cookie;
  return runtime.request(`${PUBLIC_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body,
  });
}

async function signIn(
  runtime: PorchfestRuntime,
  token: string,
  fields: { displayName: string; email?: string },
) {
  const csrf = await csrfFor(runtime, "/admin/sign-in", token);
  const body = new URLSearchParams({
    _csrf: csrf,
    token,
    display_name: fields.displayName,
  });
  if (fields.email) body.set("email", fields.email);
  return post(runtime, "/admin/sign-in", body);
}

function sessionCookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";", 1)[0] ?? "";
  return value;
}

describe("first boot", () => {
  it("announces a bootstrap link when no organizer exists", async () => {
    const { announced } = await boot();

    const text = announced.join("\n");
    expect(text).toContain("/admin/sign-in?token=");
    // R9: this must not depend on the email adapter being configured.
    expect(text).toContain("no organizer yet");
  });

  it("does not announce one once an organizer exists", async () => {
    const { runtime, announced } = await boot();
    await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const before = announced.length;

    // A restart must not print a second working admin link.
    expect(() => runtime.core.access.issueBootstrapLink()).toThrowError(
      AccessError,
    );
    expect(announced.length).toBe(before);
  });

  it("takes an organizer from the announced link to the admin page", async () => {
    const { runtime, announced } = await boot();

    const response = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "Dana Organizer",
      email: "dana@example.invalid",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin");

    // With no season yet, /admin hands the organizer to first-run setup (R34)
    // rather than an empty page. Reaching it at all is what proves the session.
    const admin = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie: sessionCookieFrom(response) },
    });
    expect(admin.status).toBe(303);
    expect(admin.headers.get("location")).toBe("/admin/setup");

    const setup = await runtime.request(`${PUBLIC_BASE_URL}/admin/setup`, {
      headers: { cookie: sessionCookieFrom(response) },
    });
    expect(setup.status).toBe(200);
    expect(await setup.text()).toContain("Open your first season");
  });
});

describe("the admin tier is real", () => {
  it("redirects an unauthenticated browser GET to organizer sign-in", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { accept: "text/html" },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/admin/sign-in");
  });

  it("keeps the JSON 401 for an unauthenticated organizer GET that does not request HTML", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin`);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns an HTML 401 with a sign-in link for an unauthenticated organizer POST", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/sign-out`,
      {
        method: "POST",
        headers: { accept: "text/html" },
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain('href="/admin/sign-in"');
  });

  it("keeps the JSON 401 for an unauthenticated organizer POST that does not request HTML", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/sign-out`,
      { method: "POST" },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("refuses a made-up session cookie", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie: `${SESSION_COOKIE}=not-a-real-session` },
    });

    expect(response.status).toBe(401);
  });

  it("refuses a deactivated organizer's existing session on its next request", async () => {
    const { runtime, announced } = await boot();
    const first = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const cookie = sessionCookieFrom(first);
    expect(
      (
        await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
          headers: { cookie },
        })
      ).status,
    ).not.toBe(401);

    const organizer = runtime.core.access.listOrganizers()[0];
    runtime.core.access.deactivateOrganizer(organizer?.id ?? 0);

    const after = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });

  it("ends a session on sign-out", async () => {
    const { runtime, announced } = await boot();
    const signedIn = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const cookie = sessionCookieFrom(signedIn);

    const signOut = await post(
      runtime,
      "/admin/sign-out",
      new URLSearchParams({ _csrf: await signOutCsrf(runtime, cookie) }),
      cookie,
    );
    expect(signOut.status).toBe(303);

    const after = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });
});

describe("sign-in link handling", () => {
  it("shows the reason when a tokenless sign-in submission is refused", async () => {
    const { runtime, announced } = await boot();
    const csrf = await csrfFor(
      runtime,
      "/admin/sign-in",
      bootstrapTokenFrom(announced),
    );

    const response = await post(
      runtime,
      "/admin/sign-in",
      new URLSearchParams({ _csrf: csrf, display_name: "Organizer" }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("That sign-in link is incomplete.");
  });

  it("explains how to recover when no sign-in token is present", async () => {
    const { runtime } = await boot();

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Your session has ended");
    expect(html).toContain("bootstrap sign-in link");
    expect(html).not.toContain('name="display_name"');
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('type="submit"');
  });

  it("keeps the actionable sign-in form when a token is present", async () => {
    const { runtime, announced } = await boot();
    const token = bootstrapTokenFrom(announced);

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/sign-in?token=${token}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`name="token" value="${token}"`);
    expect(html).toContain('name="display_name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="submit"');
  });

  it("plainly explains recovery when the deployment has only one organizer", async () => {
    const { runtime, announced } = await boot();
    await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "Only Organizer",
      email: "only@example.invalid",
    });

    const response = await runtime.request(`${PUBLIC_BASE_URL}/admin/sign-in`);
    const html = await response.text();

    expect(html).toContain("another organizer");
    expect(html).toContain("operator with access to the deployment");
    expect(html).not.toContain("docs/operations/organizer-recovery.md");
  });

  it("refuses a replayed sign-in link", async () => {
    const { runtime, announced } = await boot();
    const token = bootstrapTokenFrom(announced);
    await signIn(runtime, token, {
      displayName: "First",
      email: "first@example.invalid",
    });

    const replay = await signIn(runtime, token, {
      displayName: "Again",
      email: "again@example.invalid",
    });

    expect(replay.status).toBe(403);
    expect(await replay.text()).toContain("already been used");
  });

  it("refuses a made-up token without saying whether it ever existed", async () => {
    const { runtime } = await boot();

    const response = await signIn(runtime, "invented-token", {
      displayName: "Nobody",
      email: "nobody@example.invalid",
    });

    expect(response.status).toBe(403);
    // Same wording as an expired link, so this cannot be used as an oracle.
    expect(await response.text()).toContain("no longer valid");
  });

  it("sets a session cookie that JavaScript cannot read and plain HTTP cannot carry", async () => {
    const { runtime, announced } = await boot();

    const response = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const header = response.headers.get("set-cookie") ?? "";

    // KTD14.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
  });

  it("never puts the session token in the page", async () => {
    const { runtime, announced } = await boot();
    const response = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const cookie = sessionCookieFrom(response);
    const token = cookie.split("=")[1] ?? "";

    const admin = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie },
    });

    expect(await admin.text()).not.toContain(token);
  });
});

describe("admin responses", () => {
  it("are never cached", async () => {
    const { runtime, announced } = await boot();
    const signedIn = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });

    const admin = await runtime.request(`${PUBLIC_BASE_URL}/admin`, {
      headers: { cookie: sessionCookieFrom(signedIn) },
    });

    // KTD8: this page echoes the contact database.
    expect(admin.headers.get("cache-control")).toBe("no-store, private");
  });

  it("refuse a cookie-authenticated write from another origin", async () => {
    const { runtime, announced } = await boot();
    const signedIn = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });
    const cookie = sessionCookieFrom(signedIn);
    // A VALID sign-out token, so the only thing left to refuse is the origin.
    const csrf = await signOutCsrf(runtime, cookie);

    const response = await runtime.request(
      `${PUBLIC_BASE_URL}/admin/sign-out`,
      {
        method: "POST",
        headers: {
          // The sibling marketing site is same-site, so SameSite=Lax alone would
          // not stop this. The registry's exact Origin check is the boundary.
          origin: "https://sapporchfest.org",
          cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf }),
      },
    );

    expect(response.status).toBe(403);
  });

  it("refuse a CSRF token minted for a different route", async () => {
    const { runtime, announced } = await boot();
    const signedIn = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });

    // The sign-in page's token is valid — for sign-in. Binding it to a path is
    // what stops one leaked token from authorizing every admin write.
    const response = await post(
      runtime,
      "/admin/sign-out",
      new URLSearchParams({
        _csrf: await csrfFor(
          runtime,
          "/admin/sign-in",
          bootstrapTokenFrom(announced),
        ),
      }),
      sessionCookieFrom(signedIn),
    );

    expect(response.status).toBe(403);
  });

  it("refuse a write with no CSRF token at all", async () => {
    const { runtime, announced } = await boot();
    const signedIn = await signIn(runtime, bootstrapTokenFrom(announced), {
      displayName: "First",
      email: "first@example.invalid",
    });

    const response = await post(
      runtime,
      "/admin/sign-out",
      new URLSearchParams({}),
      sessionCookieFrom(signedIn),
    );

    expect(response.status).toBe(403);
  });
});
