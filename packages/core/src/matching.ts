export interface MatchingSlot {
  id: number;
  venueId: number;
  startsAt: Date;
  endsAt: Date;
  state: "open" | "held" | "assigned";
}

export interface MatchingVenue {
  id: number;
  title: string;
  hostName: string | null;
  hasPower: boolean | null;
  requestedActNames: string | null;
  genrePreferences: string | null;
  slots: MatchingSlot[];
}

export interface MatchingAct {
  id: number;
  name: string;
  genre: string | null;
  requiresAmplification: boolean | null;
  housePreference: string | null;
  availabilities: { startsAt: Date; endsAt: Date }[];
  linkedActIds: number[];
}

export interface MatchingAssignment {
  actId: number;
  slotId: number;
}

export interface MatchingInput {
  timezone: string;
  venues: MatchingVenue[];
  acts: MatchingAct[];
  assignments: MatchingAssignment[];
}

export interface SuggestionReason {
  code: string;
  text: string;
}

export interface RankedPairing {
  act: MatchingAct;
  slot: MatchingSlot;
  venue: MatchingVenue;
  score: number;
  reasons: SuggestionReason[];
  warnings: SuggestionReason[];
}

export type RankedSuggestion = RankedPairing & { isBestScoreTie: boolean };

function normalize(value: string): string {
  return value.toLocaleLowerCase("en").trim().replace(/\s+/g, " ");
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWords(value: string, words: string): boolean {
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escaped(words)}(?:$|[^\\p{L}\\p{N}])`,
    "u",
  ).test(value);
}

function names(haystack: string | null, candidate: string | null): boolean {
  if (haystack === null || candidate === null) return false;
  const normalizedCandidate = normalize(candidate);
  return haystack
    .split(/[,;\n]|\s+and\s+/i)
    .map(normalize)
    .filter(Boolean)
    .some((entry) => {
      if (entry === normalizedCandidate) return true;
      const entryCanAbbreviate = entry.length >= 4 || entry.includes(" ");
      return (
        (entryCanAbbreviate &&
          containsWholeWords(normalizedCandidate, entry)) ||
        containsWholeWords(entry, normalizedCandidate)
      );
    });
}

export function overlaps(
  left: { startsAt: Date; endsAt: Date },
  right: { startsAt: Date; endsAt: Date },
): boolean {
  return left.startsAt < right.endsAt && right.startsAt < left.endsAt;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();
const PERIOD_PATTERN = /\s([AP]M)$/;
const STRIP_PERIOD_PATTERN = /\s[AP]M$/;

function zonedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = zonedFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  zonedFormatters.set(timezone, formatter);
  return formatter;
}

export function formatZonedWindow(
  window: { startsAt: Date; endsAt: Date },
  timezone: string,
): string {
  const formatter = zonedFormatter(timezone);
  const start = formatter.format(window.startsAt);
  const end = formatter.format(window.endsAt);
  const startPeriod = start.match(PERIOD_PATTERN)?.[1];
  const endPeriod = end.match(PERIOD_PATTERN)?.[1];
  return `${startPeriod === endPeriod ? start.replace(STRIP_PERIOD_PATTERN, "") : start}–${end}`;
}

function genreMatch(
  preferences: string | null,
  genre: string | null,
): string | null {
  const tokens = normalize(genre ?? "")
    .split(/[,/]+|\s+/)
    .filter((token) => token.length >= 3);
  const clauses = normalize(preferences ?? "")
    .split(/[,;\n]+/)
    .filter(Boolean);
  for (const token of tokens) {
    for (const clause of clauses) {
      const match = new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escaped(token)}(?:$|[^\\p{L}\\p{N}])`,
        "u",
      ).exec(clause);
      if (!match) continue;
      const prefix = clause.slice(
        0,
        match.index + (match[0].startsWith(token) ? 0 : 1),
      );
      if (
        /\b(?:no|not|except|avoid|without)\b|\banything\s+but\b/.test(prefix)
      ) {
        continue;
      }
      return token;
    }
  }
  return null;
}

function comparePairings(left: RankedPairing, right: RankedPairing): number {
  return (
    right.score - left.score ||
    left.act.name.localeCompare(right.act.name, "en") ||
    left.act.id - right.act.id ||
    left.slot.startsAt.getTime() - right.slot.startsAt.getTime() ||
    left.slot.id - right.slot.id
  );
}

/**
 * Pure R8 ranking. Explicit availability windows are hard constraints; an act
 * that did not state any availability remains eligible everywhere and carries
 * an explicit reason so an organizer can see that uncertainty.
 */
