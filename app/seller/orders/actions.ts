"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { fulfilment } from "@/server/services";

/** Seller order actions (PLAN.md §4.4, §5.2 O5–O7, O9, O12). Ownership is checked in the service. */
const orderId = z.string().min(1).max(64);

export const confirmOrder = defineAction({ input: z.object({ orderId, slot: z.string().max(40).optional() }), access: "member" }, async (input, ctx) => {
  const r = await fulfilment.confirm({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { slot: input.slot });
  revalidatePath(`/seller/orders/${input.orderId}`);
  return { ok: true, message: r.state === "PICKUP_SCHEDULED" ? "Confirmed. Pickup booked." : r.state === "AWAITING_HANDOVER" ? "Confirmed. Agree the handover in Messages." : "Confirmed. RePart will arrange the Partner Check." };
});

export const declineOrder = defineAction({ input: z.object({ orderId, reason: z.string().max(300).optional() }), access: "member" }, async (input, ctx) => {
  await fulfilment.decline({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason });
  revalidatePath(`/seller/orders/${input.orderId}`);
  return { ok: true, message: "Order declined. The buyer gets a full refund." };
});

export const bookPickup = defineAction({ input: z.object({ orderId, slot: z.string().max(40).optional() }), access: "member" }, async (input, ctx) => {
  await fulfilment.schedulePickup({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { slot: input.slot });
  revalidatePath(`/seller/orders/${input.orderId}`);
  return { ok: true, message: "Pickup booked." };
});
