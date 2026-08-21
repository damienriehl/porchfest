export interface GeocodeRequest {
  readonly address: string;
}

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeoPort {
  readonly name: string;
  readonly configured: boolean;
  geocode(request: GeocodeRequest): Promise<Coordinates | null>;
}
