"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { orders } from "@/server/services";

/**
 * Checkout actions (PLAN.md §4.5). The browser sends only listing, address and the optional check;
 * every amount is recomputed on the server. The result carries only what the provider's browser
 * checkout needs (Cashfree payment_session_id, or the mock checkout URL).
 */
export const startCheckout = defineAction(
  { input: z.object({ listingId: z.string().min(1).max(64), addressId: z.string().max(64).optional(), withCheck: z.string().max(8).optional() }), access: "member" },
  async (input, ctx) => {
    const actor = { userId: ctx.user.id, requestId: ctx.requestId };
    const { orderId } = await orders.place(actor, input);
    const session = await orders.pay(actor, orderId);
    return { ok: true, data: { orderId, paymentSessionId: session.paymentSessionId, checkoutUrl: session.checkoutUrl } };
  },
);

/** Pay again for the buyer's own order while it is still waiting for payment (failed or abandoned attempt). */
export const retryPayment = defineAction({ input: z.object({ orderId: z.string().min(1).max(64) }), access: "member" }, async (input, ctx) => {
  const session = await orders.pay({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId);
  return { ok: true, data: { orderId: input.orderId, paymentSessionId: session.paymentSessionId, checkoutUrl: session.checkoutUrl } };
});

/** Dev mock checkout only (refused unless PAYMENT_PROVIDER=mock and not production). */
export const mockCheckout = defineAction(
  { input: z.object({ orderId: z.string().min(1).max(64), outcome: z.enum(["SUCCESS", "FAILED", "USER_DROPPED"]) }), access: "member" },
  async (input, ctx) => {
    if (process.env.NODE_ENV === "production") return { ok: false, message: "Not available." };
    await orders.mockPay(ctx.user.id, input.orderId, input.outcome);
    redirect(`/checkout/return?order=${encodeURIComponent(input.orderId)}`);
  },
);
