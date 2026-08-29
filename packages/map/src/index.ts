import { fileURLToPath } from "node:url";

export * from "./contract.js";

export type VenueMapActSlot = "6-7" | "7-8" | "6-8";

export interface VenueMapLink {
  label: string;
  url: string;
}

export interface VenueMapAct {
  slot: VenueMapActSlot;
  slot_label: string;
  name: string;
  genre: string;
  description: string;
  links: VenueMapLink[];
  note: string;
}

export interface VenueMapVenue {
  title: string;
  address: string;
  lat: number;
  lng: number;
  schedule: string;
  acts: VenueMapAct[];
}

/** The venues-map.v1 JSON contract consumed by the Porchfest map browser module. */
export interface VenuesMapV1 {
  venues: VenueMapVenue[];
}

export const porchfestMapScriptPath = fileURLToPath(
  new URL("../assets/porchfest-map.js", import.meta.url),
);

export const porchfestMapStylesheetPath = fileURLToPath(
  new URL("../assets/porchfest-map.css", import.meta.url),
);
