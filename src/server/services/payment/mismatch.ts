import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { recordAudit } from "../audit/audit";

/**
 * Financial inconsistencies are flagged for an admin, never silently corrected (PLAN.md §7.2 step 8).
 * Mismatches found outside a reconciliation run (webhooks, timers) go into that day's "LIVE" run.
 */
export type MismatchKind =
  | "UNKNOWN_ORDER"
  | "AMOUNT_MISMATCH"
  | "DUPLICATE_PAYMENT"
  | "PAID_AFTER_CANCEL"
  | "PROVIDER_ORDER_MISSING"
  | "PROVIDER_STATUS_MISMATCH"
  | "SPLIT_MISSING"
  | "SPLIT_VENDOR_MISMATCH"
  | "SPLIT_AMOUNT_MISMATCH"
  | "SETTLED_BEFORE_RELEASE"
  | "REFUND_AMOUNT_MISMATCH"
  | "PROVIDER_ERROR";

type Tx = Pick<Prisma.TransactionClient, "reconciliationRun" | "reconciliationMismatch" | "auditLog">;

export async function flagMismatch(
  tx: Tx,
  m: { orderId: string | null; kind: MismatchKind; expected: Prisma.InputJsonValue | null; actual: Prisma.InputJsonValue | null; runId?: string },
): Promise<void> {
  let runId = m.runId;
  if (!runId) {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const run = (await tx.reconciliationRun.findFirst({ where: { runDate: day, status: "LIVE" }, select: { id: true } })) ?? (await tx.reconciliationRun.create({ data: { runDate: day, status: "LIVE" }, select: { id: true } }));
    runId = run.id;
  }
  const row = await tx.reconciliationMismatch.create({
    data: { runId, orderId: m.orderId, kind: m.kind, expected: m.expected ?? undefined, actual: m.actual ?? undefined },
    select: { id: true },
  });
  await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "reconciliation.mismatch_flagged", entity: { type: "ReconciliationMismatch", id: row.id }, after: { kind: m.kind, orderId: m.orderId } });
}
