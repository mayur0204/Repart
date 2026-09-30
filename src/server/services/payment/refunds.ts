import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient, RefundStatus } from "@/generated/prisma/client";
import { CashfreeError } from "../../adapters/payment/cashfree-client";
import type { PaymentProvider, RefundState } from "../../adapters/payment/types";
import { UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { allocateRefund } from "../order/pricing";
import { enqueueOutbox } from "../outbox/outbox";
import { flagMismatch } from "./mismatch";

/**
 * Refunds (PLAN.md §7.2 step 7, §7.5). A refund is requested as components, allocated server-side,
 * capped against everything already refunded, stored with a unique idempotency key and sent to the
 * provider from a retryable job with that same key. Its status becomes SUCCESS only when the provider
 * confirms it (webhook or status query).
 *
 * Pre-settlement: the seller's portion is reversed from their split (`refund_splits`).
 * Post-settlement: the merchant funds everything and a SellerRecovery row records the seller's portion
 * for manual recovery [assumption A-8].
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { type: "USER" | "ADMIN" | "SYSTEM"; id: string | null };

export const refundComponents = z.object({
  item: z.number().int().min(0),
  shipping: z.number().int().min(0),
  check: z.number().int().min(0),
});
export type RefundComponents = z.infer<typeof refundComponents>;

const LIVE: RefundStatus[] = ["REQUESTED", "PENDING", "SUCCESS"];

/** Everything still refundable on the order, per component. */
export async function refundableComponents(tx: Pick<Tx, "order" | "refund">, orderId: string): Promise<RefundComponents> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { itemPricePaise: true, shippingFeePaise: true, checkFeePaise: true, payment: { select: { id: true } } } });
  const refunds = order.payment ? await tx.refund.findMany({ where: { paymentId: order.payment.id, status: { in: LIVE } }, select: { components: true } }) : [];
  const used = refunds.map((r) => refundComponents.parse(r.components)).reduce((a, c) => ({ item: a.item + c.item, shipping: a.shipping + c.shipping, check: a.check + c.check }), { item: 0, shipping: 0, check: 0 });
  return { item: order.itemPricePaise - used.item, shipping: order.shippingFeePaise - used.shipping, check: order.checkFeePaise - used.check };
}

/** Creates the Refund row (inside the caller's transaction) and queues sending it. Same key → same refund. */
export async function requestRefund(
  tx: Tx,
  input: { orderId: string; components: RefundComponents; reason: string; actor: Actor; idempotencyKey: string; requestId?: string },
): Promise<{ refundId: string; created: boolean }> {
  const existing = await tx.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (existing) return { refundId: existing.id, created: false };

  const c = refundComponents.parse(input.components);
  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { itemPricePaise: true, shippingFeePaise: true, checkFeePaise: true, platformFeePaise: true, vendorSharePaise: true, merchantSharePaise: true, totalPaise: true, sellerId: true, payment: true },
  });
  const payment = order.payment;
  if (!payment || payment.status !== "SUCCESS") throw new UserError("There is no captured payment on this order to refund.");
  const left = await refundableComponents(tx, input.orderId);
  if (c.item > left.item || c.shipping > left.shipping || c.check > left.check) throw new UserError("That is more than is left to refund on this order.");
  const alloc = allocateRefund(order, c, order.itemPricePaise - left.item);
  if (alloc.amountPaise <= 0) throw new UserError("Choose an amount to refund.");

  // §7.5 guarantees across all refunds on the payment.
  const prior = await tx.refund.aggregate({ where: { paymentId: payment.id, status: { in: LIVE } }, _sum: { amountPaise: true, vendorPortionPaise: true, merchantPortionPaise: true } });
  if ((prior._sum.amountPaise ?? 0) + alloc.amountPaise > order.totalPaise) throw new UserError("Refunds can't exceed what the buyer paid.");
  if ((prior._sum.vendorPortionPaise ?? 0) + alloc.vendorPortionPaise > order.vendorSharePaise) throw new UserError("Refunds can't exceed the seller's share.");
  if ((prior._sum.merchantPortionPaise ?? 0) + alloc.merchantPortionPaise > order.merchantSharePaise) throw new UserError("Refunds can't exceed RePart's share.");

  const afterSettlement = payment.vendorSettlementStatus === "SETTLED";
  const refund = await tx.refund.create({
    data: {
      paymentId: payment.id,
      amountPaise: alloc.amountPaise,
      vendorPortionPaise: alloc.vendorPortionPaise,
      merchantPortionPaise: alloc.merchantPortionPaise,
      components: c,
      reason: input.reason.slice(0, 500),
      withSplitReversal: !afterSettlement && alloc.vendorPortionPaise > 0 && !!payment.vendorId,
      afterSettlement,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true },
  });
  if (afterSettlement && alloc.vendorPortionPaise > 0) {
    await tx.sellerRecovery.create({ data: { orderId: input.orderId, sellerId: order.sellerId, refundId: refund.id, amountPaise: alloc.vendorPortionPaise, status: "OPEN" } });
  }
  await recordAudit(tx, {
    actor: input.actor,
    action: "refund.requested",
    entity: { type: "Refund", id: refund.id },
    after: { orderId: input.orderId, ...c, amount: alloc.amountPaise, vendorPortion: alloc.vendorPortionPaise, merchantPortion: alloc.merchantPortionPaise, afterSettlement, reason: input.reason },
    requestId: input.requestId,
  });
  await enqueueOutbox(tx, { queue: "orders", name: "processRefund", payload: { refundId: refund.id } });
  return { refundId: refund.id, created: true };
}

