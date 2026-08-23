// R33's participant-proposed, organizer-decided schedule changes. A proposal
// owns two KTD7 tokens: its own version prevents double decisions, and the
// captured record version prevents accepting a request against a changed target.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createSeasonRepository } from "./season.js";
import {
  acts,
  actAvailabilities,
  changeRequests,
  venues,
  type ChangeRequest,
  type ChangeRequestRecordType,
} from "./storage/schema.js";
import {
  type CoreExecutor,
  RepositoryConflictError,
  RepositoryLifecycleError,
  type RepositoryOptions,
} from "./storage/repository-errors.js";

export interface ProposedAvailabilityWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

type BaseRecordInput = {
  readonly seasonId: number;
  readonly recordId: number;
  readonly recordVersion: number;
};

export type RecordChangeRequestInput =
  | (BaseRecordInput & {
      readonly recordType: ChangeRequestRecordType;
      readonly kind: "withdrawal";
    })
  | (BaseRecordInput & {
      readonly recordType: "act";
      readonly kind: "availability";
      readonly proposedAvailability: readonly ProposedAvailabilityWindow[];
    })
  | (BaseRecordInput & {
      readonly recordType: "venue";
      readonly kind: "address";
      readonly proposedAddress: string;
    });

export type ParticipantChangeRequest = ChangeRequest & {
  readonly proposedAddress: string | null;
  readonly proposedAvailability: readonly ProposedAvailabilityWindow[] | null;
};

export class ChangeRequestConflictError extends RepositoryConflictError<"change_request"> {
  constructor(id: number, conflictingFields: readonly string[]) {
    super(
      "ChangeRequestConflictError",
      "change_request",
      id,
      conflictingFields,
    );
  }
}

export class ChangeRequestLifecycleError extends RepositoryLifecycleError {
  constructor(message: string) {
    super("ChangeRequestLifecycleError", message);
  }
}

