// KTD2 keeps storage ownership inside core even when another package needs to
// prove what a real SQLite write persisted. This deliberately small test seam
// exposes only today's cross-package assertions, not a general SQL escape hatch.

import { eq } from "drizzle-orm";
import {
  actAvailabilities,
  acts,
  venueAmenities,
  venueDrinks,
  venueGear,
  type Act,
  type ActAvailability,
  type VenueAmenity,
  type VenueDrink,
  type VenueGear,
} from "../storage/schema.js";
import type { CoreExecutor } from "../storage/repository-errors.js";

export function createCoreTestingRepository(db: CoreExecutor) {
  function listVenueGear(venueId: number): Pick<VenueGear, "value">[] {
    return db
      .select({ value: venueGear.value })
      .from(venueGear)
      .where(eq(venueGear.venueId, venueId))
      .orderBy(venueGear.id)
      .all();
  }

  function listVenueDrinks(venueId: number): Pick<VenueDrink, "value">[] {
    return db
      .select({ value: venueDrinks.value })
      .from(venueDrinks)
      .where(eq(venueDrinks.venueId, venueId))
      .orderBy(venueDrinks.id)
      .all();
  }

  function listVenueAmenities(venueId: number): Pick<VenueAmenity, "value">[] {
    return db
      .select({ value: venueAmenities.value })
      .from(venueAmenities)
      .where(eq(venueAmenities.venueId, venueId))
      .orderBy(venueAmenities.id)
      .all();
  }

  function listActAvailabilities(
    actId: number,
  ): Pick<ActAvailability, "startsAt" | "endsAt">[] {
    return db
      .select({
        startsAt: actAvailabilities.startsAt,
        endsAt: actAvailabilities.endsAt,
      })
      .from(actAvailabilities)
      .where(eq(actAvailabilities.actId, actId))
      .orderBy(actAvailabilities.id)
      .all();
  }

  function readAct(actId: number): Pick<Act, "notes"> | undefined {
    return db
      .select({ notes: acts.notes })
      .from(acts)
      .where(eq(acts.id, actId))
      .get();
  }

  return Object.freeze({
    listVenueGear,
    listVenueDrinks,
    listVenueAmenities,
    listActAvailabilities,
    readAct,
  });
}

export type CoreTestingRepository = ReturnType<
  typeof createCoreTestingRepository
>;
