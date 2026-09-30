"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/server/http/define-action";
import { fulfilment, orders } from "@/server/services";

/** Admin money decisions on orders (PLAN.md §5.2 O21, O22, O24; §7.2 step 8). Amounts are validated and capped server-side. */
const ADMIN = ["ADMIN"] as const;
const orderId = z.string().min(1).max(64);
const decision = z.object({ orderId, reason: z.string().default(""), item: z.string().optional(), shipping: z.string().optional(), check: z.string().optional() });
/** Blank amount fields mean "everything still refundable" for that component. */
const amounts = (i: { item?: string; shipping?: string; check?: string }) => ({
  ...(i.item ? { item: i.item } : {}),
  ...(i.shipping ? { shipping: i.shipping } : {}),
  ...(i.check ? { check: i.check } : {}),
});

export const cancelAndRefund = defineAction({ input: decision, access: ADMIN }, async (input, ctx) => {
  await orders.adminCancel({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason, ...amounts(input) });
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: "Order cancelled; refund queued" };
});

export const refundCancelledOrder = defineAction({ input: decision, access: ADMIN }, async (input, ctx) => {
  await orders.adminRefund({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason, ...amounts(input) });
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: "Refund queued" };
});

export const resolveOrderDispute = defineAction({ input: decision.extend({ decision: z.enum(["REFUND", "RELEASE"]) }), access: ADMIN }, async (input, ctx) => {
  await orders.resolveDispute({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { decision: input.decision, reason: input.reason, ...amounts(input) });
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: input.decision === "REFUND" ? "Resolved with a refund" : "Resolved; payout release queued" };
});

export const recheckPayment = defineAction({ input: z.object({ orderId }), access: ADMIN }, async (input) => {
  const r = await orders.confirm(input.orderId);
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: `Order is ${r.state.toLowerCase().replace(/_/g, " ")}` };
});

export const runReconciliationNow = defineAction({ input: z.object({}), access: ADMIN }, async () => {
  const r = await orders.reconcile();
  revalidatePath("/admin/reconciliation");
  return { ok: true, message: `Checked ${r.checked} payments, ${r.mismatches} mismatches` };
});

export const markMismatchResolved = defineAction({ input: z.object({ id: z.string().min(1).max(64) }), access: ADMIN }, async (input, ctx) => {
  await orders.resolveMismatch(ctx.user.id, input.id);
  revalidatePath("/admin/reconciliation");
  return { ok: true, message: "Marked resolved" };
});

/** O25 after review: the courier reported a failed/returned delivery and the admin confirms the part is back with the seller. */
export const confirmDeliveryReturn = defineAction({ input: z.object({ orderId, reason: z.string().default(""), returned: z.string().optional() }), access: ADMIN }, async (input, ctx) => {
  await fulfilment.adminConfirmReturn({ userId: ctx.user.id, requestId: ctx.requestId }, input.orderId, { reason: input.reason, returned: input.returned });
  revalidatePath(`/admin/orders/${input.orderId}`);
  return { ok: true, message: "Return confirmed; order cancelled and refund queued" };
});

/** Dev only (PLAN.md §1.3): push a signed mock courier event through the real tracking webhook handler. */
export const advanceShipment = defineAction(
  { input: z.object({ orderId, status: z.enum(["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURNED"]) }), access: ADMIN },
  async (input) => {
    if (process.env.NODE_ENV === "production") return { ok: false, message: "Not available." };
    const r = await fulfilment.devAdvance(input.orderId, input.status);
    revalidatePath(`/admin/orders/${input.orderId}`);
    return { ok: r.status === 200, message: `Courier event ${input.status.toLowerCase().replace(/_/g, " ")}: ${r.outcome}` };
  },
);
