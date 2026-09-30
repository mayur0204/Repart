"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { inspections } from "@/server/services";

/** Admin garage and Partner Check assignment actions (PLAN.md §4.8 /admin/mechanics). Every change is audited in the service. */
const ADMIN = ["ADMIN"] as const;

export const saveGarage = defineAction({ input: z.record(z.string(), z.string()), access: ADMIN }, async (input, ctx) => {
  const id = await inspections.saveGarage({ userId: ctx.user.id, requestId: ctx.requestId }, input);
  revalidatePath("/admin/mechanics");
  if (!input.id) redirect(`/admin/mechanics/${id}`);
  revalidatePath(`/admin/mechanics/${id}`);
  return { ok: true, message: "Garage saved" };
});

export const linkMechanic = defineAction({ input: z.object({ partnerId: z.string().min(1).max(64), phone: z.string().max(20) }), access: ADMIN }, async (input, ctx) => {
  await inspections.linkMechanic({ userId: ctx.user.id, requestId: ctx.requestId }, input);
  revalidatePath(`/admin/mechanics/${input.partnerId}`);
  return { ok: true, message: "Mechanic linked" };
});

export const setStaffActive = defineAction(
  { input: z.object({ staffId: z.string().min(1).max(64), partnerId: z.string().min(1).max(64), active: z.enum(["true", "false"]) }), access: ADMIN },
  async (input, ctx) => {
    await inspections.setStaffActive({ userId: ctx.user.id, requestId: ctx.requestId }, input.staffId, input.active === "true");
    revalidatePath(`/admin/mechanics/${input.partnerId}`);
    return { ok: true, message: input.active === "true" ? "Mechanic activated" : "Mechanic deactivated" };
  },
);

export const reassignInspection = defineAction({ input: z.record(z.string(), z.string()), access: ADMIN }, async (input, ctx) => {
  await inspections.reassign({ userId: ctx.user.id, requestId: ctx.requestId }, input);
  revalidatePath("/admin/mechanics");
  return { ok: true, message: "Partner Check booked" };
});
