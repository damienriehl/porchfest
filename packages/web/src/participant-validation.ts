type ParticipantValues = Readonly<Record<string, readonly string[]>>;

interface ParticipantValidationError {
  readonly field: string;
  readonly label: string;
  readonly message: string;
}

/** Longest a participant answer may be, by field. Without a ceiling one 51 KiB
 * body of "&" persists in full and re-renders as ~256 KiB of "&amp;". */
const PARTICIPANT_FIELD_MAX_LENGTH: Readonly<Record<string, number>> = {
  contact_name: 200,
  contact_email: 320,
  contact_phone: 60,
  venue_title: 200,
  venue_address: 300,
  space_description: 4000,
  requested_act_names: 2000,
  genre_preferences: 2000,
  notes: 4000,
  participant_notes: 4000,
  act_name: 200,
  genres: 300,
  description: 4000,
  links: 2000,
  house_preference: 2000,
  shared_member_note: 2000,
  performer_notes: 4000,
  duration_minutes: 10,
  season_id: 20,
  antibot_token: 4096,
};
const DEFAULT_PARTICIPANT_FIELD_MAX_LENGTH = 300;

export const MIN_SET_DURATION_MINUTES = 5;
export const MAX_SET_DURATION_MINUTES = 240;
export const SET_DURATION_ERROR_MESSAGE = `Enter a set duration from ${MIN_SET_DURATION_MINUTES} to ${MAX_SET_DURATION_MINUTES} minutes.`;

export type FieldLengthResult =
  | { readonly ok: true; readonly values: ParticipantValues }
  | {
      readonly ok: false;
      readonly values: ParticipantValues;
      readonly error: ParticipantValidationError;
    };

export function enforceParticipantFieldLengths(
  values: ParticipantValues,
): FieldLengthResult {
  for (const [field, submitted] of Object.entries(values)) {
    const limit =
      PARTICIPANT_FIELD_MAX_LENGTH[field] ??
      DEFAULT_PARTICIPANT_FIELD_MAX_LENGTH;
    if (submitted.some((entry) => entry.length > limit)) {
      return {
        ok: false,
        // Never echo an over-limit value back into the response page.
        values: without(values, field),
        error: {
          field,
          label: "Submission",
          message: `Shorten this answer to ${limit} characters or fewer.`,
        },
      };
    }
  }
  return { ok: true, values };
}

export function parseSetDurationMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isSafeInteger(value) &&
    value >= MIN_SET_DURATION_MINUTES &&
    value <= MAX_SET_DURATION_MINUTES
    ? value
    : null;
}

function without(values: ParticipantValues, field: string): ParticipantValues {
  const copy: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const [name, entry] of Object.entries(values)) {
    if (name !== field) copy[name] = entry;
  }
  return copy;
}
