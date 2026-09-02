import type { AntibotClientChallenge } from "@porchfest/core";
import { contentSecurityPolicy } from "./security-headers.js";
import { renderParticipantAccessRequiredPage } from "./views/self-serve.js";

export function participantAccessRefusal(): Response {
  return new Response(renderParticipantAccessRequiredPage(), {
    status: 401,
    headers: participantHeaders(null),
  });
}

export function participantHeaders(
  challenge: AntibotClientChallenge | null,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    "cache-control": "no-store, private",
    "content-security-policy": contentSecurityPolicy(challenge),
    "content-type": "text/html; charset=UTF-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}
