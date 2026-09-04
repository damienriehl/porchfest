import {
  CORE_DATABASE_FILENAME,
  createAnnotationRepository,
  createSeasonRepository,
  createSeasonSetup,
  openCoreDatabase,
  type Season,
  type Venue,
} from "@porchfest/core";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ADDRESS = "2349 Commonwealth";
const ANNOTATION =
  'Override: rain plan corrected 2026-09-03 — host-form "enclosed" answer overstates rain safety; venue is NOT fully rain-safe (E6, correction inventory).';
const usage =
  "Usage: npx tsx scripts/ops-e6-rain-backup.ts [--data-dir <dir>] [--venue-id <n>] [--address <prefix>] [--apply]";

interface CliOptions {
  readonly dataDirectory: string;
  readonly venueId: number | null;
  readonly address: string | null;
  readonly apply: boolean;
}

interface OpsOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

class RainBackupCorrectionError extends Error {
  override readonly name = "RainBackupCorrectionError";
}

function requiredOptionValue(argument: string, name: string): string {
  const value = argument.slice(name.length + 1).trim();
  if (!value) {
    throw new RainBackupCorrectionError(`${name} requires a value. ${usage}`);
  }
  return value;
}

function positiveSafeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new RainBackupCorrectionError(
      `${name} must be a safe positive integer; received "${value}". ${usage}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RainBackupCorrectionError(
      `${name} must be a safe positive integer; received "${value}". ${usage}`,
    );
  }
  return parsed;
}

function parseArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let dataDirectory = env.PORCHFEST_DATA_DIR?.trim() || null;
  let venueId: number | null = null;
  let address: string | null = null;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const nextValue = (name: string): string => {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new RainBackupCorrectionError(
          `${name} requires a value. ${usage}`,
        );
      }
      index += 1;
      return value;
    };

    if (argument === "--data-dir") {
      dataDirectory = nextValue("--data-dir");
    } else if (argument.startsWith("--data-dir=")) {
      dataDirectory = requiredOptionValue(argument, "--data-dir");
    } else if (argument === "--venue-id") {
      venueId = positiveSafeInteger(nextValue("--venue-id"), "--venue-id");
    } else if (argument.startsWith("--venue-id=")) {
      venueId = positiveSafeInteger(
        requiredOptionValue(argument, "--venue-id"),
        "--venue-id",
      );
    } else if (argument === "--address") {
      address = nextValue("--address");
    } else if (argument.startsWith("--address=")) {
      address = requiredOptionValue(argument, "--address");
    } else if (argument === "--apply") {
      apply = true;
    } else {
      throw new RainBackupCorrectionError(
        `Unknown argument: ${argument}. ${usage}`,
      );
    }
  }

  if (!dataDirectory) {
    throw new RainBackupCorrectionError(
      `PORCHFEST_DATA_DIR or --data-dir is required. ${usage}`,
    );
  }

  return {
    dataDirectory: resolve(dataDirectory),
    venueId,
    address,
    apply,
  };
}

async function requireDataDirectory(path: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new RainBackupCorrectionError(
      `PORCHFEST_DATA_DIR does not exist or cannot be read: ${path}`,
    );
  }
  if (!details.isDirectory()) {
    throw new RainBackupCorrectionError(
      `PORCHFEST_DATA_DIR is not a directory: ${path}`,
    );
  }
}

async function requireDatabaseFile(path: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new RainBackupCorrectionError(
      `Porchfest database does not exist or cannot be read: ${path}`,
    );
  }
  if (!details.isFile()) {
    throw new RainBackupCorrectionError(
      `Porchfest database is not a file: ${path}`,
    );
  }
}

function currentSeason(seasons: readonly Season[]): Season {
  const season = seasons[0];
  if (!season) {
    throw new RainBackupCorrectionError(
      "The Porchfest database does not contain a season.",
    );
  }
  return season;
}

function candidateAddresses(venues: readonly Venue[]): string {
  if (venues.length === 0) return "  (none)";
  return venues
    .map((venue) => `  ${venue.address ?? "(no address)"}`)
    .join("\n");
}

function findVenue(venues: readonly Venue[], addressPrefix: string): Venue {
  const normalizedPrefix = addressPrefix.trim().toLowerCase();
  const canonicalVenues = venues.filter(
    (venue) => venue.canonicalVenueId === null,
  );
  const matches = canonicalVenues.filter((venue) =>
    venue.address?.trim().toLowerCase().startsWith(normalizedPrefix),
  );
  if (matches.length !== 1) {
    throw new RainBackupCorrectionError(
      [
        `Address prefix "${addressPrefix}" matched ${matches.length} venues; exactly one is required.`,
        "Candidate addresses in the current season:",
        candidateAddresses(canonicalVenues),
      ].join("\n"),
    );
  }
  return matches[0]!;
}

function assertAddressPrefix(venue: Venue, addressPrefix: string): void {
  const matches = venue.address
    ?.trim()
    .toLowerCase()
    .startsWith(addressPrefix.trim().toLowerCase());
  if (!matches) {
    throw new RainBackupCorrectionError(
      `Venue id ${venue.id} has address "${venue.address ?? "(no address)"}", which does not start with asserted prefix "${addressPrefix}".`,
    );
  }
}

function venueState(venue: Venue) {
  return {
    venueId: venue.id,
    title: venue.title,
    address: venue.address,
    rainBackup: venue.rainBackup,
    version: venue.version,
    seasonId: venue.seasonId,
    canonicalVenueId: venue.canonicalVenueId,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The E6 rain-backup correction failed.";
}

export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: OpsOutput = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    const options = parseArgs(args, env);
    await requireDataDirectory(options.dataDirectory);
    const databasePath = join(options.dataDirectory, CORE_DATABASE_FILENAME);
    await requireDatabaseFile(databasePath);

    const connection = openCoreDatabase(databasePath);
    try {
      const setup = createSeasonSetup(connection.database);
      const seasons = createSeasonRepository(connection.database);
      const annotations = createAnnotationRepository(connection.database);
      let venue: Venue;
      if (options.venueId !== null) {
        venue = seasons.getVenue(options.venueId);
        if (options.address !== null) {
          assertAddressPrefix(venue, options.address);
        }
      } else {
        const season = currentSeason(setup.listSeasons());
        venue = findVenue(
          seasons.listSeasonVenues(season.id),
          options.address ?? DEFAULT_ADDRESS,
        );
      }

      if (!options.apply) {
        output.stdout(JSON.stringify(venueState(venue), null, 2));
        return 0;
      }

      if (venue.rainBackup === false) {
        output.stdout(
          JSON.stringify({ changed: false, ...venueState(venue) }, null, 2),
        );
        return 0;
      }

      connection.database.transaction(() => {
        seasons.updateVenue(venue.id, venue.version, { rainBackup: false });
        annotations.annotate({
          seasonId: venue.seasonId,
          recordType: "venue",
          recordId: venue.id,
          note: ANNOTATION,
        });
      });

      const updatedVenue = seasons.getVenue(venue.id);
      output.stdout(
        JSON.stringify({ changed: true, ...venueState(updatedVenue) }, null, 2),
      );
      return 0;
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
