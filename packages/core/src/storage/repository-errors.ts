import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export class RepositoryConflictError<RecordType extends string> extends Error {
  readonly recordType: RecordType;
  readonly recordId: number;
  readonly conflictingFields: readonly string[];

  constructor(
    name: string,
    recordType: RecordType,
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    const fields =
      conflictingFields.length > 0 ? conflictingFields : ["version"];
    super(`${recordType} ${recordId} conflict: ${fields.join(", ")}`);
    this.name = name;
    this.recordType = recordType;
    this.recordId = recordId;
    this.conflictingFields = fields;
  }
}

export class RepositoryLifecycleError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export interface RepositoryOptions {
  now?: () => Date;
}

export type CoreDatabase = BetterSQLite3Database<typeof schema>;

type ConflictErrorConstructor<RecordType extends string> = new (
  recordType: RecordType,
  recordId: number,
  conflictingFields: readonly string[],
) => RepositoryConflictError<RecordType>;

export function conflict<RecordType extends string>(
  ErrorType: ConflictErrorConstructor<RecordType>,
  recordType: RecordType,
  recordId: number,
  fields: readonly string[],
): never {
  throw new ErrorType(recordType, recordId, fields);
}
