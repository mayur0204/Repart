import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import type { VisionProvider } from "../../src/server/adapters/vision/types";
import { UserError } from "../../src/server/http/errors";
import { useRateLimitStore } from "../../src/server/http/rate-limit";
import { createDraft, getWizardState, saveBike, saveCondition, saveDetails, savePart, savePrice, submitListing } from "../../src/server/services/listing/listing";
import { confirmPhotoUpload, processListingPhoto, requestPhotoUpload } from "../../src/server/services/listing/photos";
import { relayOutbox } from "../../src/server/services/outbox/outbox";
import { runRiskCheck } from "../../src/server/services/risk/pipeline";
import { adminReject, adminRequestChanges, clearListingReview, listingReviewQueue, screeningStatusForOwner } from "../../src/server/services/risk/review";
import { getActiveSettings } from "../../src/server/services/settings/settings";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const storage = createMemoryStorageProvider();
const bucket = "listing-photos";
const seller = { userId: "sample-user-seller", requestId: "req-r" };
const seller2 = { userId: "sample-user-seller-nopayout", requestId: "req-r2" };
const admin = { userId: "sample-user-admin", requestId: "req-a" };
let textureSeed = Date.now() % 997;

/** Vision fake with configurable answers, used through the same VisionProvider interface. */
function vision(over: { category?: string | null; categoryConfidence?: number; damage?: number; ocr?: string[] } = {}): VisionProvider {
  const modelVersion = "test-vision-1";
  return {
    name: "test",
    classifyCategory: async () => ({ categorySlug: over.category ?? null, confidence: over.categoryConfidence ?? 0, modelVersion }),
    detectDamage: async () => ({ damage: over.damage ? [{ kind: "CRACK", score: over.damage }] : [], confidence: over.damage ?? 0, modelVersion }),
    ocr: async () => ({ text: over.ocr ?? [], confidence: over.ocr ? 0.95 : 0, modelVersion }),
  };
}

/** 900 px photo made of seeded random blocks (distinct perceptual hashes) with fine noise (sharp edges). */
async function texture(opts: { dark?: boolean; seed?: number } = {}) {
  const w = 900;
  let state = (opts.seed ?? ++textureSeed) * 2654435761;
  const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const blocks = Array.from({ length: 81 }, () => 60 + Math.floor(rand() * 140));
  const raw = Buffer.alloc(w * w * 3);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const base = opts.dark ? 10 : blocks[Math.floor(y / 100) * 9 + Math.floor(x / 100)]!;
      const v = Math.max(0, Math.min(255, base + Math.floor(rand() * 40) - 20));
      raw.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return sharp(raw, { raw: { width: w, height: w, channels: 3 } }).jpeg().toBuffer();
}

async function addPhoto(actor: typeof seller, listingId: string, shotType: string, body: Buffer) {
  const { photoId } = await requestPhotoUpload(db, { storage, bucket }, actor, { listingId, shotType, size: body.byteLength, type: "image/jpeg" });
  const row = await db.listingPhoto.findUniqueOrThrow({ where: { id: photoId } });
  await storage.put(bucket, row.incomingKey!, new Uint8Array(body), "image/jpeg");
  await confirmPhotoUpload(db, actor, photoId);
  expect(await processListingPhoto(db, { storage, bucket }, photoId)).toBe("ready");
  return photoId;
}

type Opts = { actor?: typeof seller; partNumberId?: string; price?: string; description?: string; darkFirst?: boolean; photo?: Buffer };

