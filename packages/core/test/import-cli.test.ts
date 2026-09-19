import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { main, readGeocodeBounds } from "../../../scripts/import-goal1.js";
import { CORE_DATABASE_FILENAME } from "../src/index.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/season-synthetic/", import.meta.url),
);
const fixtureFileArgs = [
  "--submissions-file",
  "synthetic.submissions.json",
  "--slate-file",
  "slate.synthetic.json",
  "--geocache-file",
  "synthetic.geocache.json",
] as const;

describe("Goal-1 import CLI", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function temporary(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("requires an explicit artifact directory and names a missing artifact", async () => {
    const absentOutput = captureOutput();
    expect(await main([], {}, absentOutput)).toBe(1);
    expect(absentOutput.stderrMessages.join("\n")).toContain(
      "--artifacts or PORCHFEST_GOAL1_ARTIFACTS is required",
    );

    const incomplete = await temporary("porchfest-goal1-incomplete-");
    await mkdir(join(incomplete, "out"), { recursive: true });
    await mkdir(join(incomplete, "private"), { recursive: true });
    await writeFile(join(incomplete, "out", "submissions.json"), "{}\n");
    await writeFile(join(incomplete, "private", "matches-2026.json"), "{}\n");
    const missingOutput = captureOutput();
    expect(await main(["--artifacts", incomplete], {}, missingOutput)).toBe(1);
    expect(missingOutput.stderrMessages.join("\n")).toContain(
      "private/geocache.json",
    );
  });

  it.each([
    "--artifacts",
    "--submissions-file",
    "--slate-file",
    "--geocache-file",
    "--data-dir",
    "--event-year",
    "--locality",
    "--bounds",
  ])(
    "rejects a missing or blank %s option before touching storage",
    async (option) => {
      const dataDirectory = join(
        await temporary("porchfest-goal1-invalid-options-"),
        "unused",
      );
      for (const args of [[option], [option + "="], [option, "   "]]) {
        const output = captureOutput();
        expect(
          await main(args, { PORCHFEST_DATA_DIR: dataDirectory }, output),
        ).toBe(1);
        await expect(stat(dataDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(output.stdoutMessages).toEqual([]);
        expect(output.stderrMessages.join("\n")).toContain(
          option + " requires a value",
        );
      }
    },
  );

  it.each(["26", "20310", "year", "20.1"])(
    "rejects malformed event year %j from both CLI and environment",
    async (year) => {
      for (const [args, env] of [
        [["--event-year", year], {}],
        [[], { PORCHFEST_GOAL1_EVENT_YEAR: year }],
      ] as const) {
        const output = captureOutput();
        expect(await main(args, env, output)).toBe(1);
        expect(output.stderrMessages.join("\n")).toContain(
          "must be a four-digit year",
        );
      }
    },
  );

  it.each([
    "1,2,3",
    "1,2,3,4,5",
    "NaN,2,3,4",
    "1,2,Infinity,4",
    "3,2,1,4",
    "1,4,3,2",
    "1,2,1,4",
    "1,2,3,2",
  ])("rejects malformed or inverted bounds %j", async (bounds) => {
    const output = captureOutput();
    expect(await main(["--bounds=" + bounds], {}, output)).toBe(1);
    expect(output.stderrMessages.join("\n")).toContain("--bounds");
    expect(output.stdoutMessages).toEqual([]);
  });

  it("reports unknown flags and an artifact file supplied instead of a directory", async () => {
    const unknown = captureOutput();
    expect(await main(["--unknown"], {}, unknown)).toBe(1);
    expect(unknown.stderrMessages.join("\n")).toContain(
      "Unknown argument: --unknown",
    );
    const fileOutput = captureOutput();
    expect(
      await main(
        ["--artifacts", join(fixtureDirectory, "slate.synthetic.json")],
        {},
        fileOutput,
      ),
    ).toBe(1);
    expect(fileOutput.stderrMessages.join("\n")).toContain("not a directory");
  });

  it("rejects missing or malformed geocoder bounds without evaluating Python", async () => {
    const artifacts = await temporary("porchfest-goal1-source-bounds-");
    await expect(readGeocodeBounds(artifacts)).rejects.toThrow(
      "missing or unreadable",
    );
    await mkdir(join(artifacts, "tools"));
    await writeFile(
      join(artifacts, "tools/geocode.py"),
      "raise Exception('must never execute')\nLAT_MIN = 1\n",
    );
    await expect(readGeocodeBounds(artifacts)).rejects.toThrow(
      "Could not read LAT_MIN",
    );
    await writeFile(
      join(artifacts, "tools/geocode.py"),
      "LAT_MIN, LAT_MAX = 3, 1\nLNG_MIN, LNG_MAX = 2, 4\n",
    );
    await expect(readGeocodeBounds(artifacts)).rejects.toThrow("south < north");
  });

  it("imports using equals-style arguments and environment artifact paths into isolated SQLite", async () => {
    const dataDirectory = await temporary("porchfest-goal1-equals-data-");
    const output = captureOutput();
    const args = [
      "--submissions-file=synthetic.submissions.json",
      "--slate-file=slate.synthetic.json",
      "--geocache-file=synthetic.geocache.json",
      "--bounds=9.5,19.5,10.5,20.5",
      "--locality=Synthetic Quarter",
      "--data-dir=" + dataDirectory,
    ];
    expect(
      await main(args, { PORCHFEST_GOAL1_ARTIFACTS: fixtureDirectory }, output),
    ).toBe(0);
    expect(output.stderrMessages).toEqual([]);
    expect(rowCount(dataDirectory, "seasons")).toBe(1);
    const second = captureOutput();
    expect(
      await main([...args, "--artifacts=" + fixtureDirectory], {}, second),
    ).toBe(0);
    expect(rowCount(dataDirectory, "seasons")).toBe(1);
  });

  it("reads generic bounds from the artifact geocoder or accepts flags", async () => {
    const artifacts = await temporary("porchfest-goal1-bounds-");
    await mkdir(join(artifacts, "tools"));
    await writeFile(
      join(artifacts, "tools/geocode.py"),
      "LAT_MIN, LAT_MAX = 9.5, 10.5\nLNG_MIN, LNG_MAX = 19.5, 20.5\n",
    );
    await expect(readGeocodeBounds(artifacts)).resolves.toEqual({
      south: 9.5,
      west: 19.5,
      north: 10.5,
      east: 20.5,
    });
  });

  it("dry-run prints the report and rolls back before a normal idempotent import", async () => {
    const copiedArtifacts = await temporary("porchfest-goal1-artifacts-");
    await cp(fixtureDirectory, copiedArtifacts, { recursive: true });
    const dataDirectory = await temporary("porchfest-goal1-data-");
    const args = [
      "--artifacts",
      copiedArtifacts,
      ...fixtureFileArgs,
      "--bounds",
      "9.5,19.5,10.5,20.5",
      "--data-dir",
      dataDirectory,
    ];

    const dryOutput = captureOutput();
    expect(await main([...args, "--dry-run"], {}, dryOutput)).toBe(0);
    expect(
      JSON.parse(dryOutput.stdoutMessages.join("\n")).records.season.created,
    ).toBe(1);
    expect(rowCount(dataDirectory, "seasons")).toBe(0);

    const firstOutput = captureOutput();
    expect(await main(args, {}, firstOutput)).toBe(0);
    expect(rowCount(dataDirectory, "seasons")).toBe(1);
    const secondOutput = captureOutput();
    expect(await main(args, {}, secondOutput)).toBe(0);
    const second = JSON.parse(secondOutput.stdoutMessages.join("\n"));
    expect(
      Object.values(second.records).every(
        (counts) => (counts as { created: number }).created === 0,
      ),
    ).toBe(true);
  });

  it("accepts an explicit event year from the flag or environment", async () => {
    const copiedArtifacts = await temporary("porchfest-goal1-event-year-");
    await cp(fixtureDirectory, copiedArtifacts, { recursive: true });
    const slatePath = join(copiedArtifacts, "slate.synthetic.json");
    const slate = JSON.parse(await readFile(slatePath, "utf8"));
    delete slate.event.date;
    slate.event.date_display = "Wednesday, September 16";
    await writeFile(slatePath, `${JSON.stringify(slate, null, 2)}\n`);
    const dataDirectory = await temporary("porchfest-goal1-year-data-");
    const baseArgs = [
      "--data-dir",
      dataDirectory,
      "--artifacts",
      copiedArtifacts,
      ...fixtureFileArgs,
      "--bounds",
      "9.5,19.5,10.5,20.5",
      "--dry-run",
    ];

    const flagOutput = captureOutput();
    expect(
      await main([...baseArgs, "--event-year", "2026"], {}, flagOutput),
    ).toBe(0);

    const envOutput = captureOutput();
    expect(
      await main(baseArgs, { PORCHFEST_GOAL1_EVENT_YEAR: "2026" }, envOutput),
    ).toBe(0);
  });

  it("rolls back normal and dry-run imports when a late artifact error occurs", async () => {
    const copiedArtifacts = await temporary("porchfest-goal1-invalid-");
    await cp(fixtureDirectory, copiedArtifacts, { recursive: true });
    const geocachePath = join(copiedArtifacts, "synthetic.geocache.json");
    const geocache = JSON.parse(await readFile(geocachePath, "utf8"));
    const activeAddress = Object.keys(geocache)[2]!;
    geocache[activeAddress].lat = "not-a-coordinate";
    await writeFile(geocachePath, `${JSON.stringify(geocache, null, 2)}\n`);

    for (const dryRun of [false, true]) {
      const dataDirectory = await temporary(
        `porchfest-goal1-rollback-${dryRun ? "dry" : "normal"}-`,
      );
      const output = captureOutput();
      const args = [
        "--artifacts",
        copiedArtifacts,
        ...fixtureFileArgs,
        "--bounds",
        "9.5,19.5,10.5,20.5",
        "--data-dir",
        dataDirectory,
        ...(dryRun ? ["--dry-run"] : []),
      ];
      expect(await main(args, {}, output)).toBe(1);
      expect(output.stderrMessages.join("\n")).toContain(
        "geocache latitude must be a finite number",
      );
      expect(rowCount(dataDirectory, "seasons")).toBe(0);
    }
  });
});

function captureOutput() {
  const stdoutMessages: string[] = [];
  const stderrMessages: string[] = [];
  return {
    stdoutMessages,
    stderrMessages,
    stdout: (message: string) => {
      stdoutMessages.push(message);
    },
    stderr: (message: string) => {
      stderrMessages.push(message);
    },
  };
}

function rowCount(directory: string, table: string): number {
  const database = new Database(join(directory, CORE_DATABASE_FILENAME), {
    readonly: true,
  });
  try {
    return (
      database.prepare(`select count(*) as total from ${table}`).get() as {
        total: number;
      }
    ).total;
  } finally {
    database.close();
  }
}
