import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SESSION_SECRET_PLACEHOLDER = "replace-with-a-unique-random-secret";
export const SESSION_SECRET_FILENAME = "session-secret";

export interface SessionSecretOptions {
  readonly dataDirectory: string;
  readonly configuredSecret?: string;
}

function validateSecret(secret: string, source: string): string {
  if (secret === SESSION_SECRET_PLACEHOLDER) {
    throw new Error(
      `Refusing to start: ${source} equals a known public placeholder; leave it unset to generate a unique secret or configure a unique high-entropy value.`,
    );
  }
  if (secret.length === 0) {
    throw new Error(`Refusing to start: ${source} is empty.`);
  }
  return secret;
}

async function readGeneratedSecret(path: string): Promise<string> {
  const secret = (await readFile(path, "utf8")).trim();
  return validateSecret(secret, `generated secret file ${path}`);
}

export async function loadSessionSecret(
  options: SessionSecretOptions,
): Promise<string> {
  if (options.configuredSecret !== undefined) {
    return validateSecret(options.configuredSecret, "PORCHFEST_SESSION_SECRET");
  }

  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(options.dataDirectory, SESSION_SECRET_FILENAME);

  try {
    return await readGeneratedSecret(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readGeneratedSecret(path);
  }
}
