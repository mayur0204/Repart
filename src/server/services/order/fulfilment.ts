import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ShippingProvider } from "../../adapters/shipping/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { logger } from "../../logger";
import { recordAudit } from "../audit/audit";
import { enqueueOutbox } from "../outbox/outbox";
import { refundableComponents, requestRefund, type RefundComponents } from "../payment/refunds";
import { SIZE_CM, WEIGHT_GRAMS } from "../search/public";
import { getSettingsVersion } from "../settings/settings";
import { transitionOrder } from "./state";

/**
 * Seller order handling and fulfilment (M9; PLAN.md §5.2 O5–O7, O9, O12, O13, O17, O23, O25).
 * All state changes go through transitionOrder; all refunds through the M8 refund service.
 */
type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = { userId: string; requestId?: string };
const HOUR_MS = 3_600_000;

// ── pickup slots ──
// PLAN.md doesn't define a slot catalogue. M9 uses a fixed mock one: the next 3 business days (Mon–Fri, IST),
// four 2-hour windows between 10:00 and 18:00. ponytail: fixed catalogue; replace with the courier's slots when a real courier arrives.
const IST_MS = 5.5 * HOUR_MS;
const SLOT_HOURS = [10, 12, 14, 16];
const SLOT_DAYS = 3;
export type PickupSlot = { id: string; start: Date; end: Date };

export function pickupSlots(now: Date): PickupSlot[] {
  const ist = new Date(now.getTime() + IST_MS);
  const out: PickupSlot[] = [];
  for (let k = 1, days = 0; days < SLOT_DAYS; k++) {
    const dayUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + k); // IST midnight, as a UTC clock value
    const dow = new Date(dayUtc).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    days++;
    for (const h of SLOT_HOURS) {
      const start = new Date(dayUtc + h * HOUR_MS - IST_MS);
      out.push({ id: start.toISOString(), start, end: new Date(start.getTime() + 2 * HOUR_MS) });
    }
  }
  return out;
}

/** The chosen slot must be one the server offers right now (never a browser-made or stale time). */
export function resolveSlot(id: unknown, now: Date): PickupSlot {
  const slot = typeof id === "string" ? pickupSlots(now).find((s) => s.id === id) : undefined;
  if (!slot) throw new FieldError({ slot: "Choose one of the pickup slots shown." });
  return slot;
}

// ── helpers ──

const orderSelect = {
  id: true,
  state: true,
  buyerId: true,
  sellerId: true,
  listingId: true,
  fulfilmentMode: true,
  inspectionReason: true,
  settingsVersion: true,
  shippingFeePaise: true,
  pickupAddress: true,
  deliveryAddress: true,
  listing: { select: { weightBand: true, dimensionBand: true, pickupPincode: true, category: { select: { shippingRestriction: true } } } },
} as const;

async function sellersOrder(db: Pick<Db, "order">, sellerId: string, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: orderSelect });
  if (!o || o.sellerId !== sellerId) throw new NotFoundError("order");
  return o;
}
type LoadedOrder = Awaited<ReturnType<typeof sellersOrder>>;

const pincodeOf = (addr: unknown) => (addr && typeof addr === "object" && "pincode" in addr ? String((addr as { pincode: unknown }).pincode ?? "") : "");

function parcelOf(o: LoadedOrder) {
  const { weightBand, dimensionBand } = o.listing;
  if (!weightBand || !dimensionBand) throw new UserError("This listing is missing its parcel size, so a pickup can't be booked. Contact support.");
  const [lengthCm, widthCm, heightCm] = SIZE_CM[dimensionBand];
  return { weightGrams: WEIGHT_GRAMS[weightBand], lengthCm, widthCm, heightCm };
}

const forwardShipment = (db: Pick<Tx, "shipment">, orderId: string) => db.shipment.findFirst({ where: { orderId, direction: "FORWARD" }, orderBy: { createdAt: "desc" } });

