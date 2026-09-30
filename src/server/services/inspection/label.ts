import "server-only";
import type { Prisma, PrismaClient, TrustLabel } from "@/generated/prisma/client";
import { recordAudit } from "../audit/audit";
import { trustLabel } from "../risk/rules";
import { getActiveSettings } from "../settings/settings";
import type { Settings } from "../settings/schema";

/**
 * Partner Check label validity (PLAN.md §6.2, A-18): a listing shows "Inspected by [garage] on [date]. Visual and
 * basic check." only while
 *   1. its latest completed inspection is PASS or PASS_WITH_NOTES,
 *   2. that inspection is younger than settings.inspections.partnerCheckLabelDays (default 30), and
 *   3. the listing hasn't been materially edited since (PLAN.md §5.1 L9: photos, category, part number, checklist,
 *      or price by more than settings.risk.materialPriceChangePercent).
 * A material edit is recorded as a `listing.partner_check_invalidated` audit entry, so inspection history is
 * never changed or deleted; a later passed inspection simply starts a new label.
 */
type Db = Pick<PrismaClient, "inspection" | "auditLog" | "listing" | "riskAssessment" | "settingsVersion">;
type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
export const INVALIDATED_ACTION = "listing.partner_check_invalidated";

export type MaterialEditCause = "photos" | "category" | "part_number" | "checklist" | "price" | "inspection_failed";

async function latestCompleted(db: Pick<Db, "inspection">, listingId: string) {
  return db.inspection.findFirst({
    where: { listingId, status: "COMPLETED" },
    orderBy: { completedAt: "desc" },
    select: { outcome: true, completedAt: true, partner: { select: { garageName: true } } },
  });
}

/** The listing's current Partner Check (garage and date), or null if there's no valid one. */
export async function validPartnerCheck(db: Db, listingId: string, settings: Settings, now = new Date()): Promise<{ garageName: string; date: Date } | null> {
  const last = await latestCompleted(db, listingId);
  if (!last?.completedAt || (last.outcome !== "PASS" && last.outcome !== "PASS_WITH_NOTES")) return null;
  if (last.completedAt.getTime() < now.getTime() - settings.inspections.partnerCheckLabelDays * DAY_MS) return null;
  const invalidated = await db.auditLog.count({ where: { entityType: "Listing", entityId: listingId, action: INVALIDATED_ACTION, createdAt: { gt: last.completedAt } } });
  return invalidated ? null : { garageName: last.partner.garageName, date: last.completedAt };
}

/** The label a listing gets from its latest screening (PLAN.md §6.2), used when a Partner Check stops applying. */
export async function screeningLabel(db: Pick<Db, "riskAssessment">, listingId: string, settings: Settings): Promise<TrustLabel> {
  const ra = await db.riskAssessment.findFirst({ where: { listingId }, orderBy: { createdAt: "desc" }, select: { hadHardFailure: true, score: true } });
  return ra ? trustLabel(ra.hadHardFailure, ra.score, settings) : "SELLER_DECLARED";
}

/**
 * A material edit (or a failed later check) ends the current Partner Check: the label falls back to the screening
 * label and the invalidation is audited. Does nothing when there's no valid Partner Check to end.
 */
export async function invalidatePartnerCheck(tx: Tx, listingId: string, cause: MaterialEditCause, actor: { type: "USER" | "MECHANIC" | "ADMIN" | "SYSTEM"; id: string | null }, now = new Date()) {
  const { settings } = await getActiveSettings(tx);
  const current = await validPartnerCheck(tx, listingId, settings, now);
  const listing = await tx.listing.findUnique({ where: { id: listingId }, select: { trustLabel: true } });
  if (!current && listing?.trustLabel !== "PARTNER_CHECK") return false;
  const label = await screeningLabel(tx, listingId, settings);
  if (listing?.trustLabel === "PARTNER_CHECK") await tx.listing.update({ where: { id: listingId }, data: { trustLabel: label } });
  await recordAudit(tx, { actor, action: INVALIDATED_ACTION, entity: { type: "Listing", id: listingId }, before: { trustLabel: listing?.trustLabel ?? null }, after: { trustLabel: label, cause } });
  return true;
}

/** PLAN.md §5.1 L9: a price change counts as material above the configured percentage. */
export function isMaterialPriceChange(oldPaise: number | null, newPaise: number, settings: Settings) {
  if (oldPaise === null || oldPaise <= 0) return false;
  return (Math.abs(newPaise - oldPaise) * 100) / oldPaise > settings.risk.materialPriceChangePercent;
}

/** Runs `invalidatePartnerCheck` in its own transaction, for edit paths that don't have one. */
export async function onMaterialEdit(db: Pick<PrismaClient, "$transaction">, listingId: string, cause: MaterialEditCause, userId: string) {
  await db.$transaction((tx) => invalidatePartnerCheck(tx, listingId, cause, { type: "USER", id: userId }));
}
