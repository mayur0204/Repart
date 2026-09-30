import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type InspectionReason, type PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "../../adapters/payment/types";
import type { ShippingProvider } from "../../adapters/shipping/types";
import { FieldError, NotFoundError, UserError } from "../../http/errors";
import { recordAudit } from "../audit/audit";
import { transitionListing } from "../listing/state";
import { enqueueOutbox } from "../outbox/outbox";
import { startProviderPayment, type CheckoutSession } from "../payment/provider-payment";
import { SIZE_CM, WEIGHT_GRAMS } from "../search/public";
import { getActiveSettings } from "../settings/settings";
import { quote, type Quote } from "./pricing";

/**
 * Checkout (PLAN.md §4.5, §7.2 step 3, O1). Every amount is computed here from the listing, the courier
 * quote and the active settings; the browser only chooses a listing, an address and the optional check.
 */
type Db = PrismaClient;
export type CheckoutDeps = { shipping: ShippingProvider; payment: PaymentProvider };
type Actor = { userId: string; requestId?: string };

export const checkoutInput = z.object({
  listingId: z.string().min(1).max(64),
  addressId: z.string().max(64).optional().transform((v) => v || undefined),
  withCheck: z.union([z.boolean(), z.enum(["on", "true", "false", ""])]).optional().transform((v) => v === true || v === "on" || v === "true"),
});

export type PricedListing = {
  quote: Quote;
  settingsVersion: number;
  paymentTtlMinutes: number;
  inspectionReason: InspectionReason | null;
  deliveryAddress: Prisma.InputJsonObject | null;
  pickupAddress: Prisma.InputJsonObject;
  etaDays: number | null;
  listing: { id: string; sellerId: string; title: string; fulfilmentMode: "DELIVERY" | "LOCAL_PICKUP"; inspectionRequirement: string | null; checkFeePaise: number };
};

const addressSnapshot = (a: { contactName: string; contactPhone: string; line1: string; line2: string | null; landmark: string | null; city: string; state: string; pincode: string }) => ({
  contactName: a.contactName,
  contactPhone: a.contactPhone,
  line1: a.line1,
  line2: a.line2,
  landmark: a.landmark,
  city: a.city,
  state: a.state,
  pincode: a.pincode,
});

/** Server-side price for this buyer, listing, address and check choice. Throws a user-facing error when it can't be bought. */
export async function priceListing(db: Db, deps: CheckoutDeps, buyerId: string, input: { listingId: string; addressId?: string; withCheck: boolean }): Promise<PricedListing> {
  const l = await db.listing.findUnique({
    where: { id: input.listingId },
    select: {
      id: true,
      sellerId: true,
      title: true,
      partName: true,
      status: true,
      pricePaise: true,
      fulfilmentMode: true,
      pickupPincode: true,
      pickupAddressId: true,
      weightBand: true,
      dimensionBand: true,
      inspectionRequirement: true,
      inspectionReason: true,
      category: { select: { optionalCheckFee: true } },
      seller: { select: { status: true, payoutAccount: { select: { status: true } } } },
    },
  });
  if (!l || !["LIVE", "RESERVED", "SOLD"].includes(l.status)) throw new NotFoundError("listing");
  if (l.status !== "LIVE") throw new UserError("This part is no longer available.");
  if (l.sellerId === buyerId) throw new UserError("You can't buy your own listing.");
  if (l.pricePaise === null || l.pricePaise <= 0) throw new UserError("This listing has no price yet.");
  if (l.seller.status !== "ACTIVE") throw new UserError("This seller can't sell right now.");
  // Plan A-6: no checkout until the seller's payout vendor is ACTIVE.
  if (l.seller.payoutAccount?.status !== "ACTIVE") throw new UserError("This seller can't receive payments yet. Save the part and try again later.");

  const pickupAddr = l.pickupAddressId ? await db.address.findFirst({ where: { id: l.pickupAddressId, userId: l.sellerId } }) : null;
  const pickupAddress: Prisma.InputJsonObject = pickupAddr ? addressSnapshot(pickupAddr) : { pincode: l.pickupPincode };

  let shippingFeePaise = 0;
  let etaDays: number | null = null;
  let deliveryAddress: Prisma.InputJsonObject | null = null;
  if (l.fulfilmentMode === "DELIVERY") {
    if (!input.addressId) throw new FieldError({ addressId: "Choose a delivery address." });
    const addr = await db.address.findFirst({ where: { id: input.addressId, userId: buyerId } });
    if (!addr) throw new FieldError({ addressId: "Choose one of your saved addresses." });
    if (!l.pickupPincode || !l.weightBand || !l.dimensionBand) throw new UserError("This listing is missing its parcel details, so delivery can't be priced.");
    const ok = await deps.shipping.checkServiceability(l.pickupPincode, addr.pincode);
    if (!ok.serviceable) throw new FieldError({ addressId: "Our courier partner doesn't deliver between these pincodes yet." });
    const [lengthCm, widthCm, heightCm] = SIZE_CM[l.dimensionBand];
    const q = await deps.shipping.quote(l.pickupPincode, addr.pincode, { weightGrams: WEIGHT_GRAMS[l.weightBand], lengthCm, widthCm, heightCm });
    shippingFeePaise = q.amount;
    etaDays = q.etaDays;
    deliveryAddress = addressSnapshot(addr);
  }

  const checkFeePaise = l.category?.optionalCheckFee ?? 0;
  const requirement = l.inspectionRequirement;
  const withCheck = requirement === "REQUIRED" || (requirement === "OPTIONAL" && input.withCheck);
  const inspectionReason: InspectionReason | null = requirement === "REQUIRED" ? (l.inspectionReason ?? "TIER_C") : withCheck ? "BUYER_OPTIONAL" : null;

  const { settings, version } = await getActiveSettings(db);
  return {
    quote: quote({ itemPricePaise: l.pricePaise, shippingFeePaise, checkFeePaise: withCheck ? checkFeePaise : 0, platformFeeBps: settings.fees.platformFeeBps }),
    settingsVersion: version,
    paymentTtlMinutes: settings.orders.paymentTtlMinutes,
    inspectionReason,
    deliveryAddress,
    pickupAddress,
    etaDays,
    listing: { id: l.id, sellerId: l.sellerId, title: l.title ?? l.partName ?? "Part", fulfilmentMode: l.fulfilmentMode, inspectionRequirement: requirement, checkFeePaise },
  };
}

