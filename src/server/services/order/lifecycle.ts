import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "../../adapters/payment/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { enqueueOutbox } from "../outbox/outbox";
import { confirmFromProvider } from "../payment/payment-events";
import { refundableComponents, requestRefund, type RefundComponents } from "../payment/refunds";
import { syncSettlement } from "../payment/settlement";
import { transitionOrder } from "./state";

/**
 * Order timers and admin money decisions (PLAN.md §5.2 O3, O8, O21, O22, O24; §5.3 deadline breach).
 * Timers arrive as delayed outbox jobs; the sweep catches anything a job missed. All are idempotent.
 */
type Db = PrismaClient;
const SYSTEM = { type: "SYSTEM" as const, id: null };

/** O3 (expiry): ask the provider first, so a payment made at the last second is never cancelled. */
export async function expirePayment(db: Db, provider: PaymentProvider, orderId: string, now = new Date()): Promise<"expired" | "paid" | "not_due"> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { state: true, paymentExpiresAt: true, payment: { select: { provider: true } } } });
  if (!order || order.state !== "CREATED" || !order.paymentExpiresAt || order.paymentExpiresAt > now) return "not_due";
  if (order.payment && order.payment.provider === provider.name) {
    const after = await confirmFromProvider(db, provider, orderId); // provider errors throw: the job retries rather than cancel blindly
    if (after.state !== "CREATED") return "paid";
  }
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: "paymentExpired", actor: SYSTEM, reason: "Payment was not completed in time." });
    await tx.payment.updateMany({ where: { orderId, status: { in: ["CREATED", "PENDING", "FAILED"] } }, data: { status: "EXPIRED" } });
  });
  return "expired";
}

/** O8: the seller didn't confirm in time → cancel with a full refund. */
export async function sellerTimeout(db: Db, orderId: string, now = new Date()): Promise<"cancelled" | "not_due"> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { state: true, sellerConfirmBy: true } });
  if (!order || order.state !== "AWAITING_SELLER" || !order.sellerConfirmBy || order.sellerConfirmBy > now) return "not_due";
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: "sellerTimeout", actor: SYSTEM, reason: "The seller didn't confirm the order in time." });
    await requestRefund(tx, { orderId, components: await refundableComponents(tx, orderId), reason: "Seller did not confirm in time (full refund).", actor: SYSTEM, idempotencyKey: `refund:${orderId}:seller_timeout` });
  });
  return "cancelled";
}

/** Backup for missed timer jobs, settlement status sync and the auto-release deadline breach (§5.3). */
export async function sweepOrders(db: Db, provider: PaymentProvider, now = new Date()) {
  const result = { expired: 0, sellerTimeouts: 0, settled: 0, breached: 0, errors: 0 };
  const guard = async (what: string, id: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (err) {
      result.errors++;
      logger.warn({ what, id, err: (err as Error).message }, "order sweep step failed");
    }
  };
  for (const o of await db.order.findMany({ where: { state: "CREATED", paymentExpiresAt: { lt: now } }, select: { id: true }, take: 100 })) {
    if ((await guard("expire", o.id, () => expirePayment(db, provider, o.id, now))) === "expired") result.expired++;
  }
  for (const o of await db.order.findMany({ where: { state: "AWAITING_SELLER", sellerConfirmBy: { lt: now } }, select: { id: true }, take: 100 })) {
    if ((await guard("sellerTimeout", o.id, () => sellerTimeout(db, o.id, now))) === "cancelled") result.sellerTimeouts++;
  }
  for (const p of await db.payment.findMany({ where: { provider: provider.name, status: "SUCCESS", vendorSettlementStatus: "ELIGIBLE" }, select: { orderId: true }, take: 50 })) {
    if ((await guard("syncSettlement", p.orderId, () => syncSettlement(db, provider, p.orderId))) === "SETTLED") result.settled++;
  }
  // §5.3 breach: the provider's hold may auto-release on a non-terminal order. Record it and alert admins; no money action.
  const breached = await db.order.findMany({
    where: { autoReleaseAt: { lt: now }, deadlineBreachedAt: null, state: { notIn: ["CREATED", "COMPLETED", "RESOLVED_REFUND", "RESOLVED_RELEASE", "CANCELLED"] } },
    select: { id: true },
    take: 100,
  });
  if (breached.length) {
    const admins = await db.user.findMany({ where: { roles: { has: "ADMIN" }, status: "ACTIVE" }, select: { id: true } });
    for (const o of breached) {
      await db.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({ where: { id: o.id, deadlineBreachedAt: null }, data: { deadlineBreachedAt: now } });
        if (!count) return;
        await recordAudit(tx, { actor: SYSTEM, action: "order.deadline_breached", entity: { type: "Order", id: o.id }, after: { at: now.toISOString() } });
        for (const a of admins) {
          await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: a.id, channel: "IN_APP", type: "order.deadline_breached", title: "Payout hold deadline passed", body: "The payment provider's hold on an open order has passed. Check the order and its settlement.", link: `/admin/orders/${o.id}` } });
        }
      });
      result.breached++;
    }
  }
  return result;
}

