export type {
  AdapterPorts,
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

import type { AdapterPorts } from "./ports/index.js";
import type { CoreDatabase } from "./storage/repository-errors.js";

export interface CoreRuntime {
  readonly database: CoreDatabase;
  readonly ports: AdapterPorts;
}

export function createCore(
  ports: AdapterPorts,
  database: CoreDatabase,
): CoreRuntime {
  return Object.freeze({ database, ports: Object.freeze({ ...ports }) });
}
