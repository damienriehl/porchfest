import type { Season } from "@porchfest/core";

const SEASON_STATE_LABELS: Readonly<Record<Season["state"], string>> = {
  setup: "Preparing the season",
  signups_open: "Accepting signups",
  signups_closed: "Signups closed",
  assigning: "Building the schedule",
  locked: "Schedule confirmed",
  archived: "Season closed and archived",
};

export function seasonStateLabel(state: Season["state"]): string {
  return SEASON_STATE_LABELS[state];
}