// ── admin decisions ──

const money = z.coerce.number().int().min(0);
export const adminRefundInput = z.object({
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(500),
  item: money.optional(),
  shipping: money.optional(),
  check: money.optional(),
});

async function componentsFrom(db: Db, orderId: string, raw: z.infer<typeof adminRefundInput>): Promise<RefundComponents> {
  const left = await refundableComponents(db, orderId);
  // Defaults to everything still refundable; admins may lower any component, never raise it.
  return { item: raw.item ?? left.item, shipping: raw.shipping ?? left.shipping, check: raw.check ?? left.check };
}

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new FieldError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  return r.data;
}

/** O24: admin cancels a paid order and refunds the chosen components (default: everything left). */
export async function adminCancelOrder(db: Db, admin: { userId: string; requestId?: string }, orderId: string, raw: unknown) {
  const input = parse(adminRefundInput, raw);
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!order) throw new NotFoundError("order");
  const components = await componentsFrom(db, orderId, input);
  const actor = { type: "ADMIN" as const, id: admin.userId };
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: "adminCancelled", actor, requestId: admin.requestId, reason: input.reason });
    if (components.item + components.shipping + components.check > 0) {
      await requestRefund(tx, { orderId, components, reason: input.reason, actor, idempotencyKey: `refund:${orderId}:admin_cancel`, requestId: admin.requestId });
    }
  });
}

/** Refund on an order that can't move any more (e.g. money that arrived after it was cancelled). */
export async function adminRefundOnly(db: Db, admin: { userId: string; requestId?: string }, orderId: string, raw: unknown) {
  const input = parse(adminRefundInput, raw);
  const order = await db.order.findUnique({ where: { id: orderId }, select: { state: true } });
  if (!order) throw new NotFoundError("order");
  if (order.state !== "CANCELLED") throw new UserError("Use cancel or dispute resolution for orders that are still open.");
  const components = await componentsFrom(db, orderId, input);
  const n = await db.refund.count({ where: { payment: { orderId } } });
  await db.$transaction((tx) => requestRefund(tx, { orderId, components, reason: input.reason, actor: { type: "ADMIN", id: admin.userId }, idempotencyKey: `refund:${orderId}:admin:${n + 1}`, requestId: admin.requestId }));
}

export const resolveDisputeInput = adminRefundInput.extend({ decision: z.enum(["REFUND", "RELEASE"]) });

/** O21 / O22: an explicit admin decision on a dispute (never automatic, decision D-6). */
export async function resolveDispute(db: Db, admin: { userId: string; requestId?: string }, orderId: string, raw: unknown) {
  const input = parse(resolveDisputeInput, raw);
  const order = await db.order.findUnique({ where: { id: orderId }, select: { state: true, dispute: { select: { id: true } } } });
  if (!order) throw new NotFoundError("order");
  if (order.state !== "DISPUTED" || !order.dispute) throw new UserError("This order has no open dispute.");
  const actor = { type: "ADMIN" as const, id: admin.userId };
  const components = input.decision === "REFUND" ? await componentsFrom(db, orderId, input) : null;
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: input.decision === "REFUND" ? "resolveRefund" : "resolveRelease", actor, requestId: admin.requestId, reason: input.reason });
    await tx.dispute.update({
      where: { id: order.dispute!.id },
      data: { status: input.decision === "REFUND" ? "RESOLVED_REFUND" : "RESOLVED_RELEASE", resolutionNote: input.reason, resolvedById: admin.userId, resolvedAt: new Date() },
    });
    if (components) {
      const { refundId } = await requestRefund(tx, { orderId, components, reason: input.reason, actor, idempotencyKey: `refund:${orderId}:dispute`, requestId: admin.requestId });
      const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { amountPaise: true } });
      await tx.dispute.update({ where: { id: order.dispute!.id }, data: { refundAmountPaise: r.amountPaise } });
    }
  });
}
