import { and, asc, eq } from "drizzle-orm";
import {
  importKeys,
  type ImportKey,
  type ImportRecordType,
} from "./storage/schema.js";
import {
  type CoreExecutor,
  RepositoryLifecycleError,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

export interface BindImportKeyInput {
  readonly seasonId: number;
  readonly source: string;
  readonly naturalKey: string;
  readonly recordType: ImportRecordType;
  readonly recordId: number;
}

export interface BoundImportKey {
  readonly key: ImportKey;
  readonly created: boolean;
}

export class ImportKeyLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("ImportKeyLifecycleError", message);
  }
}

export function createImportKeyRepository(
  db: CoreExecutor,
  options: RepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function find(
    seasonId: number,
    source: string,
    naturalKey: string,
  ): ImportKey | null {
    return (
      db
        .select()
        .from(importKeys)
        .where(
          and(
            eq(importKeys.seasonId, seasonId),
            eq(importKeys.source, source),
            eq(importKeys.naturalKey, naturalKey),
          ),
        )
        .get() ?? null
    );
  }

  function findSeason(source: string, naturalKey: string): ImportKey | null {
    return (
      db
        .select()
        .from(importKeys)
        .where(
          and(
            eq(importKeys.source, source),
            eq(importKeys.naturalKey, naturalKey),
            eq(importKeys.recordType, "season"),
          ),
        )
        .orderBy(asc(importKeys.id))
        .get() ?? null
    );
  }

  function bind(input: BindImportKeyInput): BoundImportKey {
    const source = input.source.trim();
    const naturalKey = input.naturalKey.trim();
    if (!source || !naturalKey) {
      throw new ImportKeyLifecycleError(
        "import source and natural key must be non-empty",
      );
    }
    const stamp = now();
    const key = db
      .insert(importKeys)
      .values({
        ...input,
        source,
        naturalKey,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoNothing({
        target: [importKeys.seasonId, importKeys.source, importKeys.naturalKey],
      })
      .returning()
      .get();
    if (key !== undefined) return { key, created: true };
    const existing = find(input.seasonId, source, naturalKey)!;
    if (
      existing.recordType !== input.recordType ||
      existing.recordId !== input.recordId
    ) {
      throw new ImportKeyLifecycleError(
        `import key ${source}/${naturalKey} is already bound to ${existing.recordType} ${existing.recordId}`,
      );
    }
    return { key: existing, created: false };
  }

  function list(seasonId: number): ImportKey[] {
    return db
      .select()
      .from(importKeys)
      .where(eq(importKeys.seasonId, seasonId))
      .orderBy(asc(importKeys.id))
      .all();
  }

  return Object.freeze({ bind, find, findSeason, list });
}

export type ImportKeyRepository = ReturnType<typeof createImportKeyRepository>;
