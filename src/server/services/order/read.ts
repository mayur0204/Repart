import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { NotFoundError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { orderMoneyView } from "./pricing";

/** Read models for order pages. Buyers and sellers only ever see their own orders (checked here, not in the page). */
type Db = PrismaClient;

const orderSelect = {
  id: true,
  buyerId: true,
  sellerId: true,
  state: true,
  fulfilmentMode: true,
  itemPricePaise: true,
  shippingFeePaise: true,
  checkFeePaise: true,
  platformFeePaise: true,
  totalPaise: true,
  vendorSharePaise: true,
  merchantSharePaise: true,
  paymentExpiresAt: true,
  sellerConfirmBy: true,
  autoReleaseAt: true,
  deadlineBreachedAt: true,
  cancelReason: true,
  createdAt: true,
  listing: { select: { id: true, title: true, partName: true } },
  payment: { select: { status: true, provider: true, paidAt: true, vendorSettlementStatus: true, settlementEligibleAt: true, refunds: { select: { id: true, amountPaise: true, status: true, createdAt: true, afterSettlement: true }, orderBy: { createdAt: "asc" as const } } } },
  events: { select: { toState: true, event: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
} as const;

export async function orderForUser(db: Db, userId: string, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: orderSelect });
  if (!o || (o.buyerId !== userId && o.sellerId !== userId)) throw new NotFoundError("order");
  const role = o.buyerId === userId ? ("buyer" as const) : ("seller" as const);
  return { ...o, role, title: o.listing.title ?? o.listing.partName ?? "Part", money: orderMoneyView(o) };
}

export async function ordersForUser(db: Db, userId: string) {
  const rows = await db.order.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    select: { id: true, buyerId: true, state: true, totalPaise: true, vendorSharePaise: true, createdAt: true, listing: { select: { title: true, partName: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({ ...r, role: r.buyerId === userId ? ("buyer" as const) : ("seller" as const), title: r.listing.title ?? r.listing.partName ?? "Part" }));
}

const TERMINAL = ["COMPLETED", "RESOLVED_REFUND", "RESOLVED_RELEASE", "CANCELLED"];

/** Admin list; `nearDeadline` marks open orders within `warnDays` of the provider's auto-release (PLAN.md §5.3). */
export async function adminOrders(db: Db, now = new Date(), warnDays = 7) {
  const rows = await db.order.findMany({
    select: { id: true, state: true, totalPaise: true, createdAt: true, autoReleaseAt: true, deadlineBreachedAt: true, listing: { select: { title: true, partName: true } }, payment: { select: { status: true, vendorSettlementStatus: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((o) => ({ ...o, nearDeadline: !!o.autoReleaseAt && !TERMINAL.includes(o.state) && o.autoReleaseAt.getTime() - now.getTime() <= warnDays * 86_400_000 }));
}

export async function adminOrder(db: Db, orderId: string) {
  const o = await db.order.findUnique({
    where: { id: orderId },
    select: {
      ...orderSelect,
      buyer: { select: { name: true } },
      seller: { select: { name: true, payoutAccount: { select: { status: true, providerVendorId: true } } } },
      dispute: { select: { status: true, reason: true, description: true } },
      payment: { select: { status: true, provider: true, providerOrderId: true, providerPaymentId: true, paidAt: true, amountPaise: true, vendorId: true, vendorSettlementStatus: true, settlementEligibleAt: true, refunds: { select: { id: true, amountPaise: true, vendorPortionPaise: true, merchantPortionPaise: true, status: true, reason: true, afterSettlement: true, withSplitReversal: true, createdAt: true }, orderBy: { createdAt: "asc" } } } },
      reconciliationMismatches: { select: { id: true, kind: true, resolvedAt: true, expected: true, actual: true }, orderBy: { id: "desc" } },
    },
  });
  if (!o) throw new NotFoundError("order");
  return { ...o, title: o.listing.title ?? o.listing.partName ?? "Part", money: orderMoneyView(o) };
}

export async function reconciliationOverview(db: Db) {
  const [runs, open] = await Promise.all([
    db.reconciliationRun.findMany({ orderBy: { createdAt: "desc" }, take: 20, select: { id: true, runDate: true, status: true, summary: true, createdAt: true, _count: { select: { mismatches: true } } } }),
    db.reconciliationMismatch.findMany({ where: { resolvedAt: null }, orderBy: { id: "desc" }, take: 200, select: { id: true, kind: true, orderId: true, expected: true, actual: true, run: { select: { runDate: true, status: true } } } }),
  ]);
  return { runs, open };
}

export async function resolveMismatch(db: Db, adminId: string, mismatchId: string) {
  await db.$transaction(async (tx) => {
    const { count } = await tx.reconciliationMismatch.updateMany({ where: { id: mismatchId, resolvedAt: null }, data: { resolvedAt: new Date(), resolvedById: adminId } });
    if (count) await recordAudit(tx, { actor: { type: "ADMIN", id: adminId }, action: "reconciliation.mismatch_resolved", entity: { type: "ReconciliationMismatch", id: mismatchId } });
  });
}
