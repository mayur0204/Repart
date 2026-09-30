import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DisputeReason, type PrismaClient } from "@/generated/prisma/client";
import { MAX_PHOTO_BYTES } from "@/lib/listing";
import type { ShippingProvider } from "../../adapters/shipping/types";
import type { StorageProvider } from "../../adapters/storage/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { cleanPhoto } from "../listing/photos";
import { enqueueOutbox } from "../outbox/outbox";
import { getActiveSettings } from "../settings/settings";
import { pickupSlots } from "./fulfilment";
import { PAID_OPEN_STATES, transitionOrder } from "./state";

/**
 * Acceptance, disputes, reviews and the provider hold-deadline watch (M11; PLAN.md §5.2 O18–O22, §5.3, §6.6).
 * Money moves only through the M8 services (refunds, settlement release); state only through transitionOrder.
 * Disputes are never resolved automatically (decision D-6).
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };
export type DisputeDeps = { storage: StorageProvider; bucket: string; shipping: ShippingProvider };

const HOUR_MS = 3_600_000;
export const SELLER_RESPONSE_HOURS = 48;
export const MAX_EVIDENCE_PHOTOS = 5;
export const OPEN_DISPUTE = ["OPEN", "AWAITING_SELLER", "UNDER_REVIEW"] as const;
const VIEW_TTL_SECONDS = 600;

const notify = async (tx: Tx, userIds: string[], type: string, title: string, body: string, link: string) => {
  for (const userId of userIds) await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId, channel: "IN_APP", type, title, body, link } });
};
const adminIds = async (tx: Pick<Tx, "user">) => (await tx.user.findMany({ where: { roles: { has: "ADMIN" }, status: "ACTIVE" }, select: { id: true } })).map((a) => a.id);

// ── fitment learning (PLAN.md §6.6, brief §7) ──

/**
 * The fitment path that connected the buyer's vehicle to this part, worked out at completion from the buyer's
 * primary garage vehicle (checkout doesn't record it): the listing's own fitments for that vehicle, part-number
 * fitments for the listing's part number, and one hop of approved interchange links to a part number that has a
 * fitment for that vehicle. No primary vehicle, or no match → empty (nothing is made up).
 */
async function fitmentPath(tx: Tx, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { buyerId: true, listingId: true, listing: { select: { partNumberId: true } } } });
  const vehicle = await tx.garageVehicle.findFirst({ where: { userId: o.buyerId, isPrimary: true }, select: { variantId: true } });
  if (!vehicle) return { fitmentIds: [] as string[], linkIds: [] as string[] };
  const pn = o.listing.partNumberId;
  const links = pn ? await tx.interchangeLink.findMany({ where: { status: "APPROVED", OR: [{ partNumberAId: pn }, { partNumberBId: pn }] }, select: { id: true, partNumberAId: true, partNumberBId: true } }) : [];
  const neighbours = links.map((l) => (l.partNumberAId === pn ? l.partNumberBId : l.partNumberAId));
  const fitments = await tx.fitment.findMany({
    where: { variantId: vehicle.variantId, verdict: "FITS", OR: [{ listingId: o.listingId }, ...(pn ? [{ partNumberId: { in: [pn, ...neighbours] } }] : [])] },
    select: { id: true, partNumberId: true },
  });
  const viaNeighbour = new Set(fitments.map((f) => f.partNumberId).filter((p): p is string => !!p && p !== pn));
  return { fitmentIds: fitments.map((f) => f.id), linkIds: links.filter((l) => viaNeighbour.has(l.partNumberAId === pn ? l.partNumberBId : l.partNumberAId)).map((l) => l.id) };
}

