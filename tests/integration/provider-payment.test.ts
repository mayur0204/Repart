import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { createMockPaymentProvider } from "../../src/server/adapters/payment/mock";
import type { PaymentProvider } from "../../src/server/adapters/payment/types";
import { NotFoundError, UserError } from "../../src/server/http/errors";
import { startProviderPayment } from "../../src/server/services/payment/provider-payment";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;
const LISTING = "sample-listing-live-tier-a";
const BUYER = "sample-user-buyer";

/** A CREATED order priced on the server (Model S: total = item + shipping + check; fee from seller). */
async function createdOrder(id: string) {
  // One open order per listing (DB index): clear earlier test orders first.
  await db.payment.deleteMany({ where: { orderId: { startsWith: "test-pp-" } } });
  await db.order.deleteMany({ where: { id: { startsWith: "test-pp-" } } });
  return db.order.create({
    data: {
      id,
      buyerId: BUYER,
      sellerId: "sample-user-seller",
      listingId: LISTING,
      fulfilmentMode: "DELIVERY",
      pickupAddress: {},
      settingsVersion: 1,
      idempotencyKey: `${id}-key`,
      state: "CREATED",
      itemPricePaise: 65000,
      shippingFeePaise: 9000,
      checkFeePaise: 0,
      platformFeePaise: 0,
      vendorSharePaise: 65000,
      merchantSharePaise: 9000,
      totalPaise: 74000,
    },
  });
}

/** A fake Cashfree-shaped provider that records calls. */
function sessionProvider() {
  const createOrder = vi.fn(async (input: Parameters<PaymentProvider["createOrder"]>[0]) => ({
    providerOrderId: `cf_${input.orderId}`,
    status: "CREATED" as const,
    checkoutUrl: null,
    paymentSessionId: "session_test_123",
    amount: input.amount,
  }));
  return { provider: { ...createMockPaymentProvider({ webhookSecret: "x".repeat(20), baseUrl: "" }), name: "cashfree", createOrder } as PaymentProvider, createOrder };
}

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await db.payment.deleteMany({ where: { orderId: { startsWith: "test-pp-" } } });
  await db.order.deleteMany({ where: { id: { startsWith: "test-pp-" } } });
  await db.$disconnect();
});

describe("startProviderPayment (M8 step 2)", () => {
  it("creates the provider order from the server-priced total and stores the identifiers", async () => {
    const order = await createdOrder("test-pp-1");
    const { provider, createOrder } = sessionProvider();
    const session = await startProviderPayment(db, provider, { orderId: order.id, buyerId: BUYER, returnUrl: "http://localhost:3000/r" });
    expect(session).toEqual({ provider: "cashfree", paymentSessionId: "session_test_123", checkoutUrl: null });
    expect(createOrder.mock.calls[0]![0]).toMatchObject({ orderId: order.id, amount: 74000, idempotencyKey: "test-pp-1-key", customer: { id: BUYER } });
    expect(await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      provider: "cashfree",
      providerOrderId: "cf_test-pp-1",
      providerSessionId: "session_test_123",
      status: "CREATED",
      amountPaise: 74000,
      vendorSharePaise: 65000,
      merchantSharePaise: 9000,
    });
  });

  it("is idempotent: a repeat call returns the stored session without a second provider order", async () => {
    const order = await createdOrder("test-pp-2");
    const { provider, createOrder } = sessionProvider();
    const a = await startProviderPayment(db, provider, { orderId: order.id, buyerId: BUYER, returnUrl: "http://x/r" });
    const b = await startProviderPayment(db, provider, { orderId: order.id, buyerId: BUYER, returnUrl: "http://x/r" });
    expect(b.paymentSessionId).toBe(a.paymentSessionId);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("only the order's buyer can start it, and only while the order is CREATED", async () => {
    const order = await createdOrder("test-pp-3");
    const { provider, createOrder } = sessionProvider();
    await expect(startProviderPayment(db, provider, { orderId: order.id, buyerId: "sample-user-buyer-2", returnUrl: "http://x/r" })).rejects.toBeInstanceOf(NotFoundError);
    await db.order.update({ where: { id: order.id }, data: { state: "CANCELLED" } });
    await expect(startProviderPayment(db, provider, { orderId: order.id, buyerId: BUYER, returnUrl: "http://x/r" })).rejects.toBeInstanceOf(UserError);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("refuses to start payment unless the seller's vendor account is ACTIVE", async () => {
    const order = await createdOrder("test-pp-5");
    const { provider, createOrder } = sessionProvider();
    try {
      for (const status of ["PENDING", "ACTION_REQUIRED", "ON_HOLD", "BLOCKED"] as const) {
        await db.payoutAccount.update({ where: { userId: "sample-user-seller" }, data: { status } });
        await expect(startProviderPayment(db, provider, { orderId: order.id, buyerId: BUYER, returnUrl: "http://x/r" })).rejects.toBeInstanceOf(UserError);
      }
      expect(createOrder).not.toHaveBeenCalled();
    } finally {
      await db.payoutAccount.update({ where: { userId: "sample-user-seller" }, data: { status: "ACTIVE" } });
    }
  });

  it("the mock provider still works through the same path", async () => {
    const order = await createdOrder("test-pp-4");
    const mock = createMockPaymentProvider({ webhookSecret: "x".repeat(20), baseUrl: "http://localhost:3000" });
    const s = await startProviderPayment(db, mock, { orderId: order.id, buyerId: BUYER, returnUrl: "http://x/r" });
    expect(s).toEqual({ provider: "mock", paymentSessionId: null, checkoutUrl: "http://localhost:3000/dev/mock-checkout/test-pp-4" });
  });
});