/** A submitted listing, built through the M4 services like a real seller. */
async function submitted(o: Opts = {}) {
  const actor = o.actor ?? seller;
  const draft = await createDraft(db, actor);
  await saveBike(db, actor, draft.id, { variantId: "sample-variant-street-150-std" });
  await savePart(db, actor, draft.id, { partNumberId: o.partNumberId ?? "sample-pn-brk-0001", partName: "Test part" });
  const st = await getWizardState(db, actor.userId, draft.id);
  await saveCondition(db, actor, draft.id, Object.fromEntries(st.checklist.map((i) => [i.id, i.badAnswer === "YES" ? "NO" : "YES"])));
  const shots = st.photoGuide.map((s) => s.shotType);
  while (shots.length < st.settings.risk.minPhotos) shots.push("extra");
  for (const [i, shot] of shots.entries()) await addPhoto(actor, draft.id, shot, i === 0 && o.photo ? o.photo : await texture({ dark: i === 0 && o.darkFirst }));
  await saveDetails(db, actor, draft.id, { description: o.description ?? "Removed from a running bike. Even wear, no cracks, works well." });
  const address = actor === seller2 ? "sample-addr-seller-nopayout" : "sample-addr-seller";
  await savePrice(db, actor, draft.id, { priceRupees: o.price ?? "800", pickupAddressId: address, weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode: "LOCAL_PICKUP" });
  expect(await submitListing(db, actor, draft.id)).toBeNull();
  return draft.id;
}

const run = (id: string, v = vision()) => runRiskCheck(db, { storage, bucket, vision: v }, id);

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
beforeEach(() => useRateLimitStore("memory"));
afterAll(async () => {
  useRateLimitStore("redis");
  await db.$disconnect();
});

