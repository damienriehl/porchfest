export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface BoundingBox {
  readonly north: number;
  readonly south: number;
  readonly east: number;
  readonly west: number;
}

export type CoordinatePrecision = "parcel" | "house" | "street";

export interface LocateCandidate extends Coordinates {
  readonly precision: CoordinatePrecision;
  readonly interpolated: boolean;
  readonly ref: string;
}

/**
 * The season policy travels with every lookup. Fields remain optional only so
 * adapters may support constructor defaults for narrow legacy callers; core's
 * geocoding pipeline always supplies the season row's values per call.
 */
export interface LocateRequest {
  readonly address: string;
  readonly boundingBox?: BoundingBox;
  readonly localityName?: string;
}

export type GeocodeRequest = LocateRequest;

export type LocateOutcome =
  | {
      readonly kind: "located";
      readonly candidate: LocateCandidate;
      readonly crossCheck: Coordinates | null;
      readonly reason: string;
    }
  | { readonly kind: "not-found"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GeoPort {
  readonly name: string;
  readonly configured: boolean;
  locate(request: LocateRequest): Promise<LocateOutcome>;
  geocode(request: GeocodeRequest): Promise<Coordinates | null>;
}
