export type { Coordinates, GeocodeRequest, GeoPort } from "@porchfest/core";

import type { GeocodeRequest, GeoPort } from "@porchfest/core";

export class NullGeoAdapter implements GeoPort {
  readonly name = "none";
  readonly configured = false;

  async geocode(_request: GeocodeRequest) {
    return null;
  }
}