describe("risk pipeline: persistence, versions and idempotency", () => {
  it("a clean Tier C listing goes LIVE with REQUIRED (TIER_C), SCREENED, and a fully recorded assessment", async () => {
    const id = await submitted();
    expect(await run(id)).toBe("LIVE");
    const { version } = await getActiveSettings(db);

    const listing = await db.listing.findUniqueOrThrow({ where: { id } });
    expect(listing).toMatchObject({ status: "LIVE", inspectionRequirement: "REQUIRED", inspectionReason: "TIER_C", trustLabel: "SCREENED", latestRiskScore: 0, sellerMessage: null });
    expect(listing.liveAt).not.toBeNull();

    const ra = await db.riskAssessment.findFirstOrThrow({ where: { listingId: id } });
    expect(ra).toMatchObject({ score: 0, hadHardFailure: false, ruleSetVersion: version, visionModelVersion: "test-vision-1", routingDecision: "LIVE", inspectionRequirement: "REQUIRED", inspectionReason: "TIER_C", trustLabel: "SCREENED" });
    const results = ra.checkResults as { stage1: Array<{ code: string; passed: boolean }>; stage2: Array<{ code: string }>; stage2Skipped: boolean; needsAdminReview: boolean };
    expect(results.stage2Skipped).toBe(false);
    expect(new Set(results.stage1.map((c) => c.code))).toEqual(new Set(["REQUIRED_FIELDS", "PHOTO_GUIDE", "MIN_RESOLUTION", "BLUR", "BRIGHTNESS", "DUPLICATE_PHOTO", "PRICE_OUTLIER", "BLOCKING_CHECKLIST", "CONTACT_DETAILS"]));
    expect(results.stage2.map((c) => c.code)).toEqual(["CATEGORY_MISMATCH", "DAMAGE_CONTRADICTION", "PART_NUMBER_OCR"]);
    expect(results.needsAdminReview).toBe(false);

    const events = (await db.listingEvent.findMany({ where: { listingId: id }, orderBy: { createdAt: "asc" } })).map((e) => [e.event, e.actorType]);
    expect(events).toEqual([["submit", "USER"], ["screeningStarted", "SYSTEM"], ["screeningPassed", "SYSTEM"]]);
    expect((await db.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(
      expect.arrayContaining(["listing.submitted", "listing.screening_started", "listing.live"]),
    );
    expect(await db.outboxJob.count({ where: { queue: "notifications", payload: { path: ["type"], equals: "listing.live" } } })).toBeGreaterThan(0);
  });

  it("is idempotent: running again (or for a non-submitted listing) does nothing", async () => {
    const id = await submitted();
    expect(await run(id)).toBe("LIVE");
    expect(await run(id)).toBe("skipped");
    expect(await db.riskAssessment.count({ where: { listingId: id } })).toBe(1);
    expect(await run("sample-listing-draft")).toBe("skipped");
  });

  it("the queued risk.check job from submit is relayed and processed", async () => {
    const id = await submitted();
    const jobs: Array<{ queue: string; name: string; payload: unknown }> = [];
    await relayOutbox(db, async (job) => {
      jobs.push(job);
    }, { limit: 1000 });
    const job = jobs.find((j) => j.queue === "risk" && (j.payload as { listingId: string }).listingId === id);
    expect(job?.name).toBe("check");
    expect(await run((job!.payload as { listingId: string }).listingId)).toBe("LIVE");
  });
});

describe("hard failures → CHANGES_REQUESTED", () => {
  it("a dark photo fails Stage 1; Stage 2 is skipped; the seller gets a fixable message with a step", async () => {
    const id = await submitted({ darkFirst: true });
    expect(await run(id)).toBe("CHANGES_REQUESTED");
    const ra = await db.riskAssessment.findFirstOrThrow({ where: { listingId: id } });
    expect(ra).toMatchObject({ hadHardFailure: true, routingDecision: "CHANGES_REQUESTED", inspectionRequirement: null, visionModelVersion: null });
    expect((ra.checkResults as { stage2Skipped: boolean }).stage2Skipped).toBe(true);
    const status = await screeningStatusForOwner(db, seller.userId, id);
    expect(status.status).toBe("CHANGES_REQUESTED");
    expect(status.fixes.map((f) => f.code)).toContain("BRIGHTNESS");
    expect(status.fixes.find((f) => f.code === "BRIGHTNESS")).toMatchObject({ step: "photos", message: expect.stringMatching(/^Photo 1 \(.+\) is too dark/) });
    expect(status.sellerMessage).toMatch(/too dark/);
    expect(await db.listingEvent.findFirst({ where: { listingId: id, event: "screeningFailed" } })).not.toBeNull();
  });

  it("another seller's copied photo is a HARD duplicate; the seller's own earlier photo is only a SOFT flag", async () => {
    const shared = await texture({ seed: 4242 });
    const first = await submitted({ photo: shared });
    expect(await run(first)).toBe("LIVE");

    // Same seller reusing their own photo: SOFT flag only, still LIVE, sent to admin review.
    const own = await submitted({ photo: shared });
    expect(await run(own)).toBe("LIVE");
    const ra = await db.riskAssessment.findFirstOrThrow({ where: { listingId: own } });
    expect((ra.reasons as Array<{ code: string }>).map((r) => r.code)).toContain("DUPLICATE_PHOTO_OWN");
    expect((ra.checkResults as { needsAdminReview: boolean }).needsAdminReview).toBe(true);

    // A different seller using the same photo: HARD failure.
    const copied = await submitted({ actor: seller2, photo: shared });
    expect(await run(copied)).toBe("CHANGES_REQUESTED");
    expect((await screeningStatusForOwner(db, seller2.userId, copied)).fixes.map((f) => f.code)).toContain("DUPLICATE_PHOTO");
  });
});

describe("high risk without hard failures stays LIVE and enters the admin queue (D-5)", () => {
  it("Tier B: SOFT flags push the score over the Tier B risk threshold → REQUIRED (HIGH_RISK); contact details are masked", async () => {
    const id = await submitted({ partNumberId: "sample-pn-lgt-0001", price: "600", description: "Tail light, works. Call 98765 43210 or rider@example.com for more photos." });
    expect(await run(id, vision({ category: "mirrors", categoryConfidence: 0.95, damage: 0.95 }))).toBe("LIVE");

    const listing = await db.listing.findUniqueOrThrow({ where: { id } });
    expect(listing).toMatchObject({ status: "LIVE", inspectionRequirement: "REQUIRED", inspectionReason: "HIGH_RISK", trustLabel: "SELLER_DECLARED" });
    expect(listing.latestRiskScore).toBe(77); // CONTACT 15 + CATEGORY 25×0.95 + DAMAGE 40×0.95
    expect(listing.description).not.toMatch(/98765|rider@example/);
    expect(listing.description).toMatch(/\[contact details hidden\]/);

    const queued = (await listingReviewQueue(db)).find((q) => q.id === id);
    expect(queued?.reviewReasons.join(" ")).toMatch(/Risk score 77.*Contact details were masked.*looks like mirrors.*possible crack damage/);
  });

  it("Tier B below the price threshold and risk threshold is OPTIONAL", async () => {
    const id = await submitted({ partNumberId: "sample-pn-lgt-0001", price: "500" });
    expect(await run(id)).toBe("LIVE");
    expect(await db.listing.findUniqueOrThrow({ where: { id } })).toMatchObject({ inspectionRequirement: "OPTIONAL", inspectionReason: null });
  });

  it("an OCR'd part number that differs is a SOFT flag; a matching one is recorded as a positive signal", async () => {
    const differs = await submitted();
    await run(differs, vision({ ocr: ["SAMPLE-XYZ-9999"] }));
    const r1 = await db.riskAssessment.findFirstOrThrow({ where: { listingId: differs } });
    expect((r1.reasons as Array<{ code: string }>).map((r) => r.code)).toContain("PART_NUMBER_OCR");

    const matches = await submitted();
    await run(matches, vision({ ocr: ["sample brk 0001"] }));
    const r2 = await db.riskAssessment.findFirstOrThrow({ where: { listingId: matches } });
    expect(r2.score).toBe(0);
    expect((r2.checkResults as { stage2: Array<{ code: string; passed: boolean; message: string }> }).stage2.find((c) => c.code === "PART_NUMBER_OCR")).toMatchObject({ passed: true, message: expect.stringMatching(/matches/) });
  });
});

describe("admin review decisions (L7, L8, keep live), all audited", () => {
  it("request changes sends a LIVE listing back with the reason; reject is terminal; clearing removes it from the queue", async () => {
    const flagged = await submitted({ description: "Works fine, message me on WhatsApp for a better price today." });
    expect(await run(flagged)).toBe("LIVE");
    expect((await listingReviewQueue(db)).some((q) => q.id === flagged)).toBe(true);
    await clearListingReview(db, admin, flagged, "Checked, fine.");
    expect((await listingReviewQueue(db)).some((q) => q.id === flagged)).toBe(false);

    await expect(adminRequestChanges(db, admin, { listingId: flagged, reason: "short" })).rejects.toThrow();
    await adminRequestChanges(db, admin, { listingId: flagged, reason: "Photo 3 shows a different part. Retake it showing this part." });
    const changed = await db.listing.findUniqueOrThrow({ where: { id: flagged } });
    expect(changed).toMatchObject({ status: "CHANGES_REQUESTED", sellerMessage: "Photo 3 shows a different part. Retake it showing this part." });
    await expect(adminRequestChanges(db, admin, { listingId: flagged, reason: "Another request while not live." })).rejects.toBeInstanceOf(UserError);

    await adminReject(db, admin, { listingId: flagged, reason: "Prohibited item: not a motorcycle part." });
    expect((await db.listing.findUniqueOrThrow({ where: { id: flagged } })).status).toBe("REJECTED");
    const actions = (await db.auditLog.findMany({ where: { entityId: flagged, actorType: "ADMIN" }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["listing.review_cleared", "listing.changes_requested_by_admin", "listing.rejected_by_admin"]);
  });

  it("sellers only see their own listing's status", async () => {
    const id = await submitted();
    await expect(screeningStatusForOwner(db, "sample-user-buyer", id)).rejects.toThrow(/doesn't exist/);
  });
});
