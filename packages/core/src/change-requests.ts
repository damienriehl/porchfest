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
  readonly applicable: boolean;
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

export class ChangeRequestTargetConflictError extends RepositoryConflictError<ChangeRequestRecordType> {
  constructor(
    recordType: ChangeRequestRecordType,
    recordId: number,
    conflictingFields: readonly string[],
  ) {
    super(
      "ChangeRequestTargetConflictError",
      recordType,
      recordId,
      conflictingFields,
    );
  }
}

export function createChangeRequestRepository(
  db: CoreExecutor,
  options: RepositoryOptions = {},
) {
  const now = options.now ?? (() => new Date());

  function decode(
    executor: CoreExecutor,
    row: ChangeRequest,
  ): ParticipantChangeRequest {
    const applicable = targetMatches(executor, row);
    if (row.kind === "withdrawal") {
      if (row.proposedValue !== null) {
        throw new ChangeRequestLifecycleError(
          `change request ${row.id} has an invalid withdrawal proposal`,
        );
      }
      return {
        ...row,
        proposedAddress: null,
        proposedAvailability: null,
        applicable,
      };
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
        applicable,
      };
    }
    if (
      row.kind !== "availability" ||
      row.recordType !== "act" ||
      row.proposedValue === null
    ) {
      throw new ChangeRequestLifecycleError(
        `change request ${row.id} has an invalid availability proposal`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.proposedValue);
    } catch {
      throw new ChangeRequestLifecycleError(
        `change request ${row.id} has an invalid availability proposal`,
      );
    }
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
    return {
      ...row,
      proposedAddress: null,
      proposedAvailability,
      applicable,
    };
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
    return row ? decode(executor, row) : null;
  }

  function find(id: number): ParticipantChangeRequest | null {
    return findWith(db, id);
  }

  function targetMatches(
    executor: CoreExecutor,
    request: Pick<
      ChangeRequest,
      "seasonId" | "recordType" | "recordId" | "recordVersion"
    >,
  ): boolean {
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
    return Boolean(
      target &&
      target.seasonId === request.seasonId &&
      target.version === request.recordVersion &&
      target.canonicalId === null,
    );
  }

  function targetFor(
    executor: CoreExecutor,
    request: Pick<
      ParticipantChangeRequest,
      "id" | "seasonId" | "recordType" | "recordId" | "recordVersion"
    >,
  ): void {
    if (!targetMatches(executor, request)) {
      throw new ChangeRequestConflictError(request.id, ["recordVersion"]);
    }
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
    const serializedProposal = proposedValue(input);
    return db.transaction(
      (tx) => {
        if (!targetMatches(tx, input)) {
          throw new ChangeRequestTargetConflictError(
            input.recordType,
            input.recordId,
            ["recordVersion"],
          );
        }
        const existing = tx
          .select()
          .from(changeRequests)
          .where(
            and(
              eq(changeRequests.seasonId, input.seasonId),
              eq(changeRequests.recordType, input.recordType),
              eq(changeRequests.recordId, input.recordId),
              eq(changeRequests.recordVersion, input.recordVersion),
              eq(changeRequests.kind, input.kind),
              serializedProposal === null
                ? isNull(changeRequests.proposedValue)
                : eq(changeRequests.proposedValue, serializedProposal),
              eq(changeRequests.status, "pending"),
            ),
          )
          .orderBy(desc(changeRequests.id))
          .limit(1)
          .get();
        if (existing) return decode(tx, existing);

        const stamp = now();
        const row = tx
          .insert(changeRequests)
          .values({
            seasonId: input.seasonId,
            recordType: input.recordType,
            recordId: input.recordId,
            recordVersion: input.recordVersion,
            kind: input.kind,
            proposedValue: serializedProposal,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .returning()
          .get();
        return decode(tx, row);
      },
      { behavior: "immediate" },
    );
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
      .flatMap((row) => {
        try {
          return [decode(db, row)];
        } catch (error) {
          // R33's queue must remain usable when a non-core writer left one
          // malformed proposal behind. Direct lookups remain strict.
          if (error instanceof ChangeRequestLifecycleError) return [];
          throw error;
        }
      });
  }

  function claim(
    executor: CoreExecutor,
    id: number,
    expectedVersion: number,
    status: "applied" | "rejected",
    seasonId?: number,
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
          seasonId === undefined
            ? undefined
            : eq(changeRequests.seasonId, seasonId),
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
          if (request.kind === "address") {
            throw new ChangeRequestLifecycleError(
              `address change request ${id} must be completed through the address review flow`,
            );
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
            // R33: availability is the participant-proposed equivalent of the
            // organizer edit, so it must share that edit's season gate. The
            // empty change set deliberately leaves KTD7's version verdict in
            // the mutation that bumps the act before replacing its windows.
            createSeasonRepository(tx, { now }).updateAct(
              request.recordId,
              request.recordVersion,
              {},
            );
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
                .onConflictDoNothing()
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

  function completeAddressReview(
    id: number,
    expectedVersion: number,
  ): ParticipantChangeRequest {
    return db.transaction(
      (tx) => {
        const request = findWith(tx, id);
        if (!request) {
          throw new ChangeRequestConflictError(id, ["version"]);
        }
        if (request.kind !== "address") {
          throw new ChangeRequestLifecycleError(
            `change request ${id} is not an address review`,
          );
        }
        // R33: the editor save legitimately moved the venue version, so this
        // completion consumes only the still-pending request's KTD7 token.
        claim(tx, id, expectedVersion, "applied");
        const applied = findWith(tx, id);
        if (!applied) {
          throw new ChangeRequestConflictError(id, ["version"]);
        }
        return applied;
      },
      { behavior: "immediate" },
    );
  }

  function reject(
    id: number,
    expectedVersion: number,
    seasonId?: number,
  ): ParticipantChangeRequest {
    return db.transaction(
      (tx) => {
        // R33: rejection is the recovery path for an undecodable proposal, so
        // it consumes the KTD7 token without decoding proposed_value first.
        claim(tx, id, expectedVersion, "rejected", seasonId);
        const rejected = tx
          .select()
          .from(changeRequests)
          .where(eq(changeRequests.id, id))
          .get();
        if (!rejected) {
          throw new ChangeRequestConflictError(id, ["version"]);
        }
        try {
          return decode(tx, rejected);
        } catch (error) {
          if (!(error instanceof ChangeRequestLifecycleError)) throw error;
          return {
            ...rejected,
            proposedAddress: null,
            proposedAvailability: null,
            applicable: targetMatches(tx, rejected),
          };
        }
      },
      { behavior: "immediate" },
    );
  }

  return Object.freeze({
    record,
    find,
    listPendingForSeason,
    apply,
    completeAddressReview,
    reject,
  });
}

export type ChangeRequestRepository = ReturnType<
  typeof createChangeRequestRepository
>;
