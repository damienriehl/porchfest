import { fileURLToPath } from "node:url";
import type { VenuesMapDocument } from "./contract.js";

export * from "./contract.js";
export * from "./validate.js";

/** The venues-map.v1 JSON contract consumed by the Porchfest map browser module. */
export type VenuesMapV1 = Pick<VenuesMapDocument, "venues">;

export const porchfestMapScriptPath = fileURLToPath(
  new URL("../assets/porchfest-map.js", import.meta.url),
);

export const porchfestMapStylesheetPath = fileURLToPath(
  new URL("../assets/porchfest-map.css", import.meta.url),
);
