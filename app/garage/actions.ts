"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { garage, publicSearch } from "@/server/services";

const vehicleFields = z.object({ variantId: z.string().default(""), year: z.string().default(""), nickname: z.string().optional() });
const id = z.object({ id: z.string().min(1) });

export const addVehicle = defineAction({ input: vehicleFields, access: "member" }, async (input, ctx) => {
  await garage.add(ctx.user.id, input);
  revalidatePath("/garage");
  redirect("/garage");
});

export const updateVehicle = defineAction({ input: vehicleFields.extend(id.shape), access: "member" }, async ({ id: vehicleId, ...input }, ctx) => {
  await garage.update(ctx.user.id, vehicleId, input);
  revalidatePath("/garage");
  redirect("/garage");
});

export const setPrimaryVehicle = defineAction({ input: id, access: "member" }, async (input, ctx) => {
  await garage.setPrimary(ctx.user.id, input.id);
  revalidatePath("/garage");
  return { ok: true, message: "Primary bike changed" };
});

export const removeVehicle = defineAction({ input: id, access: "member" }, async (input, ctx) => {
  await garage.remove(ctx.user.id, input.id);
  revalidatePath("/garage");
  return { ok: true, message: "Bike removed" };
});

// ── saved searches (M6) ──
export const setSearchAlerts = defineAction({ input: z.object({ id: z.string().min(1), enabled: z.enum(["true", "false"]) }), access: "member" }, async (input, ctx) => {
  await publicSearch.setAlerts(ctx.user.id, input.id, input.enabled === "true");
  revalidatePath("/garage/searches");
  return { ok: true, message: input.enabled === "true" ? "Alerts turned on" : "Alerts turned off" };
});

export const deleteSavedSearch = defineAction({ input: id, access: "member" }, async (input, ctx) => {
  await publicSearch.deleteSearch(ctx.user.id, input.id);
  revalidatePath("/garage/searches");
  return { ok: true, message: "Saved search deleted" };
});