/** Keeps the seller's preferred slot on a not-yet-booked FORWARD shipment (Partner Check orders book after the check). */
async function saveSlot(tx: Tx, o: LoadedOrder, slot: PickupSlot) {
  const existing = await forwardShipment(tx, o.id);
  const parcel = parcelOf(o);
  const data = { pickupSlotStart: slot.start, pickupSlotEnd: slot.end };
  if (existing) await tx.shipment.update({ where: { id: existing.id }, data });
  else {
    await tx.shipment.create({
      data: { orderId: o.id, direction: "FORWARD", provider: "pending", status: "QUOTED", fromAddress: o.pickupAddress ?? {}, toAddress: o.deliveryAddress ?? {}, ...parcel, quotedFeePaise: o.shippingFeePaise, ...data },
    });
  }
}

/**
 * Books the forward pickup with the courier, then records it and moves the order (O6 or O12) in one
 * transaction. The courier call happens outside the transaction; if recording fails, the booking is cancelled.
 * The buyer's paid delivery fee never changes: any difference to the courier's quote is RePart's cost [A-7].
 */
async function bookForward(db: Db, shipping: ShippingProvider, o: LoadedOrder, slot: PickupSlot, event: "sellerConfirmedDelivery" | "pickupBooked", actor: { type: "USER" | "SYSTEM"; id: string | null }, requestId?: string) {
  const from = o.listing.pickupPincode ?? pincodeOf(o.pickupAddress);
  const to = pincodeOf(o.deliveryAddress);
  const parcel = parcelOf(o);
  const ok = await shipping.checkServiceability(from, to);
  if (!ok.serviceable) throw new UserError("Our courier partner can't collect from this pincode right now. Contact support.");
  const quote = await shipping.quote(from, to, parcel);
  const booking = await shipping.bookPickup({ orderId: o.id, from, to, parcel, pickupSlot: slot.start });
  try {
    await db.$transaction(async (tx) => {
      const existing = await forwardShipment(tx, o.id);
      if (existing?.providerRef) throw new UserError("A pickup is already booked for this order.");
      const data = {
        provider: shipping.name,
        providerRef: booking.shipmentId,
        awb: booking.awb,
        status: "PICKUP_SCHEDULED" as const,
        quotedFeePaise: quote.amount,
        pickupSlotStart: slot.start,
        pickupSlotEnd: slot.end,
        etaDate: new Date(slot.start.getTime() + quote.etaDays * 24 * HOUR_MS),
        ...parcel,
      };
      const shipment = existing
        ? await tx.shipment.update({ where: { id: existing.id }, data })
        : await tx.shipment.create({ data: { orderId: o.id, direction: "FORWARD", fromAddress: o.pickupAddress ?? {}, toAddress: o.deliveryAddress ?? {}, ...data } });
      await transitionOrder(tx, { orderId: o.id, event, actor, requestId, payload: { shipmentId: shipment.id, pickupSlot: slot.id } });
      await recordAudit(tx, {
        actor,
        action: "shipment.booked",
        entity: { type: "Shipment", id: shipment.id },
        after: { orderId: o.id, awb: booking.awb, pickupSlot: slot.id, courierQuotePaise: quote.amount, buyerPaidPaise: o.shippingFeePaise, absorbedByRePartPaise: Math.max(0, quote.amount - o.shippingFeePaise) },
        requestId,
      });
    });
  } catch (err) {
    await shipping.cancel(booking.shipmentId).catch((e) => logger.error({ orderId: o.id, err: (e as Error).message }, "courier booking cancel failed after a failed record"));
    throw err;
  }
}

// ── seller actions ──

export const confirmInput = z.object({ slot: z.string().max(40).optional() });

/**
 * O5 / O6 / O7: the seller confirms the part is available. Delivery orders need a pickup slot and are booked
 * with the courier (O6); Partner Check orders move to INSPECTION_SCHEDULED (O5; garage assignment is M10) and
 * keep the preferred slot for later; local-pickup orders move to AWAITING_HANDOVER (O7) and the buyer–seller
 * conversation (M7, masked) is opened for meeting details. Repeating a confirmation is a no-op.
 */
