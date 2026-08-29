import {
  formatZonedWindow,
  type Act,
  type CoreRuntime,
  type Season,
  type SeasonTimeSlot,
  type Slot,
} from "@porchfest/core";
import {
  loadVerifiedVenuesMapSchema,
  porchfestMapScriptPath,
  porchfestMapStylesheetPath,
  validateVenuesMapDocument,
  VENUES_MAP_SCHEMA_VERSION,
  type VenueMapAct,
  type VenueMapLink,
  type VenuesMapDocument,
} from "@porchfest/map";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import type { RouteRegistry } from "../router/registry.js";

export const MAP_PAGE_PATH = "/map";
export const MAP_DATA_PATH = "/map/data.json";
export const MAP_SCRIPT_PATH = "/map/assets/porchfest-map.js";
export const MAP_STYLESHEET_PATH = "/map/assets/porchfest-map.css";

const MAP_CACHE_CONTROL = "public, max-age=300";
const MAP_ASSET_CACHE_CONTROL = "public, max-age=86400";
const EMPTY_MAP_DOCUMENT: VenuesMapDocument = {
  schema_version: VENUES_MAP_SCHEMA_VERSION,
  season: 2000,
  generated_from: "packages/web/src/routes/map.ts",
  event: {
    date: "2000-01-01",
    time: "Not published",
    city: "Not published",
    state: "Not published",
  },
  venues: [],
};

const mapScript = readFileSync(porchfestMapScriptPath, "utf8");
const mapStylesheet = readFileSync(porchfestMapStylesheetPath, "utf8");

export function registerMapRoutes(options: {
  readonly core: CoreRuntime;
  readonly routes: RouteRegistry;
}): void {
  options.routes.register({
    method: "GET",
    path: MAP_PAGE_PATH,
    tier: "public",
    handler: () => mapPage(),
  });

  options.routes.register({
    method: "GET",
    path: MAP_DATA_PATH,
    tier: "public",
    handler: () => mapData(options.core),
  });

  options.routes.register({
    method: "GET",
    path: MAP_SCRIPT_PATH,
    tier: "public",
    handler: (context: Context) =>
      context.body(mapScript, 200, {
        "cache-control": MAP_ASSET_CACHE_CONTROL,
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
      }),
  });

  options.routes.register({
    method: "GET",
    path: MAP_STYLESHEET_PATH,
    tier: "public",
    handler: (context: Context) =>
      context.body(mapStylesheet, 200, {
        "cache-control": MAP_ASSET_CACHE_CONTROL,
        "content-type": "text/css; charset=utf-8",
        "x-content-type-options": "nosniff",
      }),
  });
}

