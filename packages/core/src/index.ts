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
} from './ports/index.js';

import type { AdapterPorts } from './ports/index.js';

export interface CoreRuntime {
  readonly ports: AdapterPorts;
}

export function createCore(ports: AdapterPorts): CoreRuntime {
  return Object.freeze({ ports: Object.freeze({ ...ports }) });
}