export async function confirmOrder(db: Db, deps: { shipping: ShippingProvider }, actor: Actor, orderId: string, raw: unknown, now = new Date()) {
  const input = confirmInput.parse(raw ?? {});
  const o = await sellersOrder(db, actor.userId, orderId);
  if (o.state !== "AWAITING_SELLER") {
    if (["INSPECTION_SCHEDULED", "PICKUP_SCHEDULED", "AWAITING_HANDOVER"].includes(o.state)) return { state: o.state, already: true };
    throw new UserError("This order is no longer waiting for your confirmation.");
  }
  const user = { type: "USER" as const, id: actor.userId };
  if (o.inspectionReason) {
    const slot = o.fulfilmentMode === "DELIVERY" && input.slot ? resolveSlot(input.slot, now) : null;
    await db.$transaction(async (tx) => {
      if (slot) await saveSlot(tx, o, slot);
      await transitionOrder(tx, { orderId, event: "sellerConfirmedInspection", actor: user, requestId: actor.requestId, payload: { preferredPickupSlot: slot?.id ?? null } });
    });
    return { state: "INSPECTION_SCHEDULED", already: false };
  }
  if (o.fulfilmentMode === "LOCAL_PICKUP") {
    await db.$transaction(async (tx) => {
      await transitionOrder(tx, { orderId, event: "sellerConfirmedPickup", actor: user, requestId: actor.requestId });
      await tx.conversation.upsert({ where: { listingId_buyerId: { listingId: o.listingId, buyerId: o.buyerId } }, create: { listingId: o.listingId, buyerId: o.buyerId, sellerId: o.sellerId }, update: {} });
    });
    return { state: "AWAITING_HANDOVER", already: false };
  }
  if (!input.slot) throw new FieldError({ slot: "Choose a pickup slot." });
  await bookForward(db, deps.shipping, o, resolveSlot(input.slot, now), "sellerConfirmedDelivery", user, actor.requestId);
  return { state: "PICKUP_SCHEDULED", already: false };
}

export const declineInput = z.object({ reason: z.string().trim().max(300).optional() });

/** O9: the seller declines. Full refund through the M8 refund service; the listing is withdrawn (PLAN.md §5.2 O9). */
export async function declineOrder(db: Db, actor: Actor, orderId: string, raw: unknown) {
  const input = declineInput.parse(raw ?? {});
  const o = await sellersOrder(db, actor.userId, orderId);
  if (o.state === "CANCELLED") return { already: true };
  if (o.state !== "AWAITING_SELLER") throw new UserError("This order can't be declined now.");
  const user = { type: "USER" as const, id: actor.userId };
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: "sellerDeclined", actor: user, requestId: actor.requestId, reason: input.reason ? `Seller declined: ${input.reason}` : "The seller declined the order." });
    await requestRefund(tx, { orderId, components: await refundableComponents(tx, orderId), reason: "Seller declined the order (full refund).", actor: user, idempotencyKey: `refund:${orderId}:seller_declined`, requestId: actor.requestId });
  });
  return { already: false };
}

/** O12 by the seller: book the pickup for a Partner Check order that passed (a fresh slot is always required). */
export async function schedulePickup(db: Db, deps: { shipping: ShippingProvider }, actor: Actor, orderId: string, raw: unknown, now = new Date()) {
  const input = confirmInput.parse(raw ?? {});
  const o = await sellersOrder(db, actor.userId, orderId);
  if (o.state !== "INSPECTION_PASSED" || o.fulfilmentMode !== "DELIVERY") throw new UserError("A pickup can't be booked for this order now.");
  await bookForward(db, deps.shipping, o, resolveSlot(input.slot, now), "pickupBooked", { type: "USER", id: actor.userId }, actor.requestId);
}

/**
 * Hook for M10 when a Partner Check passes (O12 / O13). Books the seller's stored slot only if it is still one
 * of the offered future slots; otherwise asks the seller to choose a new one (never books a stale slot).
 */
