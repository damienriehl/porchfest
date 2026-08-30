import { and, asc, eq } from "drizzle-orm";
import {
  annotations,
  type Annotation,
  type QueueRecordType,
} from "./storage/schema.js";
import {
  type CoreExecutor,
  RepositoryLifecycleError,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

export interface AnnotationTarget {
  readonly seasonId: number;
  readonly recordType: QueueRecordType;
  readonly recordId: number;
  readonly note: string;
}

export interface AnnotateResult {
  readonly annotation: Annotation;
  readonly created: boolean;
}

export class AnnotationLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("AnnotationLifecycleError", message);
  }
}

export function createAnnotationRepository(
  db: CoreExecutor,
  options: RepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function annotate(input: AnnotationTarget): AnnotateResult {
    const note = input.note.trim();
    if (!note) {
      throw new AnnotationLifecycleError("annotation note must be non-empty");
    }
    const existing = db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.seasonId, input.seasonId),
          eq(annotations.recordType, input.recordType),
          eq(annotations.recordId, input.recordId),
          eq(annotations.note, note),
        ),
      )
      .get();
    if (existing !== undefined) {
      return { annotation: existing, created: false };
    }
    const stamp = now();
    const annotation = db
      .insert(annotations)
      .values({
        ...input,
        note,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    return { annotation, created: true };
  }

  function listAnnotations(
    seasonId: number,
    recordType?: QueueRecordType,
    recordId?: number,
  ): Annotation[] {
    return db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.seasonId, seasonId),
          recordType === undefined
            ? undefined
            : eq(annotations.recordType, recordType),
          recordId === undefined
            ? undefined
            : eq(annotations.recordId, recordId),
        ),
      )
      .orderBy(asc(annotations.id))
      .all();
  }

  return Object.freeze({ annotate, listAnnotations });
}

export type AnnotationRepository = ReturnType<
  typeof createAnnotationRepository
>;