/** Confirm (completion) or flag (DOES_NOT_FIT) the path once per order; the audit entry is the idempotency record. */
async function learnFitment(tx: Tx, orderId: string, kind: "confirmed" | "flagged") {
  const action = kind === "confirmed" ? "order.fitment_confirmed" : "order.fitment_flagged";
  if (await tx.auditLog.count({ where: { entityType: "Order", entityId: orderId, action } })) return;
  const path = await fitmentPath(tx, orderId);
  if (kind === "confirmed") {
    await tx.fitment.updateMany({ where: { id: { in: path.fitmentIds } }, data: { confirmationCount: { increment: 1 } } });
    await tx.interchangeLink.updateMany({ where: { id: { in: path.linkIds } }, data: { confirmationCount: { increment: 1 } } });
  } else {
    await tx.fitment.updateMany({ where: { id: { in: path.fitmentIds } }, data: { flaggedCount: { increment: 1 }, inReviewQueue: true } });
    await tx.interchangeLink.updateMany({ where: { id: { in: path.linkIds } }, data: { flaggedCount: { increment: 1 }, inReviewQueue: true } });
  }
  await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action, entity: { type: "Order", id: orderId }, after: { fitmentIds: path.fitmentIds, interchangeLinkIds: path.linkIds } });
}

// ── acceptance (O18 / O19) ──

async function complete(tx: Tx, orderId: string, event: "buyerAccepted" | "acceptanceTimeout", actor: { type: "USER" | "SYSTEM"; id: string | null }, requestId?: string) {
  await transitionOrder(tx, { orderId, event, actor, requestId }); // COMPLETED; state.ts queues the M8 settlement release (it re-checks every guard)
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { buyerId: true, sellerId: true } });
  // PLAN §6.6: only a completion without a DOES_NOT_FIT dispute confirms the path (a COMPLETED order never had one).
  await learnFitment(tx, orderId, "confirmed");
  await notify(tx, [o.buyerId, o.sellerId], "order.review_prompt", "How did it go?", "Leave a quick review for this order.", `/orders/${orderId}/review`);
}

/** O18 "Confirm it's OK". Refused once the window has ended (the timer completes it instead). */
export async function acceptOrder(db: Db, actor: Actor, orderId: string, now = new Date()) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, state: true, acceptanceEndsAt: true } });
  if (!o || o.buyerId !== actor.userId) throw new NotFoundError("order");
  if (o.state === "COMPLETED") return { already: true };
  if (o.state !== "ACCEPTANCE_WINDOW") throw new UserError("This order isn't waiting for you to check the part.");
  if (o.acceptanceEndsAt && o.acceptanceEndsAt <= now) throw new UserError("The time to check the part has ended, so the order completes automatically.");
  await db.$transaction((tx) => complete(tx, orderId, "buyerAccepted", { type: "USER", id: actor.userId }, actor.requestId));
  return { already: false };
}

/** O19: the window ended without a confirmation or a problem report. Does nothing if the order moved on. */
export async function acceptanceTimeout(db: Db, orderId: string, now = new Date()): Promise<"completed" | "not_due"> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { state: true, acceptanceEndsAt: true } });
  if (!o || o.state !== "ACCEPTANCE_WINDOW" || !o.acceptanceEndsAt || o.acceptanceEndsAt > now) return "not_due";
  try {
    await db.$transaction((tx) => complete(tx, orderId, "acceptanceTimeout", { type: "SYSTEM", id: null }));
  } catch (err) {
    if (err instanceof UserError) return "not_due"; // moved on concurrently (buyer confirmed or reported)
    throw err;
  }
  return "completed";
}

// ── report a problem (O20) ──

export const reportInput = z.object({
  reason: z.enum(["DOES_NOT_FIT", "NOT_AS_DESCRIBED", "DAMAGED_IN_TRANSIT", "NOT_RECEIVED", "OTHER"], { message: "Choose what went wrong." }),
  description: z.string().trim().min(20, "Describe the problem in at least 20 characters.").max(2000, "Keep it under 2000 characters."),
});

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new FieldError(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  return r.data;
}

