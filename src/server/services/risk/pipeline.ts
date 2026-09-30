import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { maskContactDetails } from "@/lib/listing";
import type { StorageProvider } from "../../adapters/storage/types";
import type { VisionProvider } from "../../adapters/vision/types";
import { logger } from "../../logger";
import { validPartnerCheck } from "../inspection/label";
import { loadInterchange } from "../interchange/interchange";
import { getWizardState } from "../listing/listing";
import { transitionListing } from "../listing/state";
import { enqueueOutbox } from "../outbox/outbox";
import { route, stage1, stage2, type CheckResult, type RiskContext, type VisionPhotoResult } from "./rules";

/**
 * Risk check job (REPART_BRIEF.md §6, PLAN.md §6.1): runs in the worker for `risk.check(listingId)`.
 * Idempotent: it locks the listing row and exits unless the listing is SUBMITTED or SCREENING.
 * Stage 2 reads only processed photos (EXIF-free, from the private bucket), never the original upload.
 */
type Db = PrismaClient;
export type RiskDeps = { storage: StorageProvider; bucket: string; vision: VisionProvider };
export type RiskOutcome = "skipped" | "CHANGES_REQUESTED" | "LIVE";

const SYSTEM = { type: "SYSTEM" as const, id: null };

async function lockStatus(tx: Prisma.TransactionClient, listingId: string) {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM "Listing" WHERE id = ${listingId} FOR UPDATE`;
  return rows[0]?.status ?? null;
}

const reasonOf = (c: CheckResult) => ({ code: c.code, message: c.message, severity: c.severity, step: c.fixStep ?? null, photoId: c.photoId ?? null });

export async function runRiskCheck(db: Db, deps: RiskDeps, listingId: string): Promise<RiskOutcome> {
  // 1. Claim: SUBMITTED → SCREENING (L3). A retry finds SCREENING and continues.
  const claimed = await db.$transaction(async (tx) => {
    const status = await lockStatus(tx, listingId);
    if (status === "SUBMITTED") {
      await transitionListing(tx, { listingId, event: "screeningStarted", actor: SYSTEM });
      return true;
    }
    return status === "SCREENING";
  });
  if (!claimed) return "skipped";

  // 2. Build the context.
  const listing = await db.listing.findUniqueOrThrow({ where: { id: listingId } });
  const state = await getWizardState(db, listing.sellerId, listingId);
  const photoRows = state.photos;
  const labelOf = (shotType: string) => state.photoGuide.find((s) => s.shotType === shotType)?.label ?? "extra photo";

  const [others, comparables] = await Promise.all([
    db.listingPhoto.findMany({ where: { listingId: { not: listingId }, pHash: { not: null } }, select: { listingId: true, pHash: true, listing: { select: { sellerId: true } } } }),
    (async () => {
      if (!listing.categoryId || !listing.conditionGrade) return [];
      const group = listing.partNumberId ? (await loadInterchange(db, listing.partNumberId)).group.map((m) => m.partNumberId) : null;
      const rows = await db.listing.findMany({
        where: {
          id: { not: listingId },
          status: { in: ["LIVE", "SOLD"] },
          categoryId: listing.categoryId,
          conditionGrade: listing.conditionGrade,
          pricePaise: { not: null },
          ...(group ? { partNumberId: { in: group } } : {}),
        },
        select: { pricePaise: true },
      });
      return rows.map((r) => r.pricePaise!);
    })(),
  ]);

  const ctx: RiskContext = {
    listing: {
      id: listing.id,
      sellerId: listing.sellerId,
      title: listing.title,
      description: listing.description,
      reasonForSale: listing.reasonForSale,
      pricePaise: listing.pricePaise,
      checklistAnswers: listing.checklistAnswers,
      partNumberDisplay: state.part?.display ?? null,
    },
    category: { slug: state.category?.slug ?? "", checklist: state.checklist, requiredShots: state.photoGuide.filter((s) => s.required) },
    steps: state.steps,
    photos: photoRows.map((p, i) => ({
      id: p.id,
      index: i + 1,
      shotLabel: labelOf(p.shotType),
      shotType: p.shotType,
      ready: p.status === "ready",
      width: p.width,
      height: p.height,
      blurScore: p.blurScore,
      brightnessScore: p.brightnessScore,
      pHash: p.pHash,
    })),
    otherPhotos: others.map((o) => ({ listingId: o.listingId, sellerId: o.listing.sellerId, pHash: o.pHash! })),
    comparablePrices: comparables,
    settings: state.settings,
  };

  // 3. Stage 1, then Stage 2 only if there is no HARD failure.
  const checks1 = stage1(ctx);
  const hard1 = checks1.some((c) => !c.passed && c.severity === "HARD");
  let checks2: CheckResult[] | null = null;
  let visionModelVersion: string | null = null;
  if (!hard1) {
    const results: VisionPhotoResult[] = [];
    for (const p of ctx.photos.filter((x) => x.ready)) {
      const row = photoRows.find((r) => r.id === p.id)!;
      const bytes = await deps.storage.get(deps.bucket, row.storageKey!);
      if (!bytes) throw new Error(`processed photo ${p.id} missing from storage`); // retried by the queue
      const image = { bytes, contentType: "image/jpeg" };
      const [category, damage, ocr] = await Promise.all([deps.vision.classifyCategory(image), deps.vision.detectDamage(image), deps.vision.ocr(image)]);
      results.push({ photoId: p.id, index: p.index, category, damage, ocr });
    }
    visionModelVersion = results[0]?.category.modelVersion ?? null;
    checks2 = stage2(ctx, results);
  }
  const checks = [...checks1, ...(checks2 ?? [])];
  const category = state.category!;
  const routing = route(checks, { inspectionTier: category?.inspectionTier ?? "A_AUTOMATED", inspectionValueThreshold: category?.inspectionValueThreshold ?? null, optionalCheckEnabled: category?.optionalCheckEnabled ?? false }, listing.pricePaise ?? 0, state.settings);
  const failed = checks.filter((c) => !c.passed);

  // 4. Persist and route, re-checking the status under the lock.
  return db.$transaction(async (tx) => {
    if ((await lockStatus(tx, listingId)) !== "SCREENING") return "skipped" as const;
    const assessment = await tx.riskAssessment.create({
      data: {
        listingId,
        score: routing.score,
        reasons: failed.map(reasonOf),
        checkResults: {
          stage1: checks1.map(reasonAndPass),
          stage2: checks2 ? checks2.map(reasonAndPass) : null,
          stage2Skipped: checks2 === null,
          needsAdminReview: routing.needsAdminReview,
          reviewReasons: routing.reviewReasons,
        },
        hadHardFailure: routing.hadHardFailure,
        ruleSetVersion: state.settingsVersion,
        visionModelVersion,
        routingDecision: routing.decision,
        inspectionRequirement: routing.requirement,
        inspectionReason: routing.reason,
        trustLabel: routing.trustLabel,
      },
    });
    const contactFlag = failed.some((c) => c.code === "CONTACT_DETAILS");
    const masked = contactFlag
      ? { title: listing.title && maskContactDetails(listing.title), description: listing.description && maskContactDetails(listing.description), reasonForSale: listing.reasonForSale && maskContactDetails(listing.reasonForSale) }
      : {};
    const hardMessages = failed.filter((c) => c.severity === "HARD").map((c) => c.message);
    await transitionListing(tx, {
      listingId,
      event: routing.decision === "LIVE" ? "screeningPassed" : "screeningFailed",
      actor: SYSTEM,
      payload: { riskAssessmentId: assessment.id, score: routing.score, ruleSetVersion: state.settingsVersion, needsAdminReview: routing.needsAdminReview },
      data: {
        ...masked,
        latestRiskScore: routing.score,
        inspectionRequirement: routing.requirement,
        inspectionReason: routing.reason,
        // PLAN §6.2: the label is recomputed on screening; a still-valid Partner Check (M10) outranks the screening label.
        trustLabel: routing.decision === "LIVE" && (await validPartnerCheck(tx, listingId, state.settings)) ? "PARTNER_CHECK" : (routing.trustLabel ?? "SELLER_DECLARED"),
        sellerMessage: hardMessages.length ? hardMessages.join(" ") : null,
      },
    });
    await enqueueOutbox(tx, {
      queue: "notifications",
      name: "send",
      payload:
        routing.decision === "LIVE"
          ? { userId: listing.sellerId, channel: "IN_APP", type: "listing.live", title: "Part listed", body: `${listing.title ?? "Your listing"} is live.`, link: `/sell/${listingId}/status` }
          : { userId: listing.sellerId, channel: "IN_APP", type: "listing.changes_requested", title: "Changes needed", body: `${hardMessages.length} thing(s) to fix before ${listing.title ?? "your listing"} can go live.`, link: `/sell/${listingId}/status` },
    });
    if (routing.decision === "LIVE") await enqueueOutbox(tx, { queue: "searches", name: "alert", payload: { listingId } });
    logger.info({ listingId, decision: routing.decision, score: routing.score, ruleSetVersion: state.settingsVersion }, "risk check routed");
    return routing.decision;
  });
}

function reasonAndPass(c: CheckResult) {
  return { ...reasonOf(c), passed: c.passed, confidence: c.confidence };
}
