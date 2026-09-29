import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { seed } from "../../prisma/seed/seed";
import { testPrisma } from "../setup/test-db";

let db: PrismaClient;

beforeAll(async () => {
  db = testPrisma();
  await seed(db);
});
afterAll(async () => {
  await db.$disconnect();
});

const baseOrder = (id: string, listingId: string) => ({
  id,
  buyerId: "sample-user-buyer",
  sellerId: "sample-user-seller",
  listingId,
  fulfilmentMode: "DELIVERY" as const,
  pickupAddress: {},
  settingsVersion: 1,
  idempotencyKey: `${id}-key`,
  state: "CANCELLED" as const,
});

describe("one platform fee, Model S (D-10) enforced by the database", () => {
  // ₹10,000 item, ₹300 delivery, ₹200 check, ₹300 fee (300 bps)
  const item = 1_000_000;
  const shipping = 30_000;
  const check = 20_000;
  const fee = 30_000;

  it("accepts the Model S example: buyer ₹10,500, seller ₹9,700, platform keeps one ₹300 fee", async () => {
    const order = await db.order.create({
      data: {
        ...baseOrder("t-order-model-s", "sample-listing-live-tier-b-optional"),
        itemPricePaise: item,
        shippingFeePaise: shipping,
        checkFeePaise: check,
        platformFeePaise: fee,
        platformFeeBps: 300,
        vendorSharePaise: item - fee,
        merchantSharePaise: shipping + check + fee,
        totalPaise: item + shipping + check,
      },
    });
    expect(order.totalPaise).toBe(1_050_000);
    expect(order.vendorSharePaise).toBe(970_000);
  });

  it("rejects the double-fee version (buyer ₹10,800 while seller also loses the fee)", async () => {
    await expect(
      db.order.create({
        data: {
          ...baseOrder("t-order-double-fee", "sample-listing-live-tier-b-optional"),
          itemPricePaise: item,
          shippingFeePaise: shipping,
          checkFeePaise: check,
          platformFeePaise: fee,
          platformFeeBps: 300,
          vendorSharePaise: item - fee,
          merchantSharePaise: shipping + check + fee,
          totalPaise: item + shipping + check + fee,
        },
      }),
    ).rejects.toThrow(/Order_total_is_sum_of_shares/);
  });

  it("rejects a vendor share that is not item − fee", async () => {
    await expect(
      db.order.create({
        data: {
          ...baseOrder("t-order-bad-vendor", "sample-listing-live-tier-b-optional"),
          itemPricePaise: item,
          platformFeePaise: fee,
          vendorSharePaise: item,
          merchantSharePaise: fee,
          totalPaise: item + fee,
        },
      }),
    ).rejects.toThrow(/Order_vendor_share/);
  });
});

describe("other invariants", () => {
  it("allows only one open order per listing", async () => {
    // sample-listing-reserved already has an AWAITING_SELLER order
    await expect(
      db.order.create({
        data: {
          ...baseOrder("t-order-second-open", "sample-listing-reserved"),
          state: "CREATED",
          itemPricePaise: 100,
          vendorSharePaise: 100,
          merchantSharePaise: 0,
          totalPaise: 100,
        },
      }),
    ).rejects.toThrow(/Order_one_open_order_per_listing|Unique constraint/);
  });

  it("allows only one primary garage vehicle per user", async () => {
    await expect(
      db.garageVehicle.update({ where: { id: "sample-garage-buyer-city" }, data: { isPrimary: true } }),
    ).rejects.toThrow(/GarageVehicle_one_primary_per_user|Unique constraint/);
  });

  it("requires notes on FITS_WITH_MODIFICATION links", async () => {
    await expect(
      db.interchangeLink.create({
        data: { partNumberAId: "sample-pn-mir-0002", partNumberBId: "sample-pn-mir-0001", type: "FITS_WITH_MODIFICATION", source: "ADMIN" },
      }),
    ).rejects.toThrow(/InterchangeLink_modification_needs_notes/);
  });

  it("requires a fitment to link exactly one of part number or listing", async () => {
    await expect(
      db.fitment.create({ data: { variantId: "sample-variant-street-150-std", source: "SELLER_DECLARED" } }),
    ).rejects.toThrow(/Fitment_exactly_one_subject/);
  });

  it("refund amount must equal vendor + merchant portions", async () => {
    await expect(
      db.refund.create({
        data: {
          paymentId: "sample-order-completed-payment",
          amountPaise: 1000,
          vendorPortionPaise: 600,
          merchantPortionPaise: 300,
          components: {},
          reason: "test",
          withSplitReversal: true,
          idempotencyKey: "t-refund-bad",
        },
      }),
    ).rejects.toThrow(/Refund_portions_sum/);
  });

  it("audit log is append-only", async () => {
    const row = await db.auditLog.create({
      data: { actorType: "SYSTEM", action: "test.append", entityType: "Test", entityId: "1" },
    });
    await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});