/** Buyer only, only during the acceptance window, one dispute per order. Photos are added afterwards (max 5). */
export async function reportProblem(db: Db, actor: Actor, orderId: string, raw: unknown, now = new Date()) {
  const input = parse(reportInput, raw);
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, sellerId: true, state: true, acceptanceEndsAt: true, dispute: { select: { id: true } } } });
  if (!o || o.buyerId !== actor.userId) throw new NotFoundError("order");
  if (o.dispute) throw new UserError("A problem has already been reported for this order.");
  if (o.state !== "ACCEPTANCE_WINDOW") throw new UserError("Problems can only be reported while you're checking the part.");
  if (o.acceptanceEndsAt && o.acceptanceEndsAt <= now) throw new UserError("The time to report a problem has ended.");
  try {
    return await db.$transaction(async (tx) => {
      const d = await tx.dispute.create({ data: { orderId, reason: input.reason as DisputeReason, description: input.description, status: "AWAITING_SELLER" }, select: { id: true } });
      await transitionOrder(tx, { orderId, event: "problemReported", actor: { type: "USER", id: actor.userId }, requestId: actor.requestId, payload: { disputeId: d.id, reason: input.reason } });
      await recordAudit(tx, { actor: { type: "USER", id: actor.userId }, action: "dispute.opened", entity: { type: "Dispute", id: d.id }, after: { orderId, reason: input.reason }, requestId: actor.requestId });
      if (input.reason === "DOES_NOT_FIT") await learnFitment(tx, orderId, "flagged");
      const deadline = new Date(now.getTime() + SELLER_RESPONSE_HOURS * HOUR_MS);
      await notify(tx, [o.sellerId], "dispute.opened", "Problem reported", `The buyer reported a problem. Respond by ${deadline.toISOString().slice(0, 16).replace("T", " ")} UTC with your side and any photos.`, `/orders/${orderId}/dispute`);
      await notify(tx, await adminIds(tx), "dispute.opened", "New dispute", "A buyer reported a problem with an order.", `/admin/disputes/${d.id}`);
      return d.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new UserError("A problem has already been reported for this order.");
    throw err;
  }
}

// ── seller response ──

export const sellerResponseDeadline = (createdAt: Date) => new Date(createdAt.getTime() + SELLER_RESPONSE_HOURS * HOUR_MS);

export const responseInput = z.object({ response: z.string().trim().min(10, "Write at least 10 characters.").max(2000, "Keep it under 2000 characters.") });

/** Seller's side, within 48 hours of the report. Moves the dispute to UNDER_REVIEW; an admin still decides. */
export async function sellerRespond(db: Db, actor: Actor, orderId: string, raw: unknown, now = new Date()) {
  const input = parse(responseInput, raw);
  const d = await db.dispute.findUnique({ where: { orderId }, include: { order: { select: { sellerId: true } } } });
  if (!d || d.order.sellerId !== actor.userId) throw new NotFoundError("dispute");
  if (!OPEN_DISPUTE.includes(d.status as (typeof OPEN_DISPUTE)[number])) throw new UserError("This dispute is already resolved.");
  if (d.sellerRespondedAt) throw new UserError("You've already responded to this dispute.");
  if (sellerResponseDeadline(d.createdAt) <= now) throw new UserError("The time to respond has ended. RePart will review the dispute.");
  await db.$transaction(async (tx) => {
    await tx.dispute.update({ where: { id: d.id }, data: { sellerResponse: input.response, sellerRespondedAt: now, status: "UNDER_REVIEW" } });
    await recordAudit(tx, { actor: { type: "USER", id: actor.userId }, action: "dispute.seller_responded", entity: { type: "Dispute", id: d.id }, after: { status: "UNDER_REVIEW" }, requestId: actor.requestId });
    await notify(tx, await adminIds(tx), "dispute.seller_responded", "Seller responded", "The seller responded to a dispute.", `/admin/disputes/${d.id}`);
  });
}

// ── evidence photos (private dispute-evidence bucket, signed URLs, EXIF removed) ──

async function evidenceParty(db: Pick<Db, "dispute">, userId: string, disputeId: string, now: Date) {
  const d = await db.dispute.findUnique({ where: { id: disputeId }, include: { order: { select: { buyerId: true, sellerId: true } } } });
  if (!d) throw new NotFoundError("dispute");
  const party = d.order.buyerId === userId ? ("BUYER" as const) : d.order.sellerId === userId ? ("SELLER" as const) : null;
  if (!party) throw new NotFoundError("dispute");
  if (!OPEN_DISPUTE.includes(d.status as (typeof OPEN_DISPUTE)[number])) throw new UserError("This dispute is already resolved.");
  if (party === "SELLER" && sellerResponseDeadline(d.createdAt) <= now) throw new UserError("The time to add evidence has ended.");
  return { dispute: d, party };
}

export async function requestEvidenceUpload(db: Db, deps: DisputeDeps, actor: Actor, input: { disputeId: string; size: number; type: string }, now = new Date()) {
  const { party } = await evidenceParty(db, actor.userId, input.disputeId, now);
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.type)) throw new FieldError({ file: "Use a JPEG, PNG or WebP photo." });
  if (input.size <= 0 || input.size > MAX_PHOTO_BYTES) throw new FieldError({ file: "Photos must be under 10 MB." });
  const count = await db.disputeEvidence.count({ where: { disputeId: input.disputeId, party } });
  if (count >= MAX_EVIDENCE_PHOTOS) throw new UserError(`You can add up to ${MAX_EVIDENCE_PHOTOS} photos.`);
  const incomingKey = `incoming/disputes/${input.disputeId}/${randomUUID()}`;
  const e = await db.disputeEvidence.create({ data: { disputeId: input.disputeId, party, uploadedById: actor.userId, incomingKey } });
  const upload = await deps.storage.createSignedUploadUrl(deps.bucket, incomingKey, 300);
  return { evidenceId: e.id, uploadUrl: upload.url };
}

