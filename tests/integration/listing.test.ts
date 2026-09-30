import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { MAX_LISTING_PHOTOS } from "../../src/lib/listing";
import { createMemoryStorageProvider } from "../../src/server/adapters/storage/memory";
import { FieldError, NotFoundError, RateLimitedError, UserError } from "../../src/server/http/errors";
import { consumeRateLimit, rateLimitsFromSettings, useRateLimitStore } from "../../src/server/http/rate-limit";
import {
  createDraft,
  getWizardState,
  listSellerListings,
  saveBike,
  saveCondition,
  saveDetails,
  savePart,
  savePrice,
  submitListing,
  suggestedVariants,
  withdrawListing,
} from "../../src/server/services/listing/listing";
import { confirmPhotoUpload, deletePhoto, listPhotosForOwner, movePhoto, processListingPhoto, requestPhotoUpload } from "../../src/server/services/listing/photos";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const seller = { userId: "sample-user-seller", requestId: "req-l" };
const other = { userId: "sample-user-buyer" };
const noPayout = { userId: "sample-user-seller-nopayout", requestId: "req-np" };
const storage = createMemoryStorageProvider();
const deps = { storage, bucket: "listing-photos" };

/** A textured JPEG carrying GPS EXIF, like a phone photo. */
async function phonePhoto(seed = 1) {
  const w = 400;
  const raw = Buffer.alloc(w * w * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (Math.sin(i * 0.013 * seed) * 60 + ((i * 7919 * seed) % 97)) & 0xff;
  return sharp(raw, { raw: { width: w, height: w, channels: 3 } })
    .jpeg()
    .withExif({ IFD0: { Make: "SampleCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 1/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 35/1 1/1" } })
    .toBuffer();
}

/** Request a slot, "upload" the file to the signed key, confirm and process, like browser + worker. */
async function addPhoto(listingId: string, shotType: string, bytes?: Buffer, actor = seller) {
  const body = bytes ?? (await phonePhoto());
  const { photoId } = await requestPhotoUpload(db, deps, actor, { listingId, shotType, size: body.byteLength, type: "image/jpeg" });
  const row = await db.listingPhoto.findUniqueOrThrow({ where: { id: photoId } });
  await storage.put(deps.bucket, row.incomingKey!, new Uint8Array(body), "image/jpeg");
  await confirmPhotoUpload(db, actor, photoId);
  return { photoId, result: await processListingPhoto(db, deps, photoId) };
}

async function completeDraft(actor = seller, addressId = "sample-addr-seller", fulfilmentMode = "LOCAL_PICKUP") {
  const draft = await createDraft(db, actor);
  await saveBike(db, actor, draft.id, { variantId: "sample-variant-street-150-std" });
  await savePart(db, actor, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Front brake pads", confirmedVariantIds: ["sample-variant-street-150-std"] });
  const state = await getWizardState(db, actor.userId, draft.id);
  await saveCondition(db, actor, draft.id, Object.fromEntries(state.checklist.map((i) => [i.id, i.badAnswer === "YES" ? "NO" : "YES"])));
  const shots = state.photoGuide.map((s) => s.shotType);
  for (const shot of shots) await addPhoto(draft.id, shot, undefined, actor);
  for (let i = shots.length; i < state.settings.risk.minPhotos; i++) await addPhoto(draft.id, "extra", undefined, actor);
  await saveDetails(db, actor, draft.id, { description: "Removed from a running bike at 12,000 km. Even wear, no cracks.", kmUsedApprox: "12000" });
  await savePrice(db, actor, draft.id, { priceRupees: "850", pickupAddressId: addressId, weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode });
  return draft;
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
beforeEach(() => useRateLimitStore("memory"));
afterAll(async () => {
  useRateLimitStore("redis");
  await db.$disconnect();
});

describe("ownership", () => {
  it("other members can't see or edit a listing, and can't use someone else's garage bike or address", async () => {
    const draft = await createDraft(db, seller);
    await expect(getWizardState(db, other.userId, draft.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveBike(db, other, draft.id, { variantId: "sample-variant-street-150-std" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveBike(db, seller, draft.id, { garageVehicleId: "sample-garage-buyer-roadster" })).rejects.toBeInstanceOf(FieldError);
    await expect(savePrice(db, seller, draft.id, { priceRupees: "500", pickupAddressId: "sample-addr-buyer", weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode: "LOCAL_PICKUP" })).rejects.toBeInstanceOf(FieldError);
    await expect(withdrawListing(db, other, draft.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestPhotoUpload(db, deps, other, { listingId: draft.id, shotType: "extra", size: 100, type: "image/jpeg" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("wizard steps", () => {
  it("part: must be a catalogue number; category comes from it; only suggested vehicles are saved", async () => {
    const draft = await createDraft(db, seller);
    await expect(savePart(db, seller, draft.id, { partNumberId: "nope", partName: "Pads" })).rejects.toBeInstanceOf(FieldError);
    const suggested = (await suggestedVariants(db, "sample-pn-brk-0001")).map((v) => v.id).sort();
    expect(suggested).toEqual(["sample-variant-roadster-200-std", "sample-variant-street-150-disc", "sample-variant-street-150-std"]);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Front brake pads", confirmedVariantIds: ["sample-variant-street-150-std", "sample-variant-city-125-std"] });
    const state = await getWizardState(db, seller.userId, draft.id);
    expect(state.category?.slug).toBe("brake-pads");
    expect(state.fitments.filter((f) => f.source === "PART_NUMBER_MATCH").map((f) => f.variant.id)).toEqual(["sample-variant-street-150-std"]);
  });

  it("condition: every question must be answered; the grade follows the settings thresholds", async () => {
    const draft = await createDraft(db, seller);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    const { checklist } = await getWizardState(db, seller.userId, draft.id);
    await expect(saveCondition(db, seller, draft.id, {})).rejects.toBeInstanceOf(FieldError);
    const allGood = Object.fromEntries(checklist.map((i) => [i.id, i.badAnswer === "YES" ? "NO" : "YES"]));
    expect(await saveCondition(db, seller, draft.id, allGood)).toEqual({ score: 100, grade: "LIKE_NEW" });
  });

  it("details and price are validated; local-pickup-only categories refuse delivery", async () => {
    const draft = await createDraft(db, seller);
    await expect(saveDetails(db, seller, draft.id, { description: "too short" })).rejects.toThrow();
    await expect(savePrice(db, seller, draft.id, { priceRupees: "10", pickupAddressId: "sample-addr-seller", weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode: "LOCAL_PICKUP" })).rejects.toThrow(/lowest price/);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    await db.partCategory.update({ where: { slug: "brake-pads" }, data: { shippingRestriction: "NOT_SHIPPABLE" } });
    try {
      await expect(savePrice(db, seller, draft.id, { priceRupees: "500", pickupAddressId: "sample-addr-seller", weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode: "DELIVERY" })).rejects.toThrow(/local pickup/);
    } finally {
      await db.partCategory.update({ where: { slug: "brake-pads" }, data: { shippingRestriction: "NONE" } });
    }
    await savePrice(db, seller, draft.id, { priceRupees: "499.50", pickupAddressId: "sample-addr-seller", weightBand: "UNDER_1KG", dimensionBand: "SMALL", fulfilmentMode: "DELIVERY" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).pricePaise).toBe(49950);
  });
});

describe("photos", () => {
  it("validates type, size and shot, and never hands out anything but a signed upload URL", async () => {
    const draft = await createDraft(db, seller);
    await expect(requestPhotoUpload(db, deps, seller, { listingId: draft.id, shotType: "front", size: 100, type: "image/jpeg" })).rejects.toThrow(/Choose the part first/);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    const req = (over: object) => requestPhotoUpload(db, deps, seller, { listingId: draft.id, shotType: "front", size: 1000, type: "image/jpeg", ...over });
    await expect(req({ type: "image/gif" })).rejects.toBeInstanceOf(FieldError);
    await expect(req({ size: 11 * 1024 * 1024 })).rejects.toBeInstanceOf(FieldError);
    await expect(req({ size: 0 })).rejects.toBeInstanceOf(FieldError);
    await expect(req({ shotType: "selfie" })).rejects.toBeInstanceOf(FieldError);
    const ok = await req({});
    expect(ok.uploadUrl).toMatch(/^memory:\/\/upload\/listing-photos\/incoming\//);
  });

  it("processing strips EXIF (including GPS), re-encodes to JPEG, records metrics and deletes the original", async () => {
    const draft = await createDraft(db, seller);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    const original = await phonePhoto();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const { photoId, result } = await addPhoto(draft.id, "front", original);
    expect(result).toBe("ready");
    const row = await db.listingPhoto.findUniqueOrThrow({ where: { id: photoId } });
    expect(row).toMatchObject({ incomingKey: null, storageKey: `listings/${draft.id}/${photoId}.jpg`, width: 400, height: 400 });
    expect(row.pHash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.blurScore).toBeGreaterThan(0);

    const stored = await storage.get(deps.bucket, row.storageKey!);
    const meta = await sharp(Buffer.from(stored!)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect([...storage.objects.keys()].some((k) => k.includes(`/${draft.id}/`) && k.includes("incoming/"))).toBe(false);
    expect(await processListingPhoto(db, deps, photoId)).toBe("skipped"); // idempotent
    expect(await db.outboxJob.count({ where: { queue: "photos", payload: { equals: { photoId } } } })).toBe(1);
  });

  it("files that aren't images are rejected by content, whatever type the browser declared", async () => {
    const draft = await createDraft(db, seller);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    const { photoId, result } = await addPhoto(draft.id, "front", Buffer.from("%PDF-1.7 not a photo"));
    expect(result).toBe("failed");
    expect((await getWizardState(db, seller.userId, draft.id)).photos.find((p) => p.id === photoId)?.status).toBe("failed");
  });

  it("enforces the photo limit, orders photos, and deletes files with the row", async () => {
    const draft = await createDraft(db, seller);
    await savePart(db, seller, draft.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    for (let i = 0; i < MAX_LISTING_PHOTOS; i++) await requestPhotoUpload(db, deps, seller, { listingId: draft.id, shotType: "extra", size: 1000, type: "image/jpeg" });
    await expect(requestPhotoUpload(db, deps, seller, { listingId: draft.id, shotType: "extra", size: 1000, type: "image/jpeg" })).rejects.toThrow(/up to 12 photos/);

    const draft2 = await createDraft(db, seller);
    await savePart(db, seller, draft2.id, { partNumberId: "sample-pn-brk-0001", partName: "Pads" });
    const a = await addPhoto(draft2.id, "front");
    const b = await addPhoto(draft2.id, "back");
    await movePhoto(db, seller, b.photoId, "first");
    expect((await listPhotosForOwner(db, deps, seller.userId, draft2.id)).map((p) => p.id)).toEqual([b.photoId, a.photoId]);
    await expect(movePhoto(db, other, a.photoId, "first")).rejects.toBeInstanceOf(NotFoundError);
    await expect(deletePhoto(db, deps, other, a.photoId)).rejects.toBeInstanceOf(NotFoundError);

    const key = (await db.listingPhoto.findUniqueOrThrow({ where: { id: b.photoId } })).storageKey!;
    await deletePhoto(db, deps, seller, b.photoId);
    expect(await storage.get(deps.bucket, key)).toBeNull();
    const rest = await listPhotosForOwner(db, deps, seller.userId, draft2.id);
    expect(rest.map((p) => [p.id, p.sortOrder])).toEqual([[a.photoId, 0]]);
    expect(rest[0]?.url).toMatch(/ttl=600/);
    expect(await db.auditLog.count({ where: { entityId: draft2.id, action: { in: ["listing.photo_added", "listing.photo_removed"] } } })).toBe(3);
  });
});

describe("submit and withdraw (M4 state transitions)", () => {
  it("listing submission is rate limited per seller (M13 review): over the limit, a complete draft stays a draft", async () => {
    const draft = await completeDraft();
    const { listingSubmissionsPerUser } = await rateLimitsFromSettings(db);
    for (let i = 0; i < listingSubmissionsPerUser.points; i++) await consumeRateLimit(db, "listingSubmissionsPerUser", seller.userId);
    await expect(submitListing(db, seller, draft.id)).rejects.toBeInstanceOf(RateLimitedError);
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    useRateLimitStore("memory"); // other members and later tests start fresh
    expect(await submitListing(db, seller, draft.id)).toBeNull();
  });

  it("an incomplete draft reports what's missing and stays a draft", async () => {
    const draft = await createDraft(db, seller);
    const report = await submitListing(db, seller, draft.id);
    expect(report?.bike.length).toBeGreaterThan(0);
    expect(report?.photos.join(" ")).toMatch(/at least 3 photos/);
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
  });

  it("a complete draft is submitted with an event, audit entry and a queued risk check; then it's locked", async () => {
    const draft = await completeDraft();
    expect(await submitListing(db, seller, draft.id)).toBeNull();
    const listing = await db.listing.findUniqueOrThrow({ where: { id: draft.id } });
    expect(listing).toMatchObject({ status: "SUBMITTED", version: 1 });
    expect(listing.submittedAt).not.toBeNull();
    expect(await db.listingEvent.findFirst({ where: { listingId: draft.id } })).toMatchObject({ fromStatus: "DRAFT", toStatus: "SUBMITTED", event: "submit", actorType: "USER" });
    expect(await db.auditLog.count({ where: { entityId: draft.id, action: "listing.submitted" } })).toBe(1);
    expect(await db.outboxJob.count({ where: { queue: "risk", name: "check", payload: { equals: { listingId: draft.id } } } })).toBe(1);

    await expect(submitListing(db, seller, draft.id)).rejects.toBeInstanceOf(UserError);
    await expect(saveDetails(db, seller, draft.id, { description: "Changing the text after submitting it." })).rejects.toThrow(/can't be edited/);
    await expect(withdrawListing(db, seller, draft.id)).rejects.toThrow(/can't be withdrawn/);
  });

  it("delivery needs an active payout account; local pickup doesn't", async () => {
    const delivery = await completeDraft(noPayout, "sample-addr-seller-nopayout", "DELIVERY");
    await expect(submitListing(db, noPayout, delivery.id)).rejects.toThrow(/payout account must be active/);
    const pickup = await completeDraft(noPayout, "sample-addr-seller-nopayout", "LOCAL_PICKUP");
    expect(await submitListing(db, noPayout, pickup.id)).toBeNull();
  });

  it("changes requested can be resubmitted; drafts can be withdrawn", async () => {
    const draft = await completeDraft();
    await db.listing.update({ where: { id: draft.id }, data: { status: "CHANGES_REQUESTED" } });
    expect(await submitListing(db, seller, draft.id)).toBeNull();
    expect((await db.listingEvent.findFirstOrThrow({ where: { listingId: draft.id } })).event).toBe("resubmit");

    const other = await createDraft(db, seller);
    await withdrawListing(db, seller, other.id);
    expect((await db.listing.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("WITHDRAWN");
  });

  it("the seller dashboard groups listings by status", async () => {
    const groups = await listSellerListings(db, seller.userId);
    expect(groups.get("DRAFT")?.length).toBeGreaterThan(0);
    expect(groups.get("SUBMITTED")?.length).toBeGreaterThan(0);
    expect([...groups.values()].flat().every((l) => l.id)).toBe(true);
  });
});
