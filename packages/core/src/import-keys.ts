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

  function normalizedInput(input: BindImportKeyInput): BindImportKeyInput {
    const source = input.source.trim();
    const naturalKey = input.naturalKey.trim();
    if (!source || !naturalKey) {
      throw new ImportKeyLifecycleError(
        "import source and natural key must be non-empty",
      );
    }
    return { ...input, source, naturalKey };
  }

  function bind(input: BindImportKeyInput): BoundImportKey {
    const normalized = normalizedInput(input);
    const stamp = now();
    const key = db
      .insert(importKeys)
      .values({
        ...normalized,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoNothing({
        target: [importKeys.seasonId, importKeys.source, importKeys.naturalKey],
      })
      .returning()
      .get();
    if (key !== undefined) return { key, created: true };
    const existing = find(
      normalized.seasonId,
      normalized.source,
      normalized.naturalKey,
    )!;
    if (
      existing.recordType !== normalized.recordType ||
      existing.recordId !== normalized.recordId
    ) {
      throw new ImportKeyLifecycleError(
        `import key ${normalized.source}/${normalized.naturalKey} is already bound to ${existing.recordType} ${existing.recordId}`,
      );
    }
    return { key: existing, created: false };
  }

  function rebind(input: BindImportKeyInput): ImportKey {
    const normalized = normalizedInput(input);
    const existing = find(
      normalized.seasonId,
      normalized.source,
      normalized.naturalKey,
    );
    if (existing === null) return bind(normalized).key;
    if (existing.recordType !== normalized.recordType) {
      throw new ImportKeyLifecycleError(
        `import key ${normalized.source}/${normalized.naturalKey} is already bound to ${existing.recordType} ${existing.recordId}`,
      );
    }
    if (existing.recordId === normalized.recordId) return existing;
    const rebound = db
      .update(importKeys)
      .set({
        recordId: normalized.recordId,
        version: existing.version + 1,
        updatedAt: now(),
      })
      .where(
        and(
          eq(importKeys.id, existing.id),
          eq(importKeys.version, existing.version),
        ),
      )
      .returning()
      .get();
    if (rebound === undefined) {
      throw new ImportKeyLifecycleError(
        `import key ${normalized.source}/${normalized.naturalKey} changed while it was being rebound`,
      );
    }
    return rebound;
  }

  function list(seasonId: number): ImportKey[] {
    return db
      .select()
      .from(importKeys)
      .where(eq(importKeys.seasonId, seasonId))
      .orderBy(asc(importKeys.id))
      .all();
  }

  return Object.freeze({ bind, rebind, find, findSeason, list });
}

export type ImportKeyRepository = ReturnType<typeof createImportKeyRepository>;
