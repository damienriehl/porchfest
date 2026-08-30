export const HOST_SIGNUP_PATH = "/signup/host";
export const PERFORMER_SIGNUP_PATH = "/signup/performer";

export interface SeasonSignupUrls {
  readonly host: string;
  readonly performer: string;
}

/** Build copyable public links only from the deployment's validated public base. */
export function seasonSignupUrls(
  publicBaseUrl: string | null,
  seasonId: number,
): SeasonSignupUrls | null {
  if (publicBaseUrl === null) return null;
  const host = new URL(HOST_SIGNUP_PATH, publicBaseUrl);
  host.searchParams.set("season", String(seasonId));
  const performer = new URL(PERFORMER_SIGNUP_PATH, publicBaseUrl);
  performer.searchParams.set("season", String(seasonId));
  return { host: host.href, performer: performer.href };
}
