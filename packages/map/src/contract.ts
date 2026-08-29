import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const VENUES_MAP_SCHEMA_VERSION = "1.2.0";

export const VENUES_MAP_GENERATED_FROM = [
  "porchfest/tools/render.py",
  "packages/web/src/routes/map.ts",
] as const;

export type VenuesMapGeneratedFrom = (typeof VENUES_MAP_GENERATED_FROM)[number];

export type VenueMapActSlot = "6-7" | "7-8" | "6-8";

export interface VenueMapLink {
  label?: string;
  url: string;
}

export interface VenueMapAct {
  slot: VenueMapActSlot;
  slot_label: string;
  name: string;
  genre: string;
  description: string;
  links: VenueMapLink[];
  note?: string;
}

export interface VenueMapVenue {
  title: string;
  address: string;
  lat: number;
  lng: number;
  schedule: string;
  acts: VenueMapAct[];
}

/**
 * The complete venues-map document shape. Only `schema_version` and
 * `generated_from` are literal-typed on purpose; widening the season, event,
 * and schedule fields beyond the schema's Goal-1 consts remains a pending owner
 * decision.
 */
export interface VenuesMapDocument {
  schema_version: typeof VENUES_MAP_SCHEMA_VERSION;
  season: number;
  generated_from: VenuesMapGeneratedFrom;
  event: {
    date: string;
    time: string;
    city: string;
    state: string;
  };
  venues: VenueMapVenue[];
}

const venuesMapSchemaUrl = new URL(
  "../schemas/venues-map.v1.schema.json",
  import.meta.url,
);

const venuesMapSchemaDigestUrl = new URL(
  "../schemas/venues-map.v1.sha256",
  import.meta.url,
);

export function readVenuesMapSchemaSource(): string {
  return readFileSync(venuesMapSchemaUrl).toString("utf8");
}

export function computeVenuesMapSchemaDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readPinnedVenuesMapSchemaDigest(
  pinSource = readFileSync(venuesMapSchemaDigestUrl, "utf8"),
): string {
  const firstLine = pinSource.split(/\r?\n/, 1).at(0) ?? "";
  const normalizedFirstLine = firstLine.replace(/^[a-fA-F0-9]{64}/, (digest) =>
    digest.toLowerCase(),
  );
  const match = /^([a-f0-9]{64})\s+\*?venues-map\.v1\.schema\.json\s*$/.exec(
    normalizedFirstLine,
  );

  if (match === null) {
    throw new Error(
      `invalid venues-map schema digest pin: expected sha256sum format "<64 hex characters>  venues-map.v1.schema.json"; received first line ${JSON.stringify(firstLine)}`,
    );
  }

  return match[1] as string;
}

function verifyVenuesMapSchemaDigest(bytes: Buffer | string): string {
  const expectedDigest = readPinnedVenuesMapSchemaDigest();
  const actualDigest = computeVenuesMapSchemaDigest(bytes);

  if (actualDigest !== expectedDigest) {
    throw new Error(
      `venues-map schema digest mismatch: expected ${expectedDigest}, received ${actualDigest}`,
    );
  }

  return actualDigest;
}

export function assertVenuesMapSchemaDigest(
  source: Buffer | string = readFileSync(venuesMapSchemaUrl),
): void {
  verifyVenuesMapSchemaDigest(source);
}

type VerifiedVenuesMapSchema = {
  source: string;
  digest: string;
  schema: unknown;
};

let verifiedVenuesMapSchema: VerifiedVenuesMapSchema | undefined;

export function loadVerifiedVenuesMapSchema(): VerifiedVenuesMapSchema {
  if (verifiedVenuesMapSchema !== undefined) {
    return verifiedVenuesMapSchema;
  }

  const bytes = readFileSync(venuesMapSchemaUrl);
  const digest = verifyVenuesMapSchemaDigest(bytes);
  const source = bytes.toString("utf8");
  const schema: unknown = JSON.parse(source);
  verifiedVenuesMapSchema = { source, digest, schema };

  return verifiedVenuesMapSchema;
}