export function createChangeRequestRepository(
  db: CoreExecutor,
  options: RepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function decode(row: ChangeRequest): ParticipantChangeRequest {
    if (row.kind === "withdrawal") {
      return { ...row, proposedAddress: null, proposedAvailability: null };
    }
    if (row.kind === "address") {
      if (row.recordType !== "venue" || row.proposedValue === null) {
        throw new ChangeRequestLifecycleError(
          `change request ${row.id} has an invalid address proposal`,
        );
      }
      return {
        ...row,
        proposedAddress: row.proposedValue,
        proposedAvailability: null,
      };
    }
    if (row.recordType !== "act" || row.proposedValue === null) {
      throw new ChangeRequestLifecycleError(
        `change request ${row.id} has an invalid availability proposal`,
      );
    }
    const parsed: unknown = JSON.parse(row.proposedValue);
    if (!Array.isArray(parsed)) {
      throw new ChangeRequestLifecycleError(
        `change request ${row.id} has an invalid availability proposal`,
      );
    }
    const proposedAvailability = parsed.map(
      (window): ProposedAvailabilityWindow => {
        if (!window || typeof window !== "object") {
          throw new ChangeRequestLifecycleError(
            `change request ${row.id} has an invalid availability proposal`,
          );
        }
        const candidate = window as Record<string, unknown>;
        const startsAt = new Date(String(candidate.startsAt ?? ""));
        const endsAt = new Date(String(candidate.endsAt ?? ""));
        if (
          !Number.isFinite(startsAt.valueOf()) ||
          !Number.isFinite(endsAt.valueOf()) ||
          startsAt >= endsAt
        ) {
          throw new ChangeRequestLifecycleError(
            `change request ${row.id} has an invalid availability proposal`,
          );
        }
        return { startsAt, endsAt };
      },
    );
    return { ...row, proposedAddress: null, proposedAvailability };
  }

  function findWith(
    executor: CoreExecutor,
    id: number,
  ): ParticipantChangeRequest | null {
    const row = executor
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.id, id))
      .get();
    return row ? decode(row) : null;
  }

  function find(id: number): ParticipantChangeRequest | null {
    return findWith(db, id);
  }

  function targetFor(
    executor: CoreExecutor,
    request: Pick<
      ParticipantChangeRequest,
      "id" | "seasonId" | "recordType" | "recordId" | "recordVersion"
    >,
  ) {
    const target =
      request.recordType === "act"
        ? executor
            .select({
              id: acts.id,
              seasonId: acts.seasonId,
              version: acts.version,
              canonicalId: acts.canonicalActId,
            })
            .from(acts)
            .where(eq(acts.id, request.recordId))
            .get()
        : executor
            .select({
              id: venues.id,
              seasonId: venues.seasonId,
              version: venues.version,
              canonicalId: venues.canonicalVenueId,
            })
            .from(venues)
            .where(eq(venues.id, request.recordId))
            .get();
    if (
      !target ||
      target.seasonId !== request.seasonId ||
      target.version !== request.recordVersion ||
      target.canonicalId !== null
    ) {
      throw new ChangeRequestConflictError(request.id, ["recordVersion"]);
    }
    return target;
  }

  function proposedValue(input: RecordChangeRequestInput): string | null {
    if (input.kind === "withdrawal") return null;
    if (input.kind === "address") {
      const address = input.proposedAddress.trim();
      if (!address) {
        throw new ChangeRequestLifecycleError(
          "an address proposal cannot be empty",
        );
      }
      return address;
    }
    for (const window of input.proposedAvailability) {
      if (
        !Number.isFinite(window.startsAt.valueOf()) ||
        !Number.isFinite(window.endsAt.valueOf()) ||
        window.startsAt >= window.endsAt
      ) {
        throw new ChangeRequestLifecycleError(
          "an availability proposal contains an invalid window",
        );
      }
    }
    return JSON.stringify(
      input.proposedAvailability.map(({ startsAt, endsAt }) => ({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      })),
    );
  }

  function record(input: RecordChangeRequestInput): ParticipantChangeRequest {
    targetFor(db, { ...input, id: 0 });
    const stamp = now();
    const row = db
      .insert(changeRequests)
      .values({
        seasonId: input.seasonId,
        recordType: input.recordType,
        recordId: input.recordId,
        recordVersion: input.recordVersion,
        kind: input.kind,
        proposedValue: proposedValue(input),
        createdAt: stamp,
        updatedAt: stamp,
      })
      .returning()
      .get();
    return decode(row);
  }

  function listPendingForSeason(seasonId: number): ParticipantChangeRequest[] {
    return db
      .select()
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.seasonId, seasonId),
          eq(changeRequests.status, "pending"),
        ),
      )
      .orderBy(desc(changeRequests.createdAt), desc(changeRequests.id))
      .all()
      .map(decode);
  }

  function claim(
    executor: CoreExecutor,
    id: number,
    expectedVersion: number,
    status: "applied" | "rejected",
  ): void {
    const result = executor
      .update(changeRequests)
      .set({
        status,
        version: sql`${changeRequests.version} + 1`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(changeRequests.id, id),
          eq(changeRequests.version, expectedVersion),
          eq(changeRequests.status, "pending"),
        ),
      )
      .run();
    // KTD7: both organizers can read pending, but only this affected-row verdict
    // may decide which one actually consumed the request.
    if (result.changes !== 1) {
      throw new ChangeRequestConflictError(id, ["status"]);
    }
  }

  function apply(
    id: number,
    expectedVersion: number,
  ): ParticipantChangeRequest {
    try {
      return db.transaction(
        (tx) => {
          const request = findWith(tx, id);
          if (!request) {
            throw new ChangeRequestConflictError(id, ["version"]);
          }
          claim(tx, id, expectedVersion, "applied");
          targetFor(tx, request);

          if (request.kind === "withdrawal") {
            // AE2 stays centralized in setRecordStatus: withdrawing here must
            // reopen assignments exactly like an organizer editor withdrawal.
            createSeasonRepository(tx, { now }).setRecordStatus(
              request.recordType,
              request.recordId,
              request.recordVersion,
              "withdrawn",
            );
          } else if (request.kind === "availability") {
            const changed = tx
              .update(acts)
              .set({
                version: sql`${acts.version} + 1`,
                updatedAt: now(),
              })
              .where(
                and(
                  eq(acts.id, request.recordId),
                  eq(acts.version, request.recordVersion),
                  eq(acts.seasonId, request.seasonId),
                  isNull(acts.canonicalActId),
                ),
              )
              .run();
            if (changed.changes !== 1) {
              throw new ChangeRequestConflictError(id, ["recordVersion"]);
            }
            tx.delete(actAvailabilities)
              .where(eq(actAvailabilities.actId, request.recordId))
              .run();
            const windows = request.proposedAvailability ?? [];
            if (windows.length > 0) {
              const stamp = now();
              tx.insert(actAvailabilities)
                .values(
                  windows.map(({ startsAt, endsAt }) => ({
                    seasonId: request.seasonId,
                    actId: request.recordId,
                    startsAt,
                    endsAt,
                    createdAt: stamp,
                    updatedAt: stamp,
                  })),
                )
                .run();
            }
          }

          const applied = findWith(tx, id);
          if (!applied) {
            throw new ChangeRequestConflictError(id, ["version"]);
          }
          return applied;
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (
        error instanceof RepositoryConflictError &&
        !(error instanceof ChangeRequestConflictError)
      ) {
        throw new ChangeRequestConflictError(id, ["recordVersion"]);
      }
      throw error;
    }
  }

  function reject(
    id: number,
    expectedVersion: number,
  ): ParticipantChangeRequest {
    return db.transaction(
      (tx) => {
        claim(tx, id, expectedVersion, "rejected");
        const rejected = findWith(tx, id);
        if (!rejected) {
          throw new ChangeRequestConflictError(id, ["version"]);
        }
        return rejected;
      },
      { behavior: "immediate" },
    );
  }

  return Object.freeze({ record, find, listPendingForSeason, apply, reject });
}

export type ChangeRequestRepository = ReturnType<
  typeof createChangeRequestRepository
>;
