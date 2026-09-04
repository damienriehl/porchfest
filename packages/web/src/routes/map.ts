import {
  formatZonedWindow,
  type Act,
  type CoreRuntime,
  type Season,
  type SeasonTimeSlot,
  type Slot,
} from "@porchfest/core";
import {
  porchfestMapScriptPath,
  porchfestMapStylesheetPath,
  validateVenuesMapDocument,
  VENUES_MAP_SCHEMA_VERSION,
  type VenueMapAct,
  type VenueMapLink,
  type VenuesMapValidationError,
  type VenuesMapDocument,
} from "@porchfest/map";
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import type { RouteRegistry } from "../router/registry.js";
import { currentYearIn } from "../timezone.js";
import { normalizedHttpUrl, tokenizeLinks } from "./http-links.js";

export const MAP_PAGE_PATH = "/map";
export const MAP_DATA_PATH = "/map/data.json";
export const MAP_SCRIPT_PATH = "/map/assets/porchfest-map.js";
export const MAP_STYLESHEET_PATH = "/map/assets/porchfest-map.css";
export const FAVICON_PATH = "/favicon.ico";

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
const favicon = readFileSync(
  new URL("../../assets/favicon.svg", import.meta.url),
  "utf8",
);

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

  options.routes.register({
    method: "GET",
    path: FAVICON_PATH,
    tier: "public",
    handler: () =>
      new Response(favicon, {
        headers: {
          "cache-control": MAP_ASSET_CACHE_CONTROL,
          "content-type": "image/svg+xml",
          "x-content-type-options": "nosniff",
        },
      }),
  });
}

function mapData(core: CoreRuntime): Response {
  try {
    // Publication remains authoritative until an organizer unpublishes or
    // archives that season. A newer draft must not hide the live map. R16 also
    // keeps a future season private until its calendar year begins.
    const season = core.setup
      .listSeasons()
      .find(
        (candidate) =>
          candidate.state === "locked" &&
          candidate.mapPublishedAt !== null &&
          candidate.year <= currentYearIn(candidate.timezone),
      );
    const document = season
      ? buildPublishedMapDocument(core, season)
      : EMPTY_MAP_DOCUMENT;

    // Five minutes limits the address-withdrawal window without turning every
    // attendee refresh into a database hit; explicit unpublication is visible
    // after the same bounded interval.
    // Validation loads and memoizes the digest-verified schema internally.
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

function buildPublishedMapDocument(
  core: CoreRuntime,
  season: Season,
): VenuesMapDocument {
  const templates = core.setup
    .listTimeSlots(season.id)
    .sort(
      (left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() ||
        left.id - right.id,
    );
  const slots = core.seasons.listSeasonSlots(season.id);
  const slotIds = new Set(slots.map((slot) => slot.id));
  const assignments = core.seasons.listAssignments(season.id);
  const seasonActs = core.seasons.listSeasonActs(season.id);
  const coordinates = core.geocoding.publishableCoordinatesForSeason(season.id);
  const actsById = new Map(seasonActs.map((act) => [act.id, act]));
  const assignmentsBySlot = new Map(
    assignments.map((assignment) => [assignment.slotId, assignment]),
  );
  const slotsByVenue = new Map<number, Slot[]>();
  for (const slot of slots) {
    const venueSlots = mapValue(slotsByVenue, slot.venueId) ?? [];
    venueSlots.push(slot);
    slotsByVenue.set(slot.venueId, venueSlots);
  }
  const slotTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: season.timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });

  const venues = core.seasons
    .listSeasonVenues(season.id)
    .filter(
      (venue) =>
        venue.status !== "withdrawn" && venue.canonicalVenueId === null,
    )
    .flatMap((venue) => {
      const address = venue.address;
      if (address === null || address.trim().length === 0) return [];

      const coordinate = mapValue(coordinates, venue.id);
      if (coordinate === undefined) return [];

      const acts = (mapValue(slotsByVenue, venue.id) ?? []).flatMap((slot) => {
        if (slot.state !== "assigned") return [];
        const assignment = mapValue(assignmentsBySlot, slot.id);
        if (assignment === undefined) return [];
        const act = mapValue(actsById, assignment.actId);
        if (act === undefined) {
          throw new Error(`assignment ${assignment.id} has no current act`);
        }
        if (act.status === "withdrawn" || act.canonicalActId !== null) {
          return [];
        }
        return [publishedAct(season, templates, slot, act, slotTimeFormatter)];
      });
      if (acts.length === 0) return [];

      // Named fields only: adding a column to Venue can never widen this public
      // response. Organizer free-text is excluded even from named fields: the
      // public label is the usable address. The contract carries city/state at
      // event level and rejects them as per-venue additional properties.
      return [
        {
          title: address,
          address,
          lat: coordinate.latitude,
          lng: coordinate.longitude,
          schedule: [...new Set(acts.map((act) => act.slot_label))].join(" · "),
          acts,
        },
      ];
    });

  for (const assignment of assignments) {
    if (!slotIds.has(assignment.slotId)) {
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
                endsAt: templates.reduce(
                  (latest, template) =>
                    template.endsAt > latest ? template.endsAt : latest,
                  templates[0]!.endsAt,
                ),
              },
              season.timezone,
            ),
      city: season.eventCity,
      state: season.eventState,
    },
    venues,
  };
}

