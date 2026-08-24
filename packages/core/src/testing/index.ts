// KTD2 keeps storage ownership inside core even when another package needs to
// prove what a real SQLite write persisted. This deliberately small test seam
// exposes only today's cross-package assertions, not a general SQL escape hatch.

import { eq, sql } from "drizzle-orm";
import {
  actAvailabilities,
  acts,
  changeRequests,
  slots,
  venueAmenities,
  venueDrinks,
  venueGear,
  type Act,
  type ActAvailability,
  type ChangeRequest,
  type Slot,
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

  function listRawActAvailabilities(
    actId: number,
  ): { readonly startsAt: number; readonly endsAt: number }[] {
    // KTD2: keep the raw epoch visible through core's test seam so a schema
    // codec change cannot make the write and read sides agree on the wrong unit.
    return db
      .select({
        startsAt: sql<number>`${actAvailabilities.startsAt}`,
        endsAt: sql<number>`${actAvailabilities.endsAt}`,
      })
      .from(actAvailabilities)
      .where(eq(actAvailabilities.actId, actId))
      .orderBy(actAvailabilities.id)
      .all();
  }

  function createSlot(input: {
    readonly seasonId: number;
    readonly venueId: number;
    readonly startsAt: Date;
    readonly endsAt: Date;
  }): Pick<Slot, "id" | "version"> {
    return db.insert(slots).values(input).returning().get();
  }

  function corruptChangeRequestProposal(
    id: number,
    proposedValue: string,
  ): void {
    db.update(changeRequests)
      .set({ proposedValue })
      .where(eq(changeRequests.id, id))
      .run();
  }

  function readChangeRequestStatus(
    id: number,
  ): Pick<ChangeRequest, "status"> | undefined {
    return db
      .select({ status: changeRequests.status })
      .from(changeRequests)
      .where(eq(changeRequests.id, id))
      .get();
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
    listRawActAvailabilities,
    createSlot,
    corruptChangeRequestProposal,
    readChangeRequestStatus,
    readAct,
  });
}

export type CoreTestingRepository = ReturnType<
  typeof createCoreTestingRepository
>;