export async function confirmEvidenceUpload(db: Db, deps: DisputeDeps, actor: Actor, evidenceId: string, now = new Date()): Promise<"ready" | "failed"> {
  const e = await db.disputeEvidence.findUnique({ where: { id: evidenceId } });
  if (!e || e.uploadedById !== actor.userId) throw new NotFoundError("photo");
  if (e.storageKey) return "ready";
  await evidenceParty(db, actor.userId, e.disputeId, now);
  if (!e.incomingKey) return "failed";
  const cleaned = await cleanPhoto(await deps.storage.get(deps.bucket, e.incomingKey));
  await deps.storage.delete(deps.bucket, e.incomingKey).catch(() => {});
  if ("problem" in cleaned) {
    logger.warn({ evidenceId, reason: cleaned.problem }, "dispute evidence rejected");
    await db.disputeEvidence.delete({ where: { id: evidenceId } });
    return "failed";
  }
  const storageKey = `disputes/${e.disputeId}/${e.id}.jpg`;
  await deps.storage.put(deps.bucket, storageKey, new Uint8Array(cleaned.clean), "image/jpeg");
  await db.$transaction(async (tx) => {
    await tx.disputeEvidence.update({ where: { id: evidenceId }, data: { storageKey, incomingKey: null } });
    await recordAudit(tx, { actor: { type: "USER", id: actor.userId }, action: "dispute.evidence_added", entity: { type: "Dispute", id: e.disputeId }, after: { evidenceId, party: e.party } });
  });
  return "ready";
}

// ── dispute views ──

const disputeInclude = {
  evidence: { where: { storageKey: { not: null } }, orderBy: { createdAt: "asc" as const } },
  returnShipment: { select: { status: true, awb: true } },
  order: { select: { id: true, buyerId: true, sellerId: true, state: true, fulfilmentMode: true, autoReleaseAt: true, listing: { select: { title: true, partName: true } }, payment: { select: { refunds: { select: { amountPaise: true, status: true } } } } } },
} as const;

type SignedEvidence = { id: string; party: string; note: string | null; createdAt: Date; url: string };
async function withSignedEvidence<T extends { evidence: Array<{ id: string; party: string; storageKey: string | null; note: string | null; createdAt: Date }> }>(deps: DisputeDeps, d: T): Promise<Omit<T, "evidence"> & { evidence: SignedEvidence[] }> {
  const evidence = await Promise.all(d.evidence.map(async (e) => ({ id: e.id, party: e.party, note: e.note, createdAt: e.createdAt, url: await deps.storage.createSignedDownloadUrl(deps.bucket, e.storageKey!, VIEW_TTL_SECONDS) })));
  const { evidence: _raw, ...rest } = d;
  void _raw;
  return { ...rest, evidence };
}

