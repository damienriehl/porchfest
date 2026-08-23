export type { EmailDeliveryResult, EmailMessage, EmailPort } from "./email.js";
export type {
  AntibotClientChallenge,
  AntibotPort,
  AntibotRequest,
  AntibotResult,
} from "./antibot.js";
export type { Coordinates, GeocodeRequest, GeoPort } from "./geo.js";

import type { AntibotPort } from "./antibot.js";
import type { EmailPort } from "./email.js";
import type { GeoPort } from "./geo.js";

export interface AdapterPorts {
  readonly email: EmailPort;
  readonly antibot: AntibotPort;
  readonly geo: GeoPort;
}
