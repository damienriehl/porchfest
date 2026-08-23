// The response and form-parsing shapes every admin route file shares. They live
// here because a third admin route file (retention) made the third copy, and a
// drifting copy is how KTD8's no-store header or KTD14's 401 shape quietly stops
// applying to one route.
//
// `notFound` is deliberately NOT here: its body names the thing that was missing,
// which is domain wording, not plumbing.
//
// One divergence is deliberate and must stay: `readFields` in
// `packages/web/src/routes/admin.ts` trims its values, because the setup and
// sign-in forms it parses treat a stray space as a typo. The record and retention
// forms do not trim, because a record's stored text is the organizer's to control.
// Folding that file in here would silently change what those forms store.

import type { Context } from "hono";
import { adminHeaders } from "../auth.js";

/**
 * Parse a form by ITERATING rather than calling `.get()`.
 * `scripts/check-core-boundary.mjs` reads any `.get(` in `packages/web/src` as a
 * route registration outside the central registry, so a plain `FormData.get()`
 * fails the boundary gate on innocent code.
 *
 * First value wins for a repeated field name.
 */
export async function readFields(
  context: Context,
): Promise<Readonly<Record<string, string>>> {
  const form = await context.req.formData();
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of form) {
    if (typeof value === "string" && fields[name] === undefined) {
      fields[name] = value;
    }
  }
  return fields;
}

/** 303 so a refreshed POST cannot repeat the write. Carries KTD8's admin headers. */
export function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...adminHeaders(),
      "content-type": "text/plain; charset=UTF-8",
      location,
    },
  });
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...adminHeaders(), "content-type": "application/json" },
  });
}
