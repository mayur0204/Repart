import "server-only";
import type { ActorType, Prisma } from "@/generated/prisma/client";

type AuditTx = Pick<Prisma.TransactionClient, "auditLog">;

export type AuditEntry = {
  actor: { type: ActorType; id?: string | null };
  action: string; // dotted verb, e.g. "listing.submitted", "settings.activated"
  entity: { type: string; id: string };
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  requestId?: string | null;
};

/** Keys never stored in before/after snapshots (PLAN.md §1.2: no OTPs, secrets, bank fields or phones). */
const SENSITIVE_KEY = /^(phone|otp|code|codeHash|password|secret|token|tokenHash|accountNumber|ifsc|upi)$/i;

export function redactSnapshot(value: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => redactSnapshot(v as Prisma.InputJsonValue) ?? null) as Prisma.InputJsonValue;
  if (typeof value === "object") {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : (redactSnapshot(v as Prisma.InputJsonValue) ?? null);
    }
    return out;
  }
  return value;
}

/**
 * Append one audit row. Always call inside the same transaction as the change it records.
 * There is deliberately no update or delete; the database trigger rejects both.
 */
export async function recordAudit(tx: AuditTx, entry: AuditEntry): Promise<void> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(entry.action)) {
    throw new Error(`audit action must be dotted lower-case (e.g. "listing.submitted"), got "${entry.action}"`);
  }
  await tx.auditLog.create({
    data: {
      actorType: entry.actor.type,
      actorId: entry.actor.id ?? null,
      action: entry.action,
      entityType: entry.entity.type,
      entityId: entry.entity.id,
      before: redactSnapshot(entry.before),
      after: redactSnapshot(entry.after),
      requestId: entry.requestId ?? null,
    },
  });
}
