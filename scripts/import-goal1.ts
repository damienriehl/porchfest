import {
  CORE_DATABASE_FILENAME,
  createAnnotationRepository,
  createGeocodingRepository,
  createImportKeyRepository,
  createSeasonRepository,
  createSeasonSetup,
  goal1ArtifactFiles,
  importGoal1Season,
  openCoreDatabase,
  type BoundingBox,
  type Goal1ArtifactFileMap,
  type Goal1ImportCore,
  type ImportReport,
} from "@porchfest/core";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: npm run import:goal1 -- --artifacts <dir> [--submissions-file <path>] [--slate-file <path>] [--geocache-file <path>] [--data-dir <dir>] [--event-year YYYY] [--dry-run] [--locality <name>] [--bounds <south,west,north,east>]";

export interface ImportGoal1Output {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface CliOptions {
  readonly artifactsDirectory: string;
  readonly artifactFiles: Goal1ArtifactFileMap;
  readonly dataDirectory: string;
  readonly eventYear: number | null;
  readonly dryRun: boolean;
  readonly localityName: string | null;
  readonly bounds: BoundingBox | null;
}

export class ImportGoal1Error extends Error {
  override readonly name = "ImportGoal1Error";
}

export async function main(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  output: ImportGoal1Output = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  try {
    const options = parseArgs(args, env);
    await requireArtifactDirectory(
      options.artifactsDirectory,
      options.artifactFiles,
    );
    const event = await readEvent(
      options.artifactsDirectory,
      options.artifactFiles,
    );
    const bounds =
      options.bounds ?? (await readGeocodeBounds(options.artifactsDirectory));
    const localityName =
      options.localityName ?? requiredString(event.city, "event city/locality");
    await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
    const connection = openCoreDatabase(
      join(options.dataDirectory, CORE_DATABASE_FILENAME),
    );
    try {
      const core = importCore(connection.database);
      const importOptions = {
        artifactsDirectory: options.artifactsDirectory,
        artifactFiles: options.artifactFiles,
        localityName,
        bounds,
        ...(options.eventYear === null ? {} : { eventYear: options.eventYear }),
        dryRun: options.dryRun,
      };
      const report: ImportReport = importGoal1Season(core, importOptions);
      output.stdout(JSON.stringify(report, null, 2));
      return 0;
    } finally {
      connection.close();
    }
  } catch (error) {
    output.stderr(describeError(error));
    return 1;
  }
}

function importCore(
  database: Parameters<typeof createSeasonSetup>[0],
): Goal1ImportCore {
  const noNetworkGeo = {
    name: "goal1-offline-import",
    configured: false,
    async locate() {
      return {
        kind: "unavailable" as const,
        reason: "The Goal-1 import never performs network geocoding.",
      };
    },
    async geocode() {
      return null;
    },
  };
  return {
    transaction: <T>(work: () => T): T => database.transaction(work),
    setup: createSeasonSetup(database),
    seasons: createSeasonRepository(database),
    geocoding: createGeocodingRepository(database, { geo: noNetworkGeo }),
    annotations: createAnnotationRepository(database),
    importKeys: createImportKeyRepository(database),
  };
}

function parseArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliOptions {
  let artifacts = env.PORCHFEST_GOAL1_ARTIFACTS?.trim() || null;
  let dataDirectory = env.PORCHFEST_DATA_DIR?.trim() || "./data";
  const configuredEventYear = env.PORCHFEST_GOAL1_EVENT_YEAR?.trim();
  let eventYear = configuredEventYear
    ? parseEventYear(configuredEventYear)
    : null;
  const artifactFiles = { ...goal1ArtifactFiles };
  let localityName: string | null = null;
  let bounds: BoundingBox | null = null;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const nextValue = (name: string): string => {
      const value = args[index + 1]?.trim();
      if (!value)
        throw new ImportGoal1Error(`${name} requires a value. ${usage}`);
      index += 1;
      return value;
    };
    if (argument === "--artifacts") artifacts = nextValue("--artifacts");
    else if (argument.startsWith("--artifacts=")) {
      artifacts = requiredOptionValue(argument, "--artifacts");
    } else if (argument === "--submissions-file") {
      artifactFiles.submissions = nextValue("--submissions-file");
    } else if (argument.startsWith("--submissions-file=")) {
      artifactFiles.submissions = requiredOptionValue(
        argument,
        "--submissions-file",
      );
    } else if (argument === "--slate-file") {
      artifactFiles.slate = nextValue("--slate-file");
    } else if (argument.startsWith("--slate-file=")) {
      artifactFiles.slate = requiredOptionValue(argument, "--slate-file");
    } else if (argument === "--geocache-file") {
      artifactFiles.geocache = nextValue("--geocache-file");
    } else if (argument.startsWith("--geocache-file=")) {
      artifactFiles.geocache = requiredOptionValue(argument, "--geocache-file");
    } else if (argument === "--data-dir") {
      dataDirectory = nextValue("--data-dir");
    } else if (argument.startsWith("--data-dir=")) {
      dataDirectory = requiredOptionValue(argument, "--data-dir");
    } else if (argument === "--event-year") {
      eventYear = parseEventYear(nextValue("--event-year"));
    } else if (argument.startsWith("--event-year=")) {
      eventYear = parseEventYear(requiredOptionValue(argument, "--event-year"));
    } else if (argument === "--locality") {
      localityName = nextValue("--locality");
    } else if (argument.startsWith("--locality=")) {
      localityName = requiredOptionValue(argument, "--locality");
    } else if (argument === "--bounds") {
      bounds = parseBounds(nextValue("--bounds"));
    } else if (argument.startsWith("--bounds=")) {
      bounds = parseBounds(requiredOptionValue(argument, "--bounds"));
    } else if (argument === "--dry-run") dryRun = true;
    else throw new ImportGoal1Error(`Unknown argument: ${argument}. ${usage}`);
  }
  if (!artifacts) {
    throw new ImportGoal1Error(
      `--artifacts or PORCHFEST_GOAL1_ARTIFACTS is required; there is no in-repo default. ${usage}`,
    );
  }
  return {
    artifactsDirectory: resolve(artifacts),
    artifactFiles,
    dataDirectory: resolve(dataDirectory),
    eventYear,
    dryRun,
    localityName,
    bounds,
  };
}

