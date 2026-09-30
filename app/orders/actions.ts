"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { fulfilment } from "@/server/services";

/** Buyer order actions (PLAN.md §5.2 O17, O23). Ownership and allowed states are checked in the service. */
const orderId = z.string().min(1).max(64);

export const cancelOrder = defineAction({ input: z.object({ orderId, reason: z.string().max(300).optional() }), access: "member" }, async (input, ctx) => {
  await fulfilment.buyerCancel({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason });
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, message: "Order cancelled. Your refund is on its way." };
});

export const confirmHandover = defineAction({ input: z.object({ orderId }), access: "member" }, async (input, ctx) => {
  await fulfilment.confirmHandover({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId);
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, message: "Handover confirmed." };
});
