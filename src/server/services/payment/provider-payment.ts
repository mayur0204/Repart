import "server-only";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { PaymentProvider } from "../../adapters/payment/types";
import { NotFoundError, UserError } from "../../http/errors";

/**
 * Starts the provider payment for an existing RePart order (PLAN.md §7.2 step 3, M8 step 2).
 * The amount always comes from the order row the server priced, never from the browser.
 * One Payment per order (unique orderId): a repeat call returns the stored session instead of
 * creating another provider order. Returns only what the browser checkout needs.
 * Order state transitions (O1 onwards) are a later M8 step.
 */
type Db = Pick<PrismaClient, "order" | "payment">;

export type CheckoutSession = { provider: string; paymentSessionId: string | null; checkoutUrl: string | null };

export async function startProviderPayment(
  db: Db,
  provider: PaymentProvider,
  input: { orderId: string; buyerId: string; returnUrl: string; notifyUrl?: string | null },
): Promise<CheckoutSession> {
  const order = await db.order.findFirst({
    where: { id: input.orderId, buyerId: input.buyerId },
    select: {
      id: true,
      state: true,
      totalPaise: true,
      vendorSharePaise: true,
      merchantSharePaise: true,
      idempotencyKey: true,
      paymentExpiresAt: true,
      buyer: { select: { id: true, phone: true, name: true, email: true } },
      seller: { select: { payoutAccount: { select: { providerVendorId: true, status: true } } } },
    },
  });
  if (!order) throw new NotFoundError("order");
  if (order.state !== "CREATED") throw new UserError("This order can no longer be paid.");
  // Plan A-6: no payment until the seller's payout vendor is ACTIVE (the seller share can't be split otherwise).
  if (order.seller.payoutAccount?.status !== "ACTIVE") throw new UserError("This seller can't receive payments yet. Try again later.");

  const stored = await db.payment.findUnique({ where: { orderId: order.id } });
  if (stored) return sessionOf(stored, provider.name);

  const created = await provider.createOrder({
    orderId: order.id,
    amount: order.totalPaise,
    vendorId: order.seller.payoutAccount?.providerVendorId ?? "",
    vendorShare: order.vendorSharePaise,
    customer: { id: order.buyer.id, phone: order.buyer.phone, name: order.buyer.name, email: order.buyer.email },
    returnUrl: input.returnUrl,
    notifyUrl: input.notifyUrl,
    expiresAt: order.paymentExpiresAt ?? undefined,
    idempotencyKey: order.idempotencyKey,
  });
  if (created.amount !== order.totalPaise) throw new Error(`provider amount ${created.amount} does not match order total ${order.totalPaise}`);

  try {
    const payment = await db.payment.create({
      data: {
        orderId: order.id,
        provider: provider.name,
        providerOrderId: created.providerOrderId,
        providerSessionId: created.paymentSessionId,
        amountPaise: order.totalPaise,
        vendorSharePaise: order.vendorSharePaise,
        merchantSharePaise: order.merchantSharePaise,
      },
    });
    return { ...sessionOf(payment, provider.name), checkoutUrl: created.checkoutUrl };
  } catch (err) {
    // A concurrent request stored it first: return that one (same idempotency key, same provider order).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return sessionOf(await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }), provider.name);
    }
    throw err;
  }
}

const sessionOf = (p: { provider: string; providerSessionId: string | null }, fallback: string): CheckoutSession => ({
  provider: p.provider || fallback,
  paymentSessionId: p.providerSessionId,
  checkoutUrl: null,
});
