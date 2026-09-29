import "server-only";
import { randomUUID } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
import type { PrismaClient } from "@/generated/prisma/client";
import { brightness, laplacianVariance, MAX_LISTING_PHOTOS, MAX_PHOTO_BYTES, perceptualHash, sniffImageType } from "@/lib/listing";
import type { StorageProvider } from "../../adapters/storage/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { enqueueOutbox } from "../outbox/outbox";
import { EDITABLE, photoState } from "./listing";

/**
 * Listing photos (PLAN.md §1.2 "Photos"):
 *  1. The browser uploads straight to a private `incoming/` key through a short-lived signed URL.
 *  2. The seller confirms the upload; an outbox job asks the worker to process it.
 *  3. The worker checks the real file type and size, re-encodes with sharp (applies orientation and
 *     drops all EXIF, including GPS), measures quality, writes the clean file and deletes the original.
 * Only processed files are ever shown, through signed download URLs. The bucket is private.
 * A processed row without a storageKey means the file couldn't be used.
 */
type Db = PrismaClient;
type Actor = { userId: string; requestId?: string };
export type PhotoDeps = { storage: StorageProvider; bucket: string };

const UPLOAD_TTL_SECONDS = 300;
const VIEW_TTL_SECONDS = 600;
const MAX_EDGE_PX = 2048;
const MAX_INPUT_PIXELS = 50_000_000;
/** Quality metrics are measured on a greyscale copy that fits in 512×512, on the browser and the server. */
export const METRIC_EDGE_PX = 512;

async function ownedPhoto(db: Pick<Db, "listingPhoto">, userId: string, photoId: string) {
  const photo = await db.listingPhoto.findFirst({ where: { id: photoId, listing: { sellerId: userId } }, include: { listing: { select: { id: true, status: true, categoryId: true } } } });
  if (!photo) throw new NotFoundError("photo");
  return photo;
}

async function editableListing(db: Pick<Db, "listing">, userId: string, listingId: string) {
  const listing = await db.listing.findFirst({ where: { id: listingId, sellerId: userId } });
  if (!listing) throw new NotFoundError("listing");
  if (!EDITABLE.includes(listing.status)) throw new UserError("Photos can't be changed on this listing in its current state.");
  return listing;
}

/** Step 1: reserve a photo slot and return a signed upload URL for the browser. */
export async function requestPhotoUpload(db: Db, deps: PhotoDeps, actor: Actor, input: { listingId: string; shotType: string; size: number; type: string }) {
  const listing = await editableListing(db, actor.userId, input.listingId);
  if (!listing.categoryId) throw new UserError("Choose the part first, so we can show which photos to take.");
  const category = await db.partCategory.findUniqueOrThrow({ where: { id: listing.categoryId } });
  const shots = (category.photoGuide as Array<{ shotType: string }>).map((s) => s.shotType);
  if (input.shotType !== "extra" && !shots.includes(input.shotType)) throw new FieldError({ shotType: "Choose one of the photos in the shot list." });
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.type)) throw new FieldError({ file: "Use a JPEG, PNG or WebP photo." });
  if (input.size <= 0 || input.size > MAX_PHOTO_BYTES) throw new FieldError({ file: "Photos must be under 10 MB." });

  const count = await db.listingPhoto.count({ where: { listingId: listing.id } });
  if (count >= MAX_LISTING_PHOTOS) throw new UserError(`A listing can have up to ${MAX_LISTING_PHOTOS} photos. Remove one first.`);

  const incomingKey = `incoming/${actor.userId}/${listing.id}/${randomUUID()}`;
  const photo = await db.listingPhoto.create({ data: { listingId: listing.id, shotType: input.shotType, sortOrder: count, incomingKey } });
  const upload = await deps.storage.createSignedUploadUrl(deps.bucket, incomingKey, UPLOAD_TTL_SECONDS);
  return { photoId: photo.id, uploadUrl: upload.url, expiresInSeconds: upload.expiresInSeconds };
}

/** Step 2: the browser finished uploading; queue processing. */
export async function confirmPhotoUpload(db: Db, actor: Actor, photoId: string) {
  const photo = await ownedPhoto(db, actor.userId, photoId);
  if (!EDITABLE.includes(photo.listing.status)) throw new UserError("Photos can't be changed on this listing in its current state.");
  if (photo.processedAt || !photo.incomingKey) return;
  await db.$transaction(async (tx) => {
    await enqueueOutbox(tx, { queue: "photos", name: "process", payload: { photoId } });
    await recordAudit(tx, {
      actor: { type: "USER", id: actor.userId },
      action: "listing.photo_added",
      entity: { type: "Listing", id: photo.listingId },
      after: { photoId, shotType: photo.shotType },
      requestId: actor.requestId,
    });
  });
}

