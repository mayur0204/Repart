import "server-only";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { StorageProvider } from "../../adapters/storage/types";
import { NotFoundError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { transitionListing } from "../listing/state";
import { enqueueOutbox } from "../outbox/outbox";

/**
 * Admin listing review queue (PLAN.md §6.1 Stage 3, decision D-5): LIVE listings whose latest risk
 * assessment asked for review. Admins keep the listing live (review cleared), request changes (L8) or
 * reject it (L7). Every decision is audited.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };

type CheckResults = { needsAdminReview?: boolean; reviewReasons?: string[] };

export async function listingReviewQueue(db: Db) {
  const live = await db.listing.findMany({
    where: { status: "LIVE", riskAssessments: { some: { checkResults: { path: ["needsAdminReview"], equals: true } } } },
    select: {
      id: true,
      title: true,
      pricePaise: true,
      latestRiskScore: true,
      inspectionRequirement: true,
      liveAt: true,
      seller: { select: { name: true } },
      category: { select: { name: true } },
      riskAssessments: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, createdAt: true, checkResults: true, score: true } },
    },
    orderBy: { latestRiskScore: "desc" },
  });
  const cleared = await db.auditLog.findMany({
    where: { action: "listing.review_cleared", entityId: { in: live.map((l) => l.id) } },
    select: { entityId: true, createdAt: true },
  });
  return live
    .map((l) => ({ ...l, latest: l.riskAssessments[0]! }))
    .filter((l) => (l.latest.checkResults as CheckResults).needsAdminReview)
    .filter((l) => !cleared.some((c) => c.entityId === l.id && c.createdAt > l.latest.createdAt))
    .map((l) => ({ ...l, reviewReasons: (l.latest.checkResults as CheckResults).reviewReasons ?? [] }));
}

/** Everything an admin needs to judge a listing: assessments (newest first), photos via short-lived URLs, events. */
export async function listingRiskDetail(db: Db, deps: { storage: StorageProvider; bucket: string }, listingId: string) {
  const listing = await db.listing.findUnique({
    where: { id: listingId },
    include: {
      seller: { select: { id: true, name: true } },
      category: { select: { name: true, slug: true, inspectionTier: true, isSafetyCritical: true } },
      partNumber: { select: { display: true, brand: true, isSample: true } },
      riskAssessments: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 20 },
      photos: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!listing) throw new NotFoundError("listing");
  const photos = await Promise.all(
    listing.photos.map(async (p) => ({ ...p, url: p.storageKey ? await deps.storage.createSignedDownloadUrl(deps.bucket, p.storageKey, 600) : null })),
  );
  return { ...listing, photos };
}

export const adminDecisionInput = z.object({
  listingId: z.string().min(1),
  reason: z.string().trim().min(10, "Give the seller a reason of at least 10 characters that says what to fix.").max(1000),
});

async function notify(tx: Parameters<Parameters<Db["$transaction"]>[0]>[0], sellerId: string, listingId: string, title: string, body: string) {
  await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: sellerId, channel: "IN_APP", type: "listing.admin_decision", title, body, link: `/sell/${listingId}/status` } });
}

/** L8: LIVE → CHANGES_REQUESTED with a reason shown to the seller. */
export async function adminRequestChanges(db: Db, actor: Actor, input: z.input<typeof adminDecisionInput>) {
  const data = adminDecisionInput.parse(input);
  await db.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: data.listingId }, select: { sellerId: true } });
    if (!listing) throw new NotFoundError("listing");
    await transitionListing(tx, { listingId: data.listingId, event: "adminRequestChanges", actor: { type: "ADMIN", id: actor.userId }, requestId: actor.requestId, payload: { reason: data.reason }, data: { sellerMessage: data.reason } });
    await notify(tx, listing.sellerId, data.listingId, "Changes needed", data.reason);
  });
}

/** L7: LIVE or CHANGES_REQUESTED → REJECTED (terminal) with a reason. */
export async function adminReject(db: Db, actor: Actor, input: z.input<typeof adminDecisionInput>) {
  const data = adminDecisionInput.parse(input);
  await db.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: data.listingId }, select: { sellerId: true } });
    if (!listing) throw new NotFoundError("listing");
    await transitionListing(tx, { listingId: data.listingId, event: "adminReject", actor: { type: "ADMIN", id: actor.userId }, requestId: actor.requestId, payload: { reason: data.reason }, data: { sellerMessage: data.reason } });
    await notify(tx, listing.sellerId, data.listingId, "Listing not accepted", data.reason);
  });
}

/** Keeps a flagged listing live and removes it from the queue until its next assessment. */
export async function clearListingReview(db: Db, actor: Actor, listingId: string, note?: string) {
  const listing = await db.listing.findUnique({ where: { id: listingId }, select: { status: true } });
  if (!listing) throw new NotFoundError("listing");
  await recordAudit(db, { actor: { type: "ADMIN", id: actor.userId }, action: "listing.review_cleared", entity: { type: "Listing", id: listingId }, after: { status: listing.status, note: note ?? null }, requestId: actor.requestId });
}

/** For the seller's status page: current status and the latest assessment's fixable reasons. */
export async function screeningStatusForOwner(db: Db, userId: string, listingId: string) {
  const listing = await db.listing.findFirst({
    where: { id: listingId, sellerId: userId },
    select: { status: true, sellerMessage: true, inspectionRequirement: true, trustLabel: true, riskAssessments: { orderBy: { createdAt: "desc" }, take: 1, select: { reasons: true, hadHardFailure: true, createdAt: true } } },
  });
  if (!listing) throw new NotFoundError("listing");
  const latest = listing.riskAssessments[0];
  const reasons = (latest?.reasons ?? []) as Array<{ code: string; message: string; severity: string; step: string | null }>;
  return {
    status: listing.status,
    sellerMessage: listing.sellerMessage,
    inspectionRequirement: listing.inspectionRequirement,
    trustLabel: listing.trustLabel,
    // Sellers see only the fixable (HARD) reasons; SOFT flags are for admin review.
    fixes: listing.status === "CHANGES_REQUESTED" ? reasons.filter((r) => r.severity === "HARD") : [],
  };
}
