import {
  VENUES_MAP_SCHEMA_VERSION,
  type VenuesMapDocument,
} from "../src/contract.js";

type VenuesMapDocumentOverrides = Partial<
  Omit<VenuesMapDocument, "event" | "venues">
> & {
  event?: Partial<VenuesMapDocument["event"]>;
  venues?: VenuesMapDocument["venues"];
};

export function makeVenuesMapDocument(
  overrides: VenuesMapDocumentOverrides = {},
): VenuesMapDocument {
  const document: VenuesMapDocument = {
    schema_version: VENUES_MAP_SCHEMA_VERSION,
    season: 2027,
    generated_from: "packages/web/src/routes/map.ts",
    event: {
      date: "2027-05-22",
      time: "1-5 PM",
      city: "Exampleton",
      state: "WI",
    },
    venues: [
      {
        title: "Synthetic venue",
        address: "Redacted fixture location",
        lat: 12.34,
        lng: 56.78,
        schedule: "afternoon-1",
        acts: [
          {
            slot: "afternoon-1",
            slot_label: "afternoon-1",
            name: "Synthetic act",
            genre: "Experimental",
            description: "Synthetic deployment-neutral fixture.",
            links: [{ url: "https://example.invalid/act" }],
          },
        ],
      },
    ],
  };

  return {
    ...document,
    ...overrides,
    event: { ...document.event, ...overrides.event },
    venues: overrides.venues ?? document.venues,
  };
}
