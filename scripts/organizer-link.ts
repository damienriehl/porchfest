import {
  CORE_DATABASE_FILENAME,
  createAccessRepository,
  openCoreDatabase,
  type AccessRepository,
  type Organizer,
} from "@porchfest/core";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePublicBaseUrl } from "../packages/web/src/composition.js";
import { ADMIN_SIGN_IN_PATH } from "../packages/web/src/routes/admin.js";

// A shell operator can use this credential immediately. Keeping recovery at one
// hour limits exposure compared with an ordinary invite that may await email.
export const ORGANIZER_RECOVERY_TTL_MS = 60 * 60_000;

export interface OrganizerLinkOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

class OrganizerLinkError extends Error {
  override readonly name = "OrganizerLinkError";
}

function signInUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}${ADMIN_SIGN_IN_PATH}?token=${token}`;
}

function candidates(organizers: readonly Organizer[]): string {
  return organizers
    .map((organizer) => `  ${organizer.id}: ${organizer.email}`)
    .join("\n");
}

function chooseOrganizer(
  organizers: readonly Organizer[],
  selector: string | undefined,
): Organizer {
  const named = selector?.trim();
  if (!named && organizers.length === 1) return organizers[0]!;

  // A recovery URL is a bearer credential to every participant contact. When
  // several accounts exist, refusing to guess keeps shell access from silently
  // becoming access as an organizer the operator did not actually select.
  if (!named) {
    throw new OrganizerLinkError(
      [
        "More than one active organizer exists. Re-run with --organizer <email-or-id>.",
        "Candidates:",
        candidates(organizers),
      ].join("\n"),
    );
  }

  const normalized = named.toLowerCase();
  const organizer = organizers.find(
    (candidate) =>
      String(candidate.id) === named || candidate.email === normalized,
  );
  if (!organizer) {
    throw new OrganizerLinkError(
      [
        `Organizer "${named}" was not found.`,
        "Candidates:",
        candidates(organizers),
      ].join("\n"),
    );
  }
  return organizer;
}

function issueOrganizerLink(
  access: AccessRepository,
  publicBaseUrl: string,
  selector: string | undefined,
): string {
  const organizers = access.listOrganizers();
  if (organizers.length === 0) {
    const { token } = access.issueBootstrapLink();
    return [
      "",
      "  Porchfest has no organizer yet. First-run boot normally prints this bootstrap link:",
      `    ${signInUrl(publicBaseUrl, token)}`,
      "  It expires in an hour, works once, and dies as soon as an organizer exists.",
      "",
    ].join("\n");
  }

  // Deactivation is an explicit access revocation. Excluding those rows before
  // counting and selection prevents issuing a credential that cannot redeem.
  const activeOrganizers = organizers.filter(
    (organizer) => organizer.deactivatedAt === null,
  );
  if (activeOrganizers.length === 0) {
    throw new OrganizerLinkError(
      "No active organizer accounts exist. A recovery link cannot be issued for a deactivated account.",
    );
  }

  const organizer = chooseOrganizer(activeOrganizers, selector);
  const { token } = access.issueInvite(organizer.email, organizer.id);
  return [
    "",
    `  Porchfest organizer sign-in link for ${organizer.email}:`,
    `    ${signInUrl(publicBaseUrl, token)}`,
    "  It expires in one hour and works once.",
    "",
  ].join("\n");
}

export function runOrganizerLink(
  access: AccessRepository,
  publicBaseUrl: string,
  selector: string | undefined,
  output: OrganizerLinkOutput,
): number {
  try {
    const message = issueOrganizerLink(access, publicBaseUrl, selector);
    // This message contains a bearer credential to the whole contact database.
    // Stdout is the sole delivery channel so it can be read directly in the
    // operator's terminal without also entering an application or error log.
    output.stdout(message);
    return 0;
  } catch (error) {
    output.stderr(describeError(error));
    return 1;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Organizer recovery failed.";
}

function requirePublicBaseUrl(value: string | undefined): string {
  const publicBaseUrl = parsePublicBaseUrl(value);
  // Application boot permits no public URL because some deployments do not
  // announce links. Recovery must have one or it would print an unusable URL.
  if (!publicBaseUrl) {
    throw new OrganizerLinkError(
      "PUBLIC_BASE_URL is required so the recovery link points at this deployment.",
    );
  }
  return publicBaseUrl;
}

function parseSelector(args: readonly string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--organizer" && args[1]?.trim()) {
    return args[1];
  }
  if (args.length === 1 && args[0]?.startsWith("--organizer=")) {
    const selector = args[0].slice("--organizer=".length).trim();
    if (selector) return selector;
  }
  throw new OrganizerLinkError(
    "Usage: npm run organizer:link -- [--organizer <email-or-id>]",
  );
}

async function requireDataDirectory(path: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new OrganizerLinkError(
      `PORCHFEST_DATA_DIR does not exist or cannot be read: ${path}`,
    );
  }
  if (!details.isDirectory()) {
    throw new OrganizerLinkError(
      `PORCHFEST_DATA_DIR is not a directory: ${path}`,
    );
  }
}

async function requireDatabaseFile(path: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new OrganizerLinkError(
      `Porchfest database does not exist or cannot be read: ${path}`,
    );
  }
  // better-sqlite3 creates a missing path by default. Refusing anything but the
  // deployment's existing file prevents a typo from becoming an empty database.
  if (!details.isFile()) {
    throw new OrganizerLinkError(`Porchfest database is not a file: ${path}`);
  }
}

export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: OrganizerLinkOutput = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    const selector = parseSelector(args);
    const publicBaseUrl = requirePublicBaseUrl(env.PUBLIC_BASE_URL);
    const dataDirectory = resolve(env.PORCHFEST_DATA_DIR ?? "./data");
    await requireDataDirectory(dataDirectory);
    const databasePath = join(dataDirectory, CORE_DATABASE_FILENAME);
    await requireDatabaseFile(databasePath);

    const connection = openCoreDatabase(databasePath);
    try {
      // Recovery needs storage access only. Constructing this repository
      // directly avoids booting unrelated adapters and gives shell-issued links
      // their deliberately shorter lifetime.
      const access = createAccessRepository(connection.database, {
        inviteTtlMs: ORGANIZER_RECOVERY_TTL_MS,
      });
      return runOrganizerLink(access, publicBaseUrl, selector, output);
    } finally {
      connection.close();
    }
  } catch (error) {
    output.stderr(describeError(error));
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
