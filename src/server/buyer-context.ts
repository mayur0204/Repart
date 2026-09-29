import "server-only";
import { getCurrentUser } from "./auth/current";
import { addresses, garage, publicSearch } from "./services";
import type { Vehicle } from "./services/search/fit";

/**
 * The bike and pincode used for fit and distance on public pages:
 * the URL (?vehicle=&year=, ?pin=) first, then the signed-in member's primary garage bike and
 * default address. Anonymous visitors without URL values get no bike (fit bar: "Add your bike").
 */
export async function buyerContext(params: { vehicle?: string; year?: number; pin?: string }) {
  const user = await getCurrentUser();
  let vehicle: Vehicle | null = null;
  let fromGarage = false;
  if (params.vehicle) vehicle = await publicSearch.resolveVehicle(params.vehicle, params.year);
  else if (user) {
    const primary = (await garage.list(user.id)).find((v) => v.isPrimary);
    if (primary) {
      vehicle = await publicSearch.resolveVehicle(primary.variantId, primary.year);
      fromGarage = true;
    }
  }
  let pincode = params.pin ?? null;
  if (!pincode && user) pincode = (await addresses.list(user.id)).find((a) => a.isDefault)?.pincode ?? null;
  return { user, vehicle, fromGarage, pincode };
}
