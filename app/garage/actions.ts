"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { garage } from "@/server/services";

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