export function rankPairings(input: MatchingInput): RankedPairing[] {
  const venuesBySlotId = new Map<number, MatchingVenue>();
  const slotsById = new Map<number, MatchingSlot>();
  for (const venue of input.venues) {
    for (const slot of venue.slots) {
      venuesBySlotId.set(slot.id, venue);
      slotsById.set(slot.id, slot);
    }
  }
  const actsById = new Map(input.acts.map((act) => [act.id, act]));
  const assignedActIds = new Set(input.assignments.map(({ actId }) => actId));
  const assignedSlotIds = new Set(
    input.assignments.map(({ slotId }) => slotId),
  );
  const assignmentsByActId = new Map<number, MatchingAssignment[]>();
  for (const assignment of input.assignments) {
    const assignments = assignmentsByActId.get(assignment.actId) ?? [];
    assignments.push(assignment);
    assignmentsByActId.set(assignment.actId, assignments);
  }
  for (const assignments of assignmentsByActId.values()) {
    assignments.sort((left, right) => {
      const leftSlot = slotsById.get(left.slotId);
      const rightSlot = slotsById.get(right.slotId);
      return (
        (leftSlot?.startsAt.getTime() ?? 0) -
          (rightSlot?.startsAt.getTime() ?? 0) || left.slotId - right.slotId
      );
    });
  }
  const pairings: RankedPairing[] = [];
  const formattedSlots = new Map<number, string>();
  for (const slot of slotsById.values()) {
    formattedSlots.set(slot.id, formatZonedWindow(slot, input.timezone));
  }

  for (const venue of input.venues) {
    for (const slot of venue.slots) {
      if (slot.state !== "open" || assignedSlotIds.has(slot.id)) continue;
      for (const act of input.acts) {
        if (assignedActIds.has(act.id)) continue;
        const availability = act.availabilities.find(
          (window) =>
            window.startsAt <= slot.startsAt && window.endsAt >= slot.endsAt,
        );
        if (act.availabilities.length > 0 && availability === undefined) {
          continue;
        }

        const reasons: SuggestionReason[] = [];
        const warnings: SuggestionReason[] = [];
        let score = 0;
        const hostAsked = names(venue.requestedActNames, act.name);
        const actAsked =
          names(act.housePreference, venue.title) ||
          names(act.housePreference, venue.hostName);
        if (hostAsked && actAsked) {
          score += 10_000;
          reasons.push({
            code: "mutual_request",
            text: "The host and act requested each other by name",
          });
        } else {
          if (hostAsked) {
            score += 3_000;
            reasons.push({
              code: "host_request",
              text: "Host asked for this act by name",
            });
          }
          if (actAsked) {
            score += 3_000;
            reasons.push({
              code: "act_request",
              text: "Act asked for this venue by name",
            });
          }
        }

        const genreToken = genreMatch(venue.genrePreferences, act.genre);
        if (genreToken !== null) {
          score += 50;
          reasons.push({
            code: "genre_fit",
            text: `Genre preference matches ${genreToken}`,
          });
        }

        if (act.requiresAmplification === true && venue.hasPower === false) {
          score -= 100;
          warnings.push({
            code: "no_power",
            text: "Act needs amplification, but the venue has no power",
          });
        } else if (
          act.requiresAmplification === true &&
          venue.hasPower === true
        ) {
          score += 20;
          reasons.push({
            code: "power_available",
            text: "Venue has power for this amplified act",
          });
        }

        if (availability === undefined) {
          reasons.push({
            code: "availability_unstated",
            text: "Availability was not stated",
          });
        } else {
          score += 5;
          reasons.push({
            code: "available",
            text: `Available ${formattedSlots.get(slot.id)}`,
          });
        }

        for (const linkedActId of act.linkedActIds) {
          const linkedAssignments = assignmentsByActId.get(linkedActId) ?? [];
          const linkedAct = actsById.get(linkedActId);
          let linkedActOverlaps = false;
          for (const linkedAssignment of linkedAssignments) {
            const linkedSlot = slotsById.get(linkedAssignment.slotId);
            const linkedVenue = venuesBySlotId.get(linkedAssignment.slotId);
            if (
              linkedSlot === undefined ||
              linkedVenue === undefined ||
              linkedAct === undefined ||
              !overlaps(linkedSlot, slot)
            ) {
              continue;
            }
            linkedActOverlaps = true;
            warnings.push({
              code: "shared_member",
              text: `${linkedAct.name} shares a member and plays at ${linkedVenue.title}, ${formattedSlots.get(linkedSlot.id)}`,
            });
          }
          if (linkedActOverlaps) {
            score -= 200;
          }
        }

        if (reasons.length === 0) {
          reasons.push({
            code: "slot_open",
            text: "Act and slot are both available",
          });
        }
        pairings.push({ act, slot, venue, score, reasons, warnings });
      }
    }
  }
  return pairings.sort(comparePairings);
}

export function suggestionsForVenue(
  input: MatchingInput,
  venueId: number,
): RankedSuggestion[] {
  return markBestScoreTies(
    rankPairings(input).filter(({ venue }) => venue.id === venueId),
    ({ slot }) => slot.id,
  );
}

export function suggestionsForAct(
  input: MatchingInput,
  actId: number,
): RankedSuggestion[] {
  return markBestScoreTies(
    rankPairings(input).filter(({ act }) => act.id === actId),
    ({ venue }) => venue.id,
  );
}

function markBestScoreTies(
  pairings: RankedPairing[],
  groupFor: (pairing: RankedPairing) => number,
): RankedSuggestion[] {
  const scoresByGroup = new Map<
    number,
    { bestScore: number; bestScoreCount: number }
  >();
  for (const pairing of pairings) {
    const group = groupFor(pairing);
    const scores = scoresByGroup.get(group);
    if (!scores || pairing.score > scores.bestScore) {
      scoresByGroup.set(group, {
        bestScore: pairing.score,
        bestScoreCount: 1,
      });
    } else if (pairing.score === scores.bestScore) {
      scores.bestScoreCount += 1;
    }
  }
  return pairings.map((pairing) => {
    const scores = scoresByGroup.get(groupFor(pairing));
    return {
      ...pairing,
      isBestScoreTie:
        scores !== undefined &&
        scores.bestScoreCount > 1 &&
        pairing.score === scores.bestScore,
    };
  });
}
