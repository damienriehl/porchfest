import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findCoreBoundaryViolations,
  findWebRouteBoundaryViolations,
} from "./check-core-boundary.mjs";

const directory = await mkdtemp(
  join(tmpdir(), "porchfest-boundary-self-test-"),
);

try {
  const coreDirectory = join(directory, "core");
  await mkdir(join(coreDirectory, "src"), { recursive: true });
  await writeFile(
    join(coreDirectory, "src/example.ts"),
    "import { NullEmailAdapter } from '@porchfest/email';\n",
  );

  assert.deepEqual(
    (await findCoreBoundaryViolations(coreDirectory)).map(
      ({ specifier }) => specifier,
    ),
    ["@porchfest/email"],
  );
  console.log("OK: core boundary self-test refuses adapter imports");

  const webDirectory = join(directory, "web");
  await mkdir(join(webDirectory, "router"), { recursive: true });
  await writeFile(
    join(webDirectory, "rogue.ts"),
    "app.get('/unguarded', handler);\n",
  );
  await writeFile(
    join(webDirectory, "router/registry.ts"),
    "app.on('GET', '/guarded', handler);\n",
  );

  assert.deepEqual(
    (await findWebRouteBoundaryViolations(webDirectory)).map(
      ({ method, line }) => ({
        method,
        line,
      }),
    ),
    [{ method: "get", line: 1 }],
  );
  console.log("OK: route boundary self-test refuses direct registration");
} finally {
  await rm(directory, { recursive: true, force: true });
}
