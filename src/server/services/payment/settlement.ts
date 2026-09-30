import "server-only";
import type { DisputeStatus, PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "../../adapters/payment/types";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { flagMismatch } from "./mismatch";

/**
 * Seller settlement (PLAN.md §7.2 steps 5–6). The seller's split is held by the provider's deferred
 * settlement (up to 45 days, then the provider auto-releases). RePart releases it only when every rule
 * holds: order COMPLETED or RESOLVED_RELEASE, no unresolved dispute, payment captured, split still held,
 * and the seller's vendor ACTIVE and the same vendor the split was made to. The provider then settles it
 * on the vendor's schedule (schedule_option 1, T+1 11:00); RePart tracks that state, it doesn't pay out.
 */
type Db = PrismaClient;
const RELEASABLE = ["COMPLETED", "RESOLVED_RELEASE"] as const;
export const UNRESOLVED_DISPUTE: DisputeStatus[] = ["OPEN", "AWAITING_SELLER", "UNDER_REVIEW"];

export type ReleaseOutcome = "released" | "already" | "blocked";

export async function settlementBlocker(db: Db, orderId: string): Promise<string | null> {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: { state: true, dispute: { select: { status: true } }, payment: { select: { status: true, vendorId: true, vendorSettlementStatus: true } }, seller: { select: { payoutAccount: { select: { status: true, providerVendorId: true } } } } },
  });
  if (!o) return "order not found";
  if (!(RELEASABLE as readonly string[]).includes(o.state)) return `order is ${o.state}`;
  if (o.dispute && UNRESOLVED_DISPUTE.includes(o.dispute.status)) return "dispute is unresolved";
  if (!o.payment || o.payment.status !== "SUCCESS") return "payment not captured";
  if (!o.payment.vendorId) return "no seller split on this payment";
  if (o.seller.payoutAccount?.status !== "ACTIVE") return "seller vendor account is not active";
  if (o.seller.payoutAccount.providerVendorId !== o.payment.vendorId) return "seller vendor changed since payment";
  return null;
}

export async function releaseSettlement(db: Db, provider: PaymentProvider, orderId: string, now = new Date()): Promise<ReleaseOutcome> {
  const payment = await db.payment.findUnique({ where: { orderId }, select: { id: true, vendorId: true, vendorSettlementStatus: true, provider: true } });
  if (payment && payment.vendorSettlementStatus !== "HELD") return "already";
  const blocker = await settlementBlocker(db, orderId);
  if (blocker || !payment?.vendorId) {
    await db.$transaction((tx) => recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "settlement.blocked", entity: { type: "Order", id: orderId }, after: { reason: blocker ?? "no payment" } }));
    logger.warn({ orderId, blocker }, "settlement release blocked");
    return "blocked";
  }
  if (payment.provider !== provider.name) throw new Error(`payment for ${orderId} belongs to provider ${payment.provider}`);
  // Idempotent at the provider: setting the same eligibility date again changes nothing. Errors throw so the job retries.
  await provider.markSettlementEligible({ orderId, vendorId: payment.vendorId, at: now });
  await db.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({ where: { id: payment.id, vendorSettlementStatus: "HELD" }, data: { vendorSettlementStatus: "ELIGIBLE", settlementEligibleAt: now } });
    if (count) await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "settlement.released", entity: { type: "Payment", id: payment.id }, after: { orderId, vendorId: payment.vendorId } });
  });
  return "released";
}

/**
 * Reads the provider's settlement state for the order's split. SETTLED is recorded from the provider only;
 * a split the provider settled while RePart still held it (auto-release after 45 days) is flagged.
 */
export async function syncSettlement(db: Db, provider: PaymentProvider, orderId: string): Promise<string> {
  const payment = await db.payment.findUnique({ where: { orderId }, select: { id: true, vendorSettlementStatus: true, vendorId: true } });
  if (!payment?.vendorId || !["HELD", "ELIGIBLE"].includes(payment.vendorSettlementStatus)) return payment?.vendorSettlementStatus ?? "NONE";
  const s = await provider.getOrderSettlement(orderId);
  if (!s?.settled) return payment.vendorSettlementStatus;
  await db.$transaction(async (tx) => {
    if (payment.vendorSettlementStatus === "HELD") {
      await flagMismatch(tx, { orderId, kind: "SETTLED_BEFORE_RELEASE", expected: { vendorSettlementStatus: "HELD" }, actual: { settled: true, providerSettlementId: s.providerSettlementId } });
    }
    await tx.payment.update({ where: { id: payment.id }, data: { vendorSettlementStatus: "SETTLED" } });
    await recordAudit(tx, { actor: { type: "PROVIDER_WEBHOOK", id: null }, action: "settlement.settled", entity: { type: "Payment", id: payment.id }, before: { vendorSettlementStatus: payment.vendorSettlementStatus }, after: { vendorSettlementStatus: "SETTLED", providerSettlementId: s.providerSettlementId } });
  });
  return "SETTLED";
}