export async function afterInspectionPassed(db: Db, deps: { shipping: ShippingProvider }, orderId: string, now = new Date()): Promise<"handover" | "booked" | "needs_slot" | "not_due"> {
  const o = await db.order.findUnique({ where: { id: orderId }, select: orderSelect });
  if (!o || o.state !== "INSPECTION_PASSED") return "not_due";
  const system = { type: "SYSTEM" as const, id: null };
  if (o.fulfilmentMode === "LOCAL_PICKUP") {
    await db.$transaction(async (tx) => {
      await transitionOrder(tx, { orderId, event: "handoverArranged", actor: system });
      await tx.conversation.upsert({ where: { listingId_buyerId: { listingId: o.listingId, buyerId: o.buyerId } }, create: { listingId: o.listingId, buyerId: o.buyerId, sellerId: o.sellerId }, update: {} });
    });
    return "handover";
  }
  const stored = await forwardShipment(db, orderId);
  const slot = stored?.pickupSlotStart ? pickupSlots(now).find((s) => s.start.getTime() === stored.pickupSlotStart!.getTime()) : undefined;
  if (slot) {
    await bookForward(db, deps.shipping, o, slot, "pickupBooked", system);
    return "booked";
  }
  await db.$transaction((tx) =>
    enqueueOutbox(tx, { queue: "notifications", name: "send", payload: { userId: o.sellerId, channel: "IN_APP", type: "order.pickup_slot_needed", title: "Choose a pickup slot", body: "The Partner Check passed. Choose a new pickup slot so the courier can collect the part.", link: `/seller/orders/${orderId}` } }),
  );
  return "needs_slot";
}

// ── buyer actions ──

/** Happy-path order of states, for the admin cancellation table ("refund this much before <state>"). AWAITING_HANDOVER is the local-pickup twin of PICKUP_SCHEDULED [A-1]. */
const STATE_RANK: Record<string, number> = { PAID_HELD: 1, AWAITING_SELLER: 2, INSPECTION_SCHEDULED: 3, INSPECTION_PASSED: 4, PICKUP_SCHEDULED: 5, AWAITING_HANDOVER: 5, IN_TRANSIT: 6, DELIVERED: 7, ACCEPTANCE_WINDOW: 8 };
const BUYER_CANCELLABLE = ["PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "AWAITING_HANDOVER"];

type CancellationRule = { beforeState: string; refundItem: boolean; refundShipping: boolean; refundCheck: boolean };

/** The first configured rule whose `beforeState` is still ahead of the order applies (settings.orders.buyerCancellationRules, A-5). */
export function cancellationRuleFor(state: string, rules: CancellationRule[]): CancellationRule | null {
  if (!BUYER_CANCELLABLE.includes(state)) return null;
  const rank = STATE_RANK[state]!;
  return [...rules].sort((a, b) => (STATE_RANK[a.beforeState] ?? 99) - (STATE_RANK[b.beforeState] ?? 99)).find((r) => rank < (STATE_RANK[r.beforeState] ?? 0)) ?? null;
}

async function buyerCancellation(db: Pick<Db, "order" | "refund" | "settingsVersion">, buyerId: string, orderId: string) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, state: true, settingsVersion: true } });
  if (!o || o.buyerId !== buyerId) throw new NotFoundError("order");
  const { settings } = await getSettingsVersion(db, o.settingsVersion);
  const rule = cancellationRuleFor(o.state, settings.orders.buyerCancellationRules);
  if (!rule) return { state: o.state, rule: null, components: null };
  const left = await refundableComponents(db, orderId);
  const components: RefundComponents = { item: rule.refundItem ? left.item : 0, shipping: rule.refundShipping ? left.shipping : 0, check: rule.refundCheck ? left.check : 0 };
  return { state: o.state, rule, components };
}

/** What the buyer would get back if they cancelled now (shown on the order page; same calculation as the action). */
export async function buyerCancellationPreview(db: Db, buyerId: string, orderId: string) {
  const { rule, components } = await buyerCancellation(db, buyerId, orderId);
  return rule && components ? components : null;
}

export const buyerCancelInput = z.object({ reason: z.string().trim().max(300).optional() });

