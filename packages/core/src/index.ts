export type {
  AdapterPorts,
  AntibotClientChallenge,
  AntibotPort,
  AntibotRequest,
  AntibotResult,
  BoundingBox,
  CoordinatePrecision,
  Coordinates,
  EmailDeliveryResult,
  EmailMessage,
  EmailPort,
  GeocodeRequest,
  GeoPort,
  LocateCandidate,
  LocateOutcome,
  LocateRequest,
} from "./ports/index.js";
export {
  EARTH_RADIUS_METERS,
  assertBoundingBox,
  boundingBoxContains,
  haversineDistanceMeters,
  isValidCoordinate,
  verifyGeocodedCoordinate,
  verifyOrganizerCoordinate,
  type AcceptedCoordinatePrecision,
  type CoordinateGateRejectionCode,
  type CoordinateRejection,
  type CoordinateSource,
  type CoordinateVerdict,
  type CoordinateVerificationOptions,
  type GeocodeCandidate,
  type OrganizerCoordinate,
  type VerifiedCoordinate,
} from "./geo-verify.js";
export {
  CORE_DATABASE_FILENAME,
  openCoreDatabase,
  type CoreDatabaseConnection,
} from "./storage/connection.js";
export {
  seasonStates,
  coordinatePrecisions,
  coordinateRejectionCodes,
  coordinateSources,
  coordinateStatuses,
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  type Act,
  type ActLink,
  type Assignment,
  type CoordinateRejectionCode,
  type Season,
  type Slot,
  type Venue,
  type VenueCoordinate,
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
  type PriorSeasonContact,
  type ReleasedSlotHold,
  type SeasonAction,
  type SeasonRepositoryOptions,
  type SeasonState,
  type SlotHold,
} from "./season.js";
export {
  applyContactAddressChange,
  createOutboxRepository,
  OutboxConflictError,
  OutboxLifecycleError,
  type AdHocWaveInput,
  type ContactAddressChange,
  type EditMessageInput,
  type ExportedMessage,
  type GeneratedWave,
  type GenerateWaveInput,
  type OutboxMessageView,
  type OutboxPorts,
  type OutboxRepository,
  type OutboxRepositoryOptions,
  type SendRecipientOutcome,
  type SendReport,
  type SendSelectionInput,
} from "./outbox.js";
export {
  CRLF,
  encodeHeaderValue,
  encodeQuotedPrintable,
  formatRfc5322Date,
  isPrintableAscii,
} from "./mime.js";
export {
  renderEml,
  renderWave,
  textToHtml,
  waveTemplateKeys,
  waveTemplates,
  WaveTemplateError,
  type RenderContext,
  type RenderedWave,
  type WavePlaceholder,
  type WaveTemplateKey,
} from "./waves.js";
export type {
  OutboxMessage,
  OutboxMessageState,
  OutboxRecipient,
  OutboxRecipientRule,
  OutboxRecordType,
  OutboxSendOutcome,
  OutboxWave,
  OutboxWaveKind,
  OutboxWaveStatus,
} from "./storage/schema.js";
export {
  outboxMessageStates,
  outboxRecipientRules,
  outboxWaveKinds,
} from "./storage/schema.js";
export {
  formatZonedWindow,
  overlaps,
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
  createGeocodingRepository,
  GeocodingConflictError,
  GeocodingLifecycleError,
  MAX_CROSS_CHECK_DISTANCE_M,
  seasonBoundingBox,
  type GeocodingActor,
  type GeocodingPorts,
  type GeocodingRepository,
  type GeocodingRepositoryOptions,
  type GeocodeVenueResult,
  type VenueCoordinateReview,
} from "./geocoding.js";
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
import {
  createOutboxRepository,
  type OutboxRepository,
  type OutboxRepositoryOptions,
} from "./outbox.js";
import {
  createGeocodingRepository,
  type GeocodingRepository,
} from "./geocoding.js";
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
  readonly outbox: OutboxRepository;
  readonly geocoding: GeocodingRepository;
}

export interface CoreOptions {
  readonly retention?: RetentionRepositoryOptions;
  readonly outbox?: OutboxRepositoryOptions;
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
    // The outbox is handed only the email port: core generates and stores, and
    // the adapter is reached exactly once, inside an explicit send.
    outbox: createOutboxRepository(
      database,
      { email: ports.email },
      options.outbox,
    ),
    geocoding: createGeocodingRepository(database, { geo: ports.geo }),
  });
}