function requiredOptionValue(argument: string, name: string): string {
  const value = argument.slice(name.length + 1).trim();
  if (!value) throw new ImportGoal1Error(`${name} requires a value. ${usage}`);
  return value;
}

function parseEventYear(value: string): number {
  if (!/^\d{4}$/.test(value)) {
    throw new ImportGoal1Error(
      "--event-year or PORCHFEST_GOAL1_EVENT_YEAR must be a four-digit year.",
    );
  }
  return Number(value);
}

function parseBounds(value: string): BoundingBox {
  const numbers = value.split(",").map((part) => Number(part.trim()));
  if (
    numbers.length !== 4 ||
    numbers.some((number) => !Number.isFinite(number))
  ) {
    throw new ImportGoal1Error(
      "--bounds must be four finite numbers: south,west,north,east.",
    );
  }
  const [south, west, north, east] = numbers as [
    number,
    number,
    number,
    number,
  ];
  if (south >= north || west >= east) {
    throw new ImportGoal1Error(
      "--bounds requires south < north and west < east.",
    );
  }
  return { south, west, north, east };
}

async function requireArtifactDirectory(
  directory: string,
  files: Goal1ArtifactFileMap,
): Promise<void> {
  let details;
  try {
    details = await stat(directory);
  } catch {
    throw new ImportGoal1Error(
      `Goal-1 artifacts directory does not exist or cannot be read: ${directory}`,
    );
  }
  if (!details.isDirectory()) {
    throw new ImportGoal1Error(
      `Goal-1 artifacts path is not a directory: ${directory}`,
    );
  }
  for (const relativePath of Object.values(files)) {
    const path = join(directory, relativePath);
    try {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
    } catch {
      throw new ImportGoal1Error(
        `Required Goal-1 artifact is missing or unreadable: ${relativePath}`,
      );
    }
  }
}

async function readEvent(
  directory: string,
  files: Goal1ArtifactFileMap,
): Promise<Record<string, unknown>> {
  const path = join(directory, files.slate);
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    event?: unknown;
  };
  if (!parsed.event || typeof parsed.event !== "object") {
    throw new ImportGoal1Error(`${files.slate} has no event object.`);
  }
  return parsed.event as Record<string, unknown>;
}

export async function readGeocodeBounds(
  directory: string,
): Promise<BoundingBox> {
  const relativePath = "tools/geocode.py";
  const path = join(directory, relativePath);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new ImportGoal1Error(
      `Goal-1 bounding box source is missing or unreadable: ${relativePath}; pass --bounds to supply it explicitly.`,
    );
  }
  const latitude =
    /LAT_MIN\s*,\s*LAT_MAX\s*=\s*([-+\d.]+)\s*,\s*([-+\d.]+)/.exec(source);
  const longitude =
    /LNG_MIN\s*,\s*LNG_MAX\s*=\s*([-+\d.]+)\s*,\s*([-+\d.]+)/.exec(source);
  if (!latitude || !longitude) {
    throw new ImportGoal1Error(
      `Could not read LAT_MIN/LAT_MAX/LNG_MIN/LNG_MAX from ${relativePath}; pass --bounds explicitly.`,
    );
  }
  return parseBounds(
    `${latitude[1]},${longitude[1]},${latitude[2]},${longitude[2]}`,
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImportGoal1Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Goal-1 import failed.";
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
