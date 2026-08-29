import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { VenueMapActSlot } from "./index.js";

export const VENUES_MAP_SCHEMA_VERSION = "1.2.0";

export const VENUES_MAP_GENERATED_FROM = [
  "porchfest/tools/render.py",
  "packages/web/src/routes/map.ts",
] as const;

export type VenuesMapGeneratedFrom = (typeof VENUES_MAP_GENERATED_FROM)[number];

interface VenuesMapDocumentLink {
  label?: string;
  url: string;
}

interface VenuesMapDocumentAct {
  slot: VenueMapActSlot;
  slot_label: string;
  name: string;
  genre: string;
  description: string;
  links: VenuesMapDocumentLink[];
  note?: string;
}

interface VenuesMapDocumentVenue {
  title: string;
  address: string;
  lat: number;
  lng: number;
  schedule: string;
  acts: VenuesMapDocumentAct[];
}

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
  venues: VenuesMapDocumentVenue[];
}

export const venuesMapSchemaPath = fileURLToPath(
  new URL("../schemas/venues-map.v1.schema.json", import.meta.url),
);

export const venuesMapSchemaDigestPath = fileURLToPath(
  new URL("../schemas/venues-map.v1.sha256", import.meta.url),
);

export function readVenuesMapSchemaSource(): string {
  return readFileSync(venuesMapSchemaPath, "utf8");
}

export function readPinnedVenuesMapSchemaDigest(): string {
  const digest = readFileSync(venuesMapSchemaDigestPath, "utf8")
    .trim()
    .split(/\s+/, 1)[0];

  if (digest === undefined || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      `invalid venues-map schema digest pin at ${venuesMapSchemaDigestPath}`,
    );
  }

  return digest;
}

export function assertVenuesMapSchemaDigest(
  source = readVenuesMapSchemaSource(),
): void {
  const expectedDigest = readPinnedVenuesMapSchemaDigest();
  const actualDigest = createHash("sha256")
    .update(source, "utf8")
    .digest("hex");

  if (actualDigest !== expectedDigest) {
    throw new Error(
      `venues-map schema digest mismatch: expected ${expectedDigest}, received ${actualDigest}`,
    );
  }
}
