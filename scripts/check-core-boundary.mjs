import { readFile, readdir } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PACKAGES = /^@porchfest\/(?:email|antibot|geo|web)(?:\/|$)/;
const FORBIDDEN_PACKAGE_PATH = /\/packages\/(?:email|antibot|geo|web)(?:\/|$)/;
const IMPORT_SPECIFIER =
  /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
const DIRECT_ROUTE_REGISTRATION =
  /\.\s*(get|post|put|patch|delete|options|all|on|route|mount)\s*\(/g;
const ROUTE_REGISTRY_PATH = '/router/registry.ts';

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
          FORBIDDEN_PACKAGE_PATH.test(resolvedRelative.split(sep).join('/')));

      if (reachesAdapter) violations.push({ file, specifier });
    }
  }
  return violations;
}

export async function findWebRouteBoundaryViolations(webSourceDirectory) {
  const violations = [];
  for (const file of await sourceFiles(webSourceDirectory)) {
    const normalizedFile = file.split(sep).join('/');
    if (normalizedFile.endsWith(ROUTE_REGISTRY_PATH)) continue;

    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(DIRECT_ROUTE_REGISTRATION)) {
      if (match.index === undefined) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({ file, line, method: match[1] });
    }
  }
  return violations;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const coreDirectory = resolve(repoRoot, 'packages/core');
  const webSourceDirectory = resolve(repoRoot, 'packages/web/src');
  const coreViolations = await findCoreBoundaryViolations(coreDirectory);
  const webRouteViolations = await findWebRouteBoundaryViolations(webSourceDirectory);

  if (coreViolations.length > 0 || webRouteViolations.length > 0) {
    for (const violation of coreViolations) {
      console.error(
        `ERROR: core boundary violation in ${relative(repoRoot, violation.file)}: imports ${violation.specifier}`,
      );
    }
    for (const violation of webRouteViolations) {
      console.error(
        `ERROR: route boundary violation in ${relative(repoRoot, violation.file)}:${violation.line}: calls .${violation.method}() outside the central registry`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log('OK: core imports no adapter package');
  console.log('OK: web routes are registered only through the central registry');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