/**
 * O1: create the order (or resume this buyer's open, unexpired one) and reserve the listing.
 * One open order per listing is a DB index, so two buyers can't both reserve it.
 */
export async function placeOrder(db: Db, deps: CheckoutDeps, actor: Actor, raw: unknown): Promise<{ orderId: string; resumed: boolean }> {
  const parsed = checkoutInput.safeParse(raw);
  if (!parsed.success) throw new FieldError(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "form"), i.message])));
  const input = parsed.data;

  const open = await db.order.findFirst({ where: { buyerId: actor.userId, listingId: input.listingId, state: "CREATED" }, select: { id: true, paymentExpiresAt: true } });
  if (open && (!open.paymentExpiresAt || open.paymentExpiresAt > new Date())) return { orderId: open.id, resumed: true };

  const priced = await priceListing(db, deps, actor.userId, input);
  const q = priced.quote;
  const now = new Date();
  const paymentExpiresAt = new Date(now.getTime() + priced.paymentTtlMinutes * 60_000);
  try {
    const orderId = await db.$transaction(async (tx) => {
      await transitionListing(tx, { listingId: input.listingId, event: "reserve", actor: { type: "USER", id: actor.userId }, requestId: actor.requestId });
      const order = await tx.order.create({
        data: {
          buyerId: actor.userId,
          sellerId: priced.listing.sellerId,
          listingId: input.listingId,
          fulfilmentMode: priced.listing.fulfilmentMode,
          itemPricePaise: q.itemPricePaise,
          shippingFeePaise: q.shippingFeePaise,
          checkFeePaise: q.checkFeePaise,
          platformFeePaise: q.platformFeePaise,
          platformFeeBps: q.platformFeeBps,
          vendorSharePaise: q.vendorSharePaise,
          merchantSharePaise: q.merchantSharePaise,
          totalPaise: q.totalPaise,
          inspectionReason: priced.inspectionReason,
          deliveryAddress: priced.deliveryAddress ?? Prisma.JsonNull,
          pickupAddress: priced.pickupAddress,
          paymentExpiresAt,
          settingsVersion: priced.settingsVersion,
          // One attempt = one order = one provider order. A retry after expiry is a new order with a new key.
          idempotencyKey: `order_${randomUUID()}`,
        },
        select: { id: true },
      });
      await tx.orderEvent.create({ data: { orderId: order.id, fromState: null, toState: "CREATED", event: "create", actorType: "USER", actorId: actor.userId, payload: { ...q } } });
      await recordAudit(tx, { actor: { type: "USER", id: actor.userId }, action: "order.created", entity: { type: "Order", id: order.id }, after: { state: "CREATED", ...q, settingsVersion: priced.settingsVersion }, requestId: actor.requestId });
      await enqueueOutbox(tx, { queue: "orders", name: "expirePayment", payload: { orderId: order.id }, runAt: new Date(paymentExpiresAt.getTime() + 5_000) });
      return order.id;
    });
    return { orderId, resumed: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new UserError("Someone else is buying this part right now. Try again in a few minutes.");
    throw err;
  }
}

/** Starts (or reuses) the provider payment session for the buyer's CREATED order. */
export async function payOrder(db: Db, deps: CheckoutDeps, actor: Actor, orderId: string, baseUrl: string): Promise<CheckoutSession> {
  const order = await db.order.findFirst({ where: { id: orderId, buyerId: actor.userId }, select: { state: true, paymentExpiresAt: true } });
  if (!order) throw new NotFoundError("order");
  if (order.state === "CREATED" && order.paymentExpiresAt && order.paymentExpiresAt <= new Date()) throw new UserError("The time to pay for this order ran out. Start checkout again.");
  return startProviderPayment(db, deps.payment, {
    orderId,
    buyerId: actor.userId,
    returnUrl: `${baseUrl}/checkout/return?order=${encodeURIComponent(orderId)}`,
    notifyUrl: `${baseUrl}/api/webhooks/payments/${deps.payment.name === "cashfree" ? "cashfree" : "mock"}`,
  });
}
