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
  venueAmenityValues,
  venueDrinkValues,
  venueGearValues,
  type Season,
} from "./storage/schema.js";
export {
  createSeasonRepository,
  isSeasonActionLegal,
  SeasonActionError,
  SeasonConflictError,
  SeasonLifecycleError,
  type AssignmentCorrection,
  type AssignmentSuggestion,
  type PriorSeasonContact,
  type ReleasedSlotHold,
  type SeasonAction,
  type SeasonRepositoryOptions,
  type SeasonState,
  type SlotHold,
} from "./season.js";
export type {
  HostSignup,
  HostSignupInput,
  PerformerSignup,
  PerformerSignupInput,
  SignupContactInput,
} from "./records.js";
export {
  isValidTimeZone,
  parseWallClock,
  zonedWallClockToUtc,
  type WallClockParts,
} from "./time.js";

import type { AdapterPorts } from "./ports/index.js";
import { createSeasonRepository } from "./season.js";
import type { CoreDatabase } from "./storage/repository-errors.js";

export type SeasonRepository = ReturnType<typeof createSeasonRepository>;

export interface CoreRuntime {
  readonly ports: AdapterPorts;
  readonly seasons: SeasonRepository;
}

export function createCore(
  ports: AdapterPorts,
  database: CoreDatabase,
): CoreRuntime {
  return Object.freeze({
    ports: Object.freeze({ ...ports }),
    seasons: createSeasonRepository(database),
  });
}
