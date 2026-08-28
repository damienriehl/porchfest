export type {
  AdapterPorts,
  AntibotClientChallenge,
  AntibotPort,
  AntibotRequest,
  AntibotResult,
  Coordinates,
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
  GeocodeRequest,
  GeoPort,
} from "./ports/index.js";
export {
  CORE_DATABASE_FILENAME,
  openCoreDatabase,
  type CoreDatabaseConnection,
} from "./storage/connection.js";
export {
  seasonStates,
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  type Act,
  type ActLink,
  type Assignment,
  type Season,
  type Slot,
  type Venue,
} from "./storage/schema.js";
export {
  AssignmentConflictError,
  createSeasonRepository,
  isSeasonActionLegal,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  type AssignmentConflictKind,
  type AssignmentCorrection,
  type AssignmentSuggestion,
  type PriorSeasonContact,
  type ReleasedSlotHold,
  type SeasonAction,
  type SeasonRepositoryOptions,
  type SeasonState,
  type SlotHold,
} from "./season.js";
export {
  formatZonedWindow,
  rankPairings,
  suggestionsForAct,
  suggestionsForVenue,
  type MatchingAct,
  type MatchingAssignment,
  type MatchingInput,
  type MatchingSlot,
  type MatchingVenue,
  type RankedPairing,
  type SuggestionReason,
} from "./matching.js";
export type {
  CreatePlaceholderActInput,
  CreatePlaceholderVenueInput,
  HostSignup,
  HostSignupInput,
  ManualPlaceholderContactInput,
  PerformerSignup,
  PerformerSignupInput,
  PlaceholderReachInput,
  SignupContactInput,
} from "./records.js";
export { RecordLifecycleError } from "./records.js";
export {
  AccessError,
  createAccessRepository,
  DEFAULT_BOOTSTRAP_TTL_MS,
  DEFAULT_INVITE_TTL_MS,
  DEFAULT_SESSION_ABSOLUTE_TTL_MS,
  DEFAULT_SESSION_IDLE_TTL_MS,
  hashToken,
  type AccessFailure,
  type AccessRepository,
  type AccessRepositoryOptions,
  type IssuedLink,
  type IssuedSession,
} from "./access.js";
export type {
  Organizer,
  OrganizerInvite,
  OrganizerInviteKind,
  OrganizerSession,
} from "./storage/schema.js";
export { RepositoryConflictError } from "./storage/repository-errors.js";
export {
  ChangeRequestConflictError,
  ChangeRequestLifecycleError,
  ChangeRequestTargetConflictError,
  createChangeRequestRepository,
  type ChangeRequestRepository,
  type ParticipantChangeRequest,
  type ProposedAvailabilityWindow,
  type RecordChangeRequestInput,
} from "./change-requests.js";
export {
  createQueueRepository,
  type QueueItem,
  type QueueRecord,
  type QueueRepository,
} from "./queue.js";
export {
  ANONYMIZED_ANNOTATION_NOTE,
  ANONYMIZED_CONTACT_NAME,
  createRetentionRepository,
  DEFAULT_RETENTION_MONTHS,
  normalizeRetentionMonths,
  RetentionConflictError,
  RetentionLifecycleError,
  type AnonymizationResult,
  type AnonymizeParticipantInput,
  type RetentionRepository,
  type RetentionRepositoryOptions,
} from "./retention.js";
export type {
  ChangeRequest,
  ChangeRequestKind,
  ChangeRequestRecordType,
  ChangeRequestStatus,
  QueueDismissal,
  QueueRecordType,
  RecordStatus,
  DeletionReceipt,
  DeletionReceiptAction,
  DeletionReceiptBackupStatus,
} from "./storage/schema.js";
export { recordStatuses } from "./storage/schema.js";
export {
  createSeasonSetup,
  SeasonSetupError,
  type SeasonSetupInput,
  type SeasonSetupRepository,
  type SeasonSetupResult,
  type TimeSlotInput,
} from "./setup.js";
export type { SeasonTimeSlot } from "./storage/schema.js";
export {
  isValidTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
  type WallClockParts,
} from "./time.js";

import type { AdapterPorts } from "./ports/index.js";
import { createAccessRepository, type AccessRepository } from "./access.js";
import {
  createChangeRequestRepository,
  type ChangeRequestRepository,
} from "./change-requests.js";
import { createQueueRepository, type QueueRepository } from "./queue.js";
import {
  createRetentionRepository,
  type RetentionRepository,
  type RetentionRepositoryOptions,
} from "./retention.js";
import { createSeasonSetup, type SeasonSetupRepository } from "./setup.js";
import { createSeasonRepository } from "./season.js";
import type { CoreDatabase } from "./storage/repository-errors.js";

export type SeasonRepository = ReturnType<typeof createSeasonRepository>;

export interface CoreRuntime {
  readonly ports: AdapterPorts;
  readonly seasons: SeasonRepository;
  readonly access: AccessRepository;
  readonly setup: SeasonSetupRepository;
  readonly queue: QueueRepository;
  readonly changeRequests: ChangeRequestRepository;
  readonly retention: RetentionRepository;
}

export interface CoreOptions {
  readonly retention?: RetentionRepositoryOptions;
}

export function createCore(
  ports: AdapterPorts,
  database: CoreDatabase,
  options: CoreOptions = {},
): CoreRuntime {
  return Object.freeze({
    ports: Object.freeze({ ...ports }),
    seasons: createSeasonRepository(database),
    access: createAccessRepository(database),
    setup: createSeasonSetup(database),
    queue: createQueueRepository(database),
    changeRequests: createChangeRequestRepository(database),
    retention: createRetentionRepository(database, options.retention),
  });
}
