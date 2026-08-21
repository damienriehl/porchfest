import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PACKAGES = /^@porchfest\/(?:email|antibot|geo|web)(?:\/|$)/;
const IMPORT_SPECIFIER =
  /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

export async function findCoreBoundaryViolations(coreDirectory) {
  const violations = [];
  for (const file of await sourceFiles(coreDirectory)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (!specifier) continue;

      const resolvedRelative = specifier.startsWith('.') ? resolve(file, '..', specifier) : null;
      const reachesAdapter =
        FORBIDDEN_PACKAGES.test(specifier) ||
        (resolvedRelative !== null &&
          new RegExp(`${sep}packages${sep}(?:email|antibot|geo|web)(?:${sep}|$)`).test(
            resolvedRelative,
          ));

      if (reachesAdapter) violations.push({ file, specifier });
    }
  }
  return violations;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const coreDirectory = resolve(repoRoot, 'packages/core');
  const violations = await findCoreBoundaryViolations(coreDirectory);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `ERROR: core boundary violation in ${relative(repoRoot, violation.file)}: imports ${violation.specifier}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log('OK: core imports no adapter package');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