async function greyscale(image: Buffer, width: number, height: number, fit: "inside" | "fill") {
  const { data, info } = await sharp(image).greyscale().resize(width, height, { fit }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Quality metrics of an already-decoded image buffer. */
export async function measurePhoto(image: Buffer) {
  const g = await greyscale(image, METRIC_EDGE_PX, METRIC_EDGE_PX, "inside");
  const small = await greyscale(image, 32, 32, "fill");
  return { brightness: brightness(g.data), blur: laplacianVariance(g.data, g.width, g.height), pHash: perceptualHash(small.data) };
}

/** Step 3 (worker): idempotent. Re-running for a processed photo does nothing. */
export async function processListingPhoto(db: Db, deps: PhotoDeps, photoId: string): Promise<"ready" | "failed" | "skipped"> {
  const photo = await db.listingPhoto.findUnique({ where: { id: photoId } });
  if (!photo || photo.processedAt || !photo.incomingKey) return "skipped";
  const fail = async (reason: string) => {
    logger.warn({ photoId, reason }, "listing photo rejected");
    await deps.storage.delete(deps.bucket, photo.incomingKey!).catch(() => {});
    await db.listingPhoto.update({ where: { id: photoId }, data: { processedAt: new Date(), incomingKey: null, storageKey: null } });
    return "failed" as const;
  };

  const original = await deps.storage.get(deps.bucket, photo.incomingKey);
  if (!original) return fail("upload missing");
  if (original.byteLength > MAX_PHOTO_BYTES) return fail("too large");
  if (!sniffImageType(original)) return fail("not a JPEG, PNG or WebP image");

  let clean: Buffer;
  let info: OutputInfo;
  try {
    // rotate() applies the EXIF orientation; output carries no metadata unless asked for, so EXIF/GPS is dropped.
    ({ data: clean, info } = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize(MAX_EDGE_PX, MAX_EDGE_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    return fail(`decode failed: ${(err as Error).message}`);
  }
  const metrics = await measurePhoto(clean);
  const storageKey = `listings/${photo.listingId}/${photo.id}.jpg`;
  await deps.storage.put(deps.bucket, storageKey, new Uint8Array(clean), "image/jpeg");
  await deps.storage.delete(deps.bucket, photo.incomingKey).catch(() => {});
  await db.listingPhoto.update({
    where: { id: photoId },
    data: {
      storageKey,
      incomingKey: null,
      processedAt: new Date(),
      width: info.width,
      height: info.height,
      pHash: metrics.pHash,
      blurScore: metrics.blur,
      brightnessScore: metrics.brightness,
    },
  });
  return "ready";
}

/** Removes a photo (and its files) and closes the gap in the order. */
export async function deletePhoto(db: Db, deps: PhotoDeps, actor: Actor, photoId: string) {
  const photo = await ownedPhoto(db, actor.userId, photoId);
  if (!EDITABLE.includes(photo.listing.status)) throw new UserError("Photos can't be changed on this listing in its current state.");
  await db.$transaction(async (tx) => {
    await tx.listingPhoto.delete({ where: { id: photoId } });
    const rest = await tx.listingPhoto.findMany({ where: { listingId: photo.listingId }, orderBy: { sortOrder: "asc" }, select: { id: true } });
    for (const [i, p] of rest.entries()) await tx.listingPhoto.update({ where: { id: p.id }, data: { sortOrder: i } });
    await recordAudit(tx, {
      actor: { type: "USER", id: actor.userId },
      action: "listing.photo_removed",
      entity: { type: "Listing", id: photo.listingId },
      before: { photoId, shotType: photo.shotType },
      requestId: actor.requestId,
    });
  });
  for (const key of [photo.storageKey, photo.incomingKey]) if (key) await deps.storage.delete(deps.bucket, key).catch(() => {});
}

/** Moves a photo one place, or to the front (the first photo is the main photo buyers see). */
export async function movePhoto(db: Db, actor: Actor, photoId: string, to: "up" | "down" | "first") {
  const photo = await ownedPhoto(db, actor.userId, photoId);
  if (!EDITABLE.includes(photo.listing.status)) throw new UserError("Photos can't be changed on this listing in its current state.");
  await db.$transaction(async (tx) => {
    const ids = (await tx.listingPhoto.findMany({ where: { listingId: photo.listingId }, orderBy: { sortOrder: "asc" }, select: { id: true } })).map((p) => p.id);
    const i = ids.indexOf(photoId);
    const j = to === "first" ? 0 : to === "up" ? Math.max(0, i - 1) : Math.min(ids.length - 1, i + 1);
    ids.splice(i, 1);
    ids.splice(j, 0, photoId);
    for (const [k, id] of ids.entries()) await tx.listingPhoto.update({ where: { id }, data: { sortOrder: k } });
  });
}

/** The owner's photos with short-lived view URLs for processed ones. */
export async function listPhotosForOwner(db: Db, deps: PhotoDeps, userId: string, listingId: string) {
  const listing = await db.listing.findFirst({ where: { id: listingId, sellerId: userId }, select: { id: true } });
  if (!listing) throw new NotFoundError("listing");
  const photos = await db.listingPhoto.findMany({ where: { listingId }, orderBy: { sortOrder: "asc" } });
  return Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      shotType: p.shotType,
      sortOrder: p.sortOrder,
      status: photoState(p),
      width: p.width,
      height: p.height,
      url: p.storageKey ? await deps.storage.createSignedDownloadUrl(deps.bucket, p.storageKey, VIEW_TTL_SECONDS) : null,
    })),
  );
}
