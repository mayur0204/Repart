import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "../../adapters/payment/types";
import { recordAudit } from "../audit/audit";
import { flagMismatch, type MismatchKind } from "./mismatch";

/**
 * Daily reconciliation (PLAN.md §7.2 step 8). For every recent or still-open payment it compares
 * RePart's amount and status with the provider order, the provider's payments and the Easy Split
 * allocation, and writes mismatches for an admin. It never changes financial records.
 */
type Db = PrismaClient;
const DAY_MS = 86_400_000;

export async function runReconciliation(db: Db, provider: PaymentProvider, opts: { now?: Date; lookbackDays?: number } = {}) {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.lookbackDays ?? 2) * DAY_MS);
  const runDate = new Date(now);
  runDate.setUTCHours(0, 0, 0, 0);
  const run = await db.reconciliationRun.create({ data: { runDate, status: "RUNNING" }, select: { id: true } });

  const payments = await db.payment.findMany({
    where: { provider: provider.name, OR: [{ createdAt: { gte: since } }, { status: "SUCCESS", vendorSettlementStatus: { in: ["HELD", "ELIGIBLE"] } }] },
    select: { orderId: true, status: true, amountPaise: true, vendorId: true, vendorSharePaise: true, vendorSettlementStatus: true, providerPaymentId: true, order: { select: { state: true } } },
    take: 500,
  });

  const found: Array<{ orderId: string; kind: MismatchKind; expected: Prisma.InputJsonValue | null; actual: Prisma.InputJsonValue | null }> = [];
  let errors = 0;
  for (const p of payments) {
    const flag = (kind: MismatchKind, expected: Prisma.InputJsonValue | null, actual: Prisma.InputJsonValue | null) => found.push({ orderId: p.orderId, kind, expected, actual });
    try {
      const po = await provider.getOrder(p.orderId);
      if (!po) {
        flag("PROVIDER_ORDER_MISSING", { amount: p.amountPaise }, null);
        continue;
      }
      if (po.amount !== p.amountPaise) flag("AMOUNT_MISMATCH", { amount: p.amountPaise }, { amount: po.amount });
      const successes = (await provider.getPayments(p.orderId)).filter((a) => a.status === "SUCCESS");
      if (successes.length > 1) flag("DUPLICATE_PAYMENT", { successfulPayments: 1 }, { successfulPayments: successes.length, ids: successes.map((s) => s.providerPaymentId) });
      for (const s of successes) if (s.amount !== p.amountPaise) flag("AMOUNT_MISMATCH", { amount: p.amountPaise }, { amount: s.amount, providerPaymentId: s.providerPaymentId });
      const providerPaid = po.status === "PAID" || successes.length > 0;
      if (providerPaid !== (p.status === "SUCCESS")) flag("PROVIDER_STATUS_MISMATCH", { repart: p.status, orderState: p.order.state }, { provider: po.status, successfulPayments: successes.length });

      if (p.status === "SUCCESS" && p.vendorId) {
        const split = await provider.getOrderSettlement(p.orderId);
        if (!split) flag("SPLIT_MISSING", { vendorId: p.vendorId, amount: p.vendorSharePaise }, null);
        else {
          if (split.vendorId !== p.vendorId) flag("SPLIT_VENDOR_MISMATCH", { vendorId: p.vendorId }, { vendorId: split.vendorId });
          if (split.amount !== p.vendorSharePaise) flag("SPLIT_AMOUNT_MISMATCH", { amount: p.vendorSharePaise }, { amount: split.amount });
          if (split.settled && p.vendorSettlementStatus === "HELD") flag("SETTLED_BEFORE_RELEASE", { vendorSettlementStatus: "HELD" }, { settled: true, providerSettlementId: split.providerSettlementId });
        }
      }
    } catch (err) {
      errors++;
      flag("PROVIDER_ERROR", null, { message: (err as Error).message.slice(0, 200) });
    }
  }

  await db.$transaction(async (tx) => {
    for (const m of found) await flagMismatch(tx, { ...m, runId: run.id });
    await tx.reconciliationRun.update({ where: { id: run.id }, data: { status: "COMPLETED", summary: { checked: payments.length, mismatches: found.length, errors } } });
    await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "reconciliation.completed", entity: { type: "ReconciliationRun", id: run.id }, after: { checked: payments.length, mismatches: found.length, errors } });
  });
  return { runId: run.id, checked: payments.length, mismatches: found.length, errors };
}