function mapData(core: CoreRuntime): Response {
  try {
    const season = core.setup.listSeasons()[0];
    const document =
      season?.state === "locked" && season.mapPublishedAt !== null
        ? publishedMapDocument(core, season)
        : EMPTY_MAP_DOCUMENT;

    // Five minutes limits the address-withdrawal window without turning every
    // attendee refresh into a database hit; explicit unpublication is visible
    // after the same bounded interval.
    loadVerifiedVenuesMapSchema();
    const validation = validateVenuesMapDocument(document);
    if (!validation.ok) {
      const reasons = validation.errors
        .map(({ path, message }) => `${path} ${message}`)
        .join("; ");
      console.error(`venues-map validation failed: ${reasons}`);
      return invalidMapResponse();
    }

    return new Response(JSON.stringify(validation.document), {
      status: 200,
      headers: {
        "cache-control": MAP_CACHE_CONTROL,
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`venues-map generation failed: ${reason}`);
    return invalidMapResponse();
  }
}

function publishedMapDocument(
  core: CoreRuntime,
  season: Season,
): VenuesMapDocument {
  const templates = core.setup.listTimeSlots(season.id);
  const slots = core.seasons.listSeasonSlots(season.id);
  const slotsById = new Map(slots.map((slot) => [slot.id, slot]));
  const assignmentsBySlot = new Map(
    core.seasons
      .listAssignments(season.id)
      .map((assignment) => [assignment.slotId, assignment] as const),
  );

  const venues = core.seasons
    .listSeasonVenues(season.id)
    .filter(
      (venue) =>
        venue.status !== "withdrawn" && venue.canonicalVenueId === null,
    )
    .flatMap((venue) => {
      const coordinate = core.geocoding.publishableCoordinate(venue.id);
      if (coordinate === null) return [];

      const acts = core.seasons.listVenueSlots(venue.id).flatMap((slot) => {
        if (slot.state !== "assigned") return [];
        const assignment = assignmentsBySlot.get(slot.id);
        if (assignment === undefined) return [];
        const act = core.seasons.getAct(assignment.actId);
        if (act.status === "withdrawn" || act.canonicalActId !== null) {
          return [];
        }
        return [publishedAct(season, templates, slot, act)];
      });
      if (acts.length === 0) return [];

      // Named fields only: adding a column to Venue can never widen this public
      // response. The v1.3.0 contract carries city/state at event level and
      // rejects them as per-venue additional properties.
      return [
        {
          title: venue.title,
          address: venue.address ?? "",
          lat: coordinate.latitude,
          lng: coordinate.longitude,
          schedule: [...new Set(acts.map((act) => act.slot_label))].join(" · "),
          acts,
        },
      ];
    });

  for (const assignment of assignmentsBySlot.values()) {
    if (!slotsById.has(assignment.slotId)) {
      throw new Error(
        `assignment ${assignment.id} does not belong to a current season slot`,
      );
    }
  }

  return {
    schema_version: VENUES_MAP_SCHEMA_VERSION,
    season: season.year,
    generated_from: "packages/web/src/routes/map.ts",
    event: {
      date: season.eventDate ?? "",
      time:
        templates.length === 0
          ? "Schedule not published"
          : formatZonedWindow(
              {
                startsAt: templates[0]!.startsAt,
                endsAt: templates.at(-1)!.endsAt,
              },
              season.timezone,
            ),
      city: season.eventCity,
      state: season.eventState,
    },
    venues,
  };
}

function publishedAct(
  season: Season,
  templates: readonly SeasonTimeSlot[],
  slot: Slot,
  act: Act,
): VenueMapAct {
  const template = templates.find(
    (candidate) =>
      candidate.startsAt.getTime() === slot.startsAt.getTime() &&
      candidate.endsAt.getTime() === slot.endsAt.getTime(),
  );
  if (template === undefined) {
    throw new Error(
      `slot ${slot.id} does not match a configured season time slot`,
    );
  }
  const label = formatZonedWindow(template, season.timezone);
  return {
    slot: String(template.position),
    slot_label: label,
    slot_start: rfc3339Time(template.startsAt),
    slot_end: rfc3339Time(template.endsAt),
    name: act.name,
    genre: act.genre ?? "",
    description: act.description ?? "",
    links: publicLinks(act.links),
  };
}

function rfc3339Time(value: Date): string {
  return `${value.toISOString().slice(11, 19)}Z`;
}

function publicLinks(value: string | null): VenueMapLink[] {
  if (value === null) return [];
  return value
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((candidate) => {
      try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") return [];
        return [{ url: url.toString() }];
      } catch {
        return [];
      }
    });
}

function invalidMapResponse(): Response {
  return new Response("Map data is temporarily unavailable.", {
    status: 500,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function mapPage(): Response {
  // Leaflet is intentionally CDN-loaded: it is a browser dependency, not a
  // Node dependency. CSP admits exactly that version host and OSM's tile host.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Porchfest map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIINfQ3MZ8LB6qABFkCjoLJkD4JpD2GkPz9I=" crossorigin="anonymous">
  <link rel="stylesheet" href="${MAP_STYLESHEET_PATH}">
  <script defer src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="anonymous"></script>
  <script defer src="${MAP_SCRIPT_PATH}" data-map-url="${MAP_DATA_PATH}"></script>
</head>
<body>
  <main>
    <header class="porchfest-map-header">
      <p class="eyebrow">Porchfest</p>
      <h1>Performance map</h1>
    </header>
    <div class="porchfest-map-mount">
      <div class="porchfest-map-fullbleed">
        <p class="porchfest-map-status is-empty">No map is published yet. Please check back closer to the event.</p>
        <div class="porchfest-map-canvas" hidden aria-label="Porchfest venue map"></div>
      </div>
      <section class="porchfest-venue-list" hidden aria-labelledby="porchfest-lineup-title">
        <h2 id="porchfest-lineup-title">Venue lineup</h2>
        <ol class="porchfest-venue-list-items"></ol>
      </section>
    </div>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "public, max-age=300",
      "content-security-policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; connect-src 'self'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