/** O23: the buyer cancels before pickup. Refund per the admin-configured rules; a booked pickup is cancelled with the courier. */
export async function buyerCancelOrder(db: Db, deps: { shipping: ShippingProvider }, actor: Actor, orderId: string, raw: unknown) {
  const input = buyerCancelInput.parse(raw ?? {});
  const c = await buyerCancellation(db, actor.userId, orderId);
  if (c.state === "CANCELLED") return { already: true };
  if (!c.rule || !c.components) throw new UserError("This order can't be cancelled now. If there's a problem with the part, report it after it arrives.");
  const shipment = await forwardShipment(db, orderId);
  if (shipment?.providerRef && shipment.status === "PICKUP_SCHEDULED") {
    try {
      await deps.shipping.cancel(shipment.providerRef);
    } catch {
      throw new UserError("We couldn't cancel the courier pickup just now. Try again in a few minutes.");
    }
  }
  const user = { type: "USER" as const, id: actor.userId };
  const components = c.components;
  await db.$transaction(async (tx) => {
    await transitionOrder(tx, { orderId, event: "buyerCancelled", actor: user, requestId: actor.requestId, reason: input.reason ? `Buyer cancelled: ${input.reason}` : "The buyer cancelled the order." });
    if (shipment && shipment.status !== "CANCELLED") await tx.shipment.update({ where: { id: shipment.id }, data: { status: "CANCELLED" } });
    if (components.item + components.shipping + components.check > 0) {
      await requestRefund(tx, { orderId, components, reason: "Buyer cancelled before pickup (refund per cancellation rules).", actor: user, idempotencyKey: `refund:${orderId}:buyer_cancel`, requestId: actor.requestId });
    }
  });
  return { already: false };
}

/** O17: the buyer confirms the local-pickup handover; the acceptance window (settings, default 48h) starts now. M11 owns what follows. */
export async function confirmHandover(db: Db, actor: Actor, orderId: string, now = new Date()) {
  const o = await db.order.findUnique({ where: { id: orderId }, select: { buyerId: true, state: true, settingsVersion: true } });
  if (!o || o.buyerId !== actor.userId) throw new NotFoundError("order");
  if (o.state === "ACCEPTANCE_WINDOW") return { already: true };
  if (o.state !== "AWAITING_HANDOVER") throw new UserError("There's no handover to confirm on this order.");
  const { settings } = await getSettingsVersion(db, o.settingsVersion);
  await db.$transaction((tx) =>
    transitionOrder(tx, { orderId, event: "buyerConfirmedHandover", actor: { type: "USER", id: actor.userId }, requestId: actor.requestId, data: { acceptanceEndsAt: new Date(now.getTime() + settings.orders.acceptanceWindowHours * HOUR_MS) } }),
  );
  return { already: false };
}

// ── admin: failed delivery ──

export const confirmReturnInput = z.object({
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(500),
  returned: z.literal("yes", { message: "Confirm the part is back with the seller." }),
});

/**
 * O25 after admin review: the courier reported a failed or returned delivery, and the admin confirms the part is
 * back with the seller. Full refund through the M8 refund service; the listing goes LIVE again (it is only
 * released here, once the return is confirmed). Repeating it is a no-op.
 */
export async function adminConfirmReturn(db: Db, admin: Actor, orderId: string, raw: unknown) {
  const parsed = confirmReturnInput.safeParse(raw);
  if (!parsed.success) throw new FieldError(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  const o = await db.order.findUnique({ where: { id: orderId }, select: { state: true } });
  if (!o) throw new NotFoundError("order");
  if (o.state === "CANCELLED") return { already: true };
  const shipment = await forwardShipment(db, orderId);
  if (o.state !== "IN_TRANSIT" || !shipment || !["FAILED", "RETURNED_TO_ORIGIN"].includes(shipment.status)) {
    throw new UserError("Only an in-transit order whose courier reported a failed or returned delivery can be closed this way.");
  }
  const actor = { type: "ADMIN" as const, id: admin.userId };
  await db.$transaction(async (tx) => {
    await tx.shipment.update({ where: { id: shipment.id }, data: { status: "RETURNED_TO_ORIGIN" } });
    await recordAudit(tx, { actor, action: "shipment.return_confirmed", entity: { type: "Shipment", id: shipment.id }, before: { status: shipment.status }, after: { status: "RETURNED_TO_ORIGIN", reason: parsed.data.reason }, requestId: admin.requestId });
    await transitionOrder(tx, { orderId, event: "deliveryFailed", actor, requestId: admin.requestId, reason: parsed.data.reason });
    await requestRefund(tx, { orderId, components: await refundableComponents(tx, orderId), reason: `Delivery failed, part returned to seller: ${parsed.data.reason}`, actor, idempotencyKey: `refund:${orderId}:delivery_failed`, requestId: admin.requestId });
  });
  return { already: false };
}