/** Definite rejections: the provider will never process this request, so retrying can't help. */
const definiteRejection = (err: unknown) => err instanceof CashfreeError && err.status !== null && err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;

/**
 * Sends a REQUESTED refund to the provider, or re-checks a PENDING one. Timeouts and 5xx throw so the
 * job retries with the same idempotency key (no duplicate refund at the provider).
 */
export async function processRefund(db: Db, provider: PaymentProvider, refundId: string): Promise<RefundStatus> {
  const refund = await db.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: { select: { orderId: true, vendorId: true, provider: true } } } });
  if (refund.status === "SUCCESS" || refund.status === "FAILED") return refund.status;
  if (refund.payment.provider !== provider.name) throw new Error(`refund ${refundId} belongs to provider ${refund.payment.provider}`);

  if (refund.status === "PENDING" && refund.providerRefundId) {
    const current = await provider.getRefund(refund.payment.orderId, refund.id);
    if (current) await applyRefundStatus(db, { refundId, providerRefundId: current.providerRefundId, status: current.status });
    return (await db.refund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true } })).status;
  }
  try {
    const result = await provider.refund({
      orderId: refund.payment.orderId,
      refundId: refund.id,
      amount: refund.amountPaise,
      vendorId: refund.withSplitReversal ? refund.payment.vendorId : null,
      vendorPortion: refund.withSplitReversal ? refund.vendorPortionPaise : 0,
      note: `RePart refund ${refund.id}`,
      idempotencyKey: refund.idempotencyKey,
    });
    await applyRefundStatus(db, { refundId, providerRefundId: result.providerRefundId, status: result.status });
  } catch (err) {
    if (err instanceof CashfreeError && err.status === 409) {
      // Already created with this refund_id: read it back instead of creating another.
      const current = await provider.getRefund(refund.payment.orderId, refund.id);
      if (current) {
        await applyRefundStatus(db, { refundId, providerRefundId: current.providerRefundId, status: current.status });
        return (await db.refund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true } })).status;
      }
    }
    if (definiteRejection(err)) {
      await db.$transaction(async (tx) => {
        await tx.refund.update({ where: { id: refundId }, data: { status: "FAILED" } });
        await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "refund.failed", entity: { type: "Refund", id: refundId }, after: { reason: (err as Error).message.slice(0, 300), code: (err as CashfreeError).code } });
      });
      logger.warn({ refundId, code: (err as CashfreeError).code }, "refund rejected by provider");
      return "FAILED";
    }
    throw err;
  }
  return (await db.refund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true } })).status;
}

/** Applies a provider-confirmed refund status (webhook or status query). Final states never change again. */
export async function applyRefundStatus(db: Db | Tx, s: { refundId: string; providerRefundId: string | null; status: RefundState; amount?: number }): Promise<void> {
  const run = async (tx: Tx) => {
    const refund = await tx.refund.findUnique({ where: { id: s.refundId }, include: { payment: { select: { id: true, orderId: true, vendorSharePaise: true } } } });
    if (!refund || refund.status === "SUCCESS" || refund.status === "FAILED") return;
    if (s.amount !== undefined && s.amount !== refund.amountPaise) {
      await flagMismatch(tx, { orderId: refund.payment.orderId, kind: "REFUND_AMOUNT_MISMATCH", expected: { amount: refund.amountPaise }, actual: { amount: s.amount, providerRefundId: s.providerRefundId } });
      return;
    }
    await tx.refund.update({ where: { id: refund.id }, data: { status: s.status, ...(s.providerRefundId ? { providerRefundId: s.providerRefundId } : {}) } });
    if (s.status === "SUCCESS" || s.status === "FAILED") {
      await recordAudit(tx, { actor: { type: "PROVIDER_WEBHOOK", id: null }, action: s.status === "SUCCESS" ? "refund.succeeded" : "refund.failed", entity: { type: "Refund", id: refund.id }, before: { status: refund.status }, after: { status: s.status } });
    }
    if (s.status === "SUCCESS" && refund.withSplitReversal) {
      const reversed = await tx.refund.aggregate({ where: { paymentId: refund.payment.id, status: "SUCCESS", withSplitReversal: true }, _sum: { vendorPortionPaise: true } });
      if ((reversed._sum.vendorPortionPaise ?? 0) >= refund.payment.vendorSharePaise) await tx.payment.update({ where: { id: refund.payment.id }, data: { vendorSettlementStatus: "REVERSED" } });
    }
  };
  if ("$transaction" in db) await db.$transaction(run);
  else await run(db);
}
