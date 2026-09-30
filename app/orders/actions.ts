"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { disputes, fulfilment } from "@/server/services";

/** Buyer and seller order actions (PLAN.md §5.2 O17, O18, O20, O23; reviews). Ownership and allowed states are checked in the services. */
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

/** O18 "Confirm it's OK". */
export const confirmReceived = defineAction({ input: z.object({ orderId }), access: "member" }, async (input, ctx) => {
  await disputes.accept({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId);
  revalidatePath(`/orders/${input.orderId}`);
  return { ok: true, message: "Thanks. The order is complete." };
});

/** O20 "Report a problem" (buyer). Photos are added on the dispute page. */
export const reportProblem = defineAction({ input: z.object({ orderId, reason: z.string().max(40).optional(), description: z.string().max(4000).optional() }), access: "member" }, async (input, ctx) => {
  await disputes.report({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason, description: input.description ?? "" });
  redirect(`/orders/${encodeURIComponent(input.orderId)}/dispute`);
});

/** Seller's response to a dispute (within 48 hours of the report). */
export const respondToDispute = defineAction({ input: z.object({ orderId, response: z.string().max(4000).optional() }), access: "member" }, async (input, ctx) => {
  await disputes.respond({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { response: input.response ?? "" });
  revalidatePath(`/orders/${input.orderId}/dispute`);
  revalidatePath(`/seller/orders/${input.orderId}`);
  return { ok: true, message: "Response sent to RePart." };
});

export const requestDisputePhoto = defineAction(
  { input: z.object({ disputeId: z.string().min(1).max(64), size: z.coerce.number().int(), type: z.string().max(40) }), access: "member" },
  async (input, ctx) => ({ ok: true, data: await disputes.requestEvidence({ userId: ctx.user.id, requestId: ctx.requestId }, input) }),
);

export const confirmDisputePhoto = defineAction({ input: z.object({ evidenceId: z.string().min(1).max(64) }), access: "member" }, async (input, ctx) => {
  const r = await disputes.confirmEvidence({ userId: ctx.user.id, requestId: ctx.requestId }, input.evidenceId);
  return r === "ready" ? { ok: true } : { ok: false, message: "That file couldn't be used. Try another photo." };
});

export const leaveReview = defineAction({ input: z.object({ orderId, rating: z.string().max(2).optional(), text: z.string().max(4000).optional() }), access: "member" }, async (input, ctx) => {
  await disputes.review({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { rating: input.rating ?? "", text: input.text });
  revalidatePath(`/orders/${input.orderId}/review`);
  return { ok: true, message: "Thanks for your review." };
});