/** Buyer or seller of the order only. */
export async function disputeForUser(db: Db, deps: DisputeDeps, userId: string, orderId: string, now = new Date()) {
  const d = await db.dispute.findUnique({ where: { orderId }, include: disputeInclude });
  if (!d || (d.order.buyerId !== userId && d.order.sellerId !== userId)) throw new NotFoundError("dispute");
  const deadline = sellerResponseDeadline(d.createdAt);
  const open = OPEN_DISPUTE.includes(d.status as (typeof OPEN_DISPUTE)[number]);
  return {
    ...(await withSignedEvidence(deps, d)),
    role: d.order.buyerId === userId ? ("buyer" as const) : ("seller" as const),
    title: d.order.listing.title ?? d.order.listing.partName ?? "Part",
    sellerDeadline: deadline,
    sellerCanRespond: open && !d.sellerRespondedAt && deadline > now,
    canAddEvidence: open && (d.order.buyerId === userId || deadline > now),
    open,
  };
}

export async function adminDisputes(db: Db, now = new Date()) {
  const { settings } = await getActiveSettings(db);
  const rows = await db.dispute.findMany({ include: { order: { select: { id: true, autoReleaseAt: true, listing: { select: { title: true, partName: true } } } } } });
  const warnMs = settings.orders.disputeDeadlineWarningDays * 24 * HOUR_MS;
  return rows
    .map((d) => {
      const left = d.order.autoReleaseAt ? d.order.autoReleaseAt.getTime() - now.getTime() : null;
      const open = OPEN_DISPUTE.includes(d.status as (typeof OPEN_DISPUTE)[number]);
      return { id: d.id, orderId: d.orderId, status: d.status, reason: d.reason, createdAt: d.createdAt, autoReleaseAt: d.order.autoReleaseAt, title: d.order.listing.title ?? d.order.listing.partName ?? "Part", open, nearDeadline: open && left !== null && left <= warnMs, critical: open && left !== null && left <= 24 * HOUR_MS };
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || (a.autoReleaseAt?.getTime() ?? Infinity) - (b.autoReleaseAt?.getTime() ?? Infinity));
}

export async function adminDispute(db: Db, deps: DisputeDeps, disputeId: string) {
  const d = await db.dispute.findUnique({
    where: { id: disputeId },
    include: {
      ...disputeInclude,
      order: {
        select: {
          ...disputeInclude.order.select,
          itemPricePaise: true,
          shippingFeePaise: true,
          checkFeePaise: true,
          totalPaise: true,
          buyer: { select: { name: true } },
          seller: { select: { name: true } },
          events: { orderBy: { createdAt: "asc" }, select: { toState: true, event: true, actorType: true, createdAt: true } },
          payment: { select: { status: true, vendorSettlementStatus: true, refunds: { select: { amountPaise: true, status: true } } } },
        },
      },
    },
  });
  if (!d) throw new NotFoundError("dispute");
  const audit = await db.auditLog.findMany({ where: { OR: [{ entityType: "Dispute", entityId: d.id }, { entityType: "Order", entityId: d.orderId }] }, orderBy: { createdAt: "asc" }, select: { action: true, actorType: true, createdAt: true }, take: 200 });
  return { ...(await withSignedEvidence(deps, d)), audit, sellerDeadline: sellerResponseDeadline(d.createdAt), open: OPEN_DISPUTE.includes(d.status as (typeof OPEN_DISPUTE)[number]) };
}

// ── return shipment after a refund decision ──

/**
 * Books the part's return to the seller with the existing courier adapter (RePart pays, A-7). Delivery orders only
 * (local pickup returns are arranged in person) and never for NOT_RECEIVED. Idempotent: an existing return is kept.
 */
export async function bookDisputeReturn(db: Db, deps: Pick<DisputeDeps, "shipping">, orderId: string, now = new Date()): Promise<"booked" | "exists" | "not_applicable"> {
  const d = await db.dispute.findUnique({ where: { orderId }, include: { order: { select: { state: true, fulfilmentMode: true, deliveryAddress: true, pickupAddress: true, listing: { select: { pickupPincode: true } } } } } });
  if (!d || d.order.state !== "RESOLVED_REFUND") return "not_applicable";
  if (d.returnShipmentId) return "exists";
  if (d.reason === "NOT_RECEIVED" || d.order.fulfilmentMode !== "DELIVERY") return "not_applicable";
  const forward = await db.shipment.findFirst({ where: { orderId, direction: "FORWARD" }, orderBy: { createdAt: "desc" } });
  if (!forward) return "not_applicable";
  const pin = (a: unknown) => (a && typeof a === "object" && "pincode" in a ? String((a as { pincode: unknown }).pincode) : "");
  const from = pin(d.order.deliveryAddress);
  const to = d.order.listing.pickupPincode ?? pin(d.order.pickupAddress);
  const parcel = { weightGrams: forward.weightGrams, lengthCm: forward.lengthCm, widthCm: forward.widthCm, heightCm: forward.heightCm };
  const slot = pickupSlots(now)[0]!;
  const quote = await deps.shipping.quote(from, to, parcel);
  const booking = await deps.shipping.bookReturn({ orderId, from, to, parcel, pickupSlot: slot.start });
  await db.$transaction(async (tx) => {
    const s = await tx.shipment.create({
      data: { orderId, direction: "RETURN", provider: deps.shipping.name, providerRef: booking.shipmentId, awb: booking.awb, status: "PICKUP_SCHEDULED", fromAddress: d.order.deliveryAddress ?? {}, toAddress: d.order.pickupAddress ?? {}, ...parcel, quotedFeePaise: quote.amount, pickupSlotStart: slot.start, pickupSlotEnd: slot.end },
    });
    await tx.dispute.update({ where: { id: d.id }, data: { returnShipmentId: s.id } });
    await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "dispute.return_booked", entity: { type: "Dispute", id: d.id }, after: { shipmentId: s.id, awb: booking.awb, costPaise: quote.amount, paidBy: "RePart" } });
  });
  return "booked";
}