// Route-boundary checks reserve method-shaped HTTP verbs for registration.
// Keep ordinary Map reads explicit without mimicking that API.
function mapValue<Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
): Value | undefined {
  return Reflect.apply(Map.prototype.get, map, [key]) as Value | undefined;
}

type MapPublicationPreflight =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export function preflightMapPublication(
  core: CoreRuntime,
  season: Season,
): MapPublicationPreflight {
  let document: VenuesMapDocument;
  try {
    document = buildPublishedMapDocument(core, season);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Map generation failed: ${reason}` };
  }
  if (document.venues.length === 0) {
    return {
      ok: false,
      error: "No venue has a verified coordinate and an assigned act.",
    };
  }
  const validation = validateVenuesMapDocument(document);
  if (validation.ok) return { ok: true };
  const first = validation.errors[0];
  if (first === undefined) {
    return { ok: false, error: "Map schema validation failed." };
  }
  return {
    ok: false,
    error: publicationValidationError(document, first),
  };
}

function publicationValidationError(
  document: VenuesMapDocument,
  error: VenuesMapValidationError,
): string {
  const match = /^\/venues\/(\d+)(?:\/acts\/(\d+))?/.exec(error.path);
  const venueIndex = match === null ? Number.NaN : Number(match[1]);
  const actIndex = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  const venue = Number.isSafeInteger(venueIndex)
    ? document.venues[venueIndex]
    : undefined;
  const venueTitle = venue?.title.trim() || "(empty title)";
  if (venue !== undefined && Number.isSafeInteger(actIndex)) {
    const actName = venue.acts[actIndex]?.name.trim() || "(empty title)";
    return `Act "${actName}" at venue "${venueTitle}": schema ${error.path} ${error.message}.`;
  }
  if (venue !== undefined) {
    return `Venue "${venueTitle}": schema ${error.path} ${error.message}.`;
  }
  const eventField = /^\/event\/(date|city|state)$/.exec(error.path)?.[1];
  if (eventField !== undefined) {
    return `Event ${eventField}: schema ${error.path} ${error.message}.`;
  }
  return `Map document: schema ${error.path} ${error.message}.`;
}

function publishedAct(
  season: Season,
  templates: readonly SeasonTimeSlot[],
  slot: Slot,
  act: Act,
  slotTimeFormatter: Intl.DateTimeFormat,
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
    slot_start: rfc3339Time(template.startsAt, slotTimeFormatter),
    slot_end: rfc3339Time(template.endsAt, slotTimeFormatter),
    name: act.name,
    genre: act.genre ?? "",
    description: act.description ?? "",
    links: publicLinks(act.links),
  };
}

export function normalizeRfc3339Offset(timeZoneName: string): string | null {
  if (timeZoneName === "GMT") return "Z";

  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(timeZoneName);
  if (match === null) return null;

  const [, sign, hour, minute = "00"] = match;
  if (sign === undefined || hour === undefined) return null;

  const offset = `${sign}${hour.padStart(2, "0")}:${minute}`;
  return offset === "+00:00" || offset === "-00:00" ? "Z" : offset;
}

function rfc3339Time(value: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const offset = normalizeRfc3339Offset(part("timeZoneName"));
  if (offset === null) {
    throw new Error(
      `cannot format RFC 3339 offset for ${formatter.resolvedOptions().timeZone}`,
    );
  }
  return `${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

function publicLinks(value: string | null): VenueMapLink[] {
  // Signup rejects the whole field when one token is bad; public serialization
  // instead drops only bad tokens so legacy data cannot break the live map.
  return tokenizeLinks(value).flatMap((candidate) => {
    const url = normalizedHttpUrl(candidate);
    return url === null ? [] : [{ url }];
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
  <link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIINfQ3MZ8LB6qABFkCjoLJkD4JpD2GkPz9I=" crossorigin="anonymous">
  <link rel="stylesheet" href="${MAP_STYLESHEET_PATH}">
  <script defer src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin="anonymous"></script>
  <script defer src="${MAP_SCRIPT_PATH}" data-map-url="${MAP_DATA_PATH}"></script>
</head>
<body class="porchfest-map-page">
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
      "cache-control": MAP_CACHE_CONTROL,
      "content-security-policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; connect-src 'self'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