// ── reviews (both directions, only after COMPLETED) ──

export const reviewInput = z.object({
  rating: z.coerce.number({ message: "Choose a rating." }).int("Choose a rating from 1 to 5.").min(1, "Choose a rating from 1 to 5.").max(5, "Choose a rating from 1 to 5."),
  text: z.string().trim().max(1000, "Keep it under 1000 characters.").optional().transform((v) => v || null),
});

export async function reviewState(db: Db, userId: string, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, sellerId: true, state: true, listing: { select: { title: true, partName: true } }, reviews: { select: { direction: true, rating: true, text: true } } } });
  if (!o || (o.buyerId !== userId && o.sellerId !== userId)) throw new NotFoundError("order");
  const direction = o.buyerId === userId ? ("BUYER_TO_SELLER" as const) : ("SELLER_TO_BUYER" as const);
  const mine = o.reviews.find((r) => r.direction === direction) ?? null;
  return { direction, mine, canReview: o.state === "COMPLETED" && !mine, completed: o.state === "COMPLETED", title: o.listing.title ?? o.listing.partName ?? "Part" };
}

export async function submitReview(db: Db, actor: Actor, orderId: string, raw: unknown) {
  const input = parse(reviewInput, raw);
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, sellerId: true, state: true } });
  if (!o || (o.buyerId !== actor.userId && o.sellerId !== actor.userId)) throw new NotFoundError("order");
  if (o.state !== "COMPLETED") throw new UserError("Reviews open once the order is completed.");
  const buyer = o.buyerId === actor.userId;
  try {
    await db.$transaction(async (tx) => {
      const r = await tx.review.create({ data: { orderId, authorId: actor.userId, subjectId: buyer ? o.sellerId : o.buyerId, direction: buyer ? "BUYER_TO_SELLER" : "SELLER_TO_BUYER", rating: input.rating, text: input.text } });
      await recordAudit(tx, { actor: { type: "USER", id: actor.userId }, action: "review.created", entity: { type: "Review", id: r.id }, after: { orderId, rating: input.rating } });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new UserError("You've already reviewed this order.");
    throw err;
  }
}

// ── provider hold-deadline watch (PLAN.md §5.3) ──

/** Escalation thresholds before `autoReleaseAt`. Each is sent at most once per order (the audit log is the record). */
export const HOLD_THRESHOLDS = [
  { key: "7d", ms: 7 * 24 * HOUR_MS, label: "7 days" },
  { key: "3d", ms: 3 * 24 * HOUR_MS, label: "3 days" },
  { key: "1d", ms: 24 * HOUR_MS, label: "1 day" },
  { key: "12h", ms: 12 * HOUR_MS, label: "12 hours" },
] as const;
/** Alert channels. In-app only for now; email/SMS slot in here when those providers are wired up. */
export const ALERT_CHANNELS = ["IN_APP"] as const;

/**
 * Hourly: for every paid, not-yet-final order (disputes included, A-10) whose provider hold ends within 7 days,
 * alert every admin at the most urgent threshold crossed, once. Alerts can't be dismissed (only resolving or
 * completing the order stops them). Breaches are handled by the existing sweep (deadlineBreachedAt).
 */
export async function holdDeadlineWatch(db: Db, now = new Date()) {
  const horizon = new Date(now.getTime() + HOLD_THRESHOLDS[0].ms);
  const orders = await db.order.findMany({ where: { state: { in: PAID_OPEN_STATES }, autoReleaseAt: { gt: now, lte: horizon } }, select: { id: true, state: true, autoReleaseAt: true, dispute: { select: { id: true } } } });
  let sent = 0;
  for (const o of orders) {
    const left = o.autoReleaseAt!.getTime() - now.getTime();
    const t = [...HOLD_THRESHOLDS].reverse().find((x) => left <= x.ms)!;
    await db.$transaction(async (tx) => {
      const already = await tx.auditLog.count({ where: { entityType: "Order", entityId: o.id, action: "order.hold_deadline_alert", after: { path: ["threshold"], equals: t.key } } });
      if (already) return;
      const link = o.dispute ? `/admin/disputes/${o.dispute.id}` : `/admin/orders/${o.id}`;
      const what = o.state === "DISPUTED" ? "A dispute" : "An open order";
      for (const channel of ALERT_CHANNELS) {
        for (const userId of await adminIds(tx)) {
          await enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId, channel, type: "order.hold_deadline_alert", title: `Payout hold ends in ${t.label}`, body: `${what} reaches the payment provider's automatic release in under ${t.label}. Resolve it before then.`, link } });
        }
      }
      await recordAudit(tx, { actor: { type: "SYSTEM", id: null }, action: "order.hold_deadline_alert", entity: { type: "Order", id: o.id }, after: { threshold: t.key, autoReleaseAt: o.autoReleaseAt!.toISOString(), state: o.state } });
      sent++;
    });
  }
  return { checked: orders.length, sent };
}

/** For the admin banner and overview: open disputes and paid open orders near the hold deadline. */
export async function nearAutoRelease(db: Db, now = new Date()) {
  const { settings } = await getActiveSettings(db);
  const horizon = new Date(now.getTime() + settings.orders.disputeDeadlineWarningDays * 24 * HOUR_MS);
  const orders = await db.order.findMany({
    where: { state: { in: PAID_OPEN_STATES }, autoReleaseAt: { lte: horizon } },
    select: { id: true, state: true, autoReleaseAt: true, deadlineBreachedAt: true, listing: { select: { title: true, partName: true } }, dispute: { select: { id: true, status: true } } },
    orderBy: { autoReleaseAt: "asc" },
  });
  const rows = orders.map((o) => ({ ...o, title: o.listing.title ?? o.listing.partName ?? "Part", hoursLeft: Math.max(0, Math.floor((o.autoReleaseAt!.getTime() - now.getTime()) / HOUR_MS)) }));
  return { disputes: rows.filter((r) => r.state === "DISPUTED"), others: rows.filter((r) => r.state !== "DISPUTED"), criticalDisputes: rows.filter((r) => r.state === "DISPUTED" && r.autoReleaseAt!.getTime() - now.getTime() <= 24 * HOUR_MS).length };
}
