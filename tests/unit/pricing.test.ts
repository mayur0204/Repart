import { describe, expect, it } from "vitest";
import { allocateRefund, orderMoneyView, quote, roundHalfUpDiv } from "@/server/services/order/pricing";

const rupees = (r: number) => r * 100;

describe("Model S pricing: one platform fee, deducted from the seller (D-10)", () => {
  it("the brief's example: buyer pays ₹10,500, seller receives ₹9,700, RePart keeps ₹800", () => {
    const q = quote({ itemPricePaise: rupees(10_000), shippingFeePaise: rupees(300), checkFeePaise: rupees(200), platformFeeBps: 300 });
    expect(q.platformFeePaise).toBe(rupees(300));
    expect(q.totalPaise).toBe(rupees(10_500)); // the fee is NOT added to the buyer total
    expect(q.vendorSharePaise).toBe(rupees(9_700));
    expect(q.merchantSharePaise).toBe(rupees(800));
    const view = orderMoneyView(q);
    expect(view.buyerLines.map((l) => l.label)).toEqual(["Item", "Delivery", "Partner Check"]);
    expect(view.buyerLines.reduce((s, l) => s + l.paise, 0)).toBe(view.buyerTotal);
    expect(view.platformFee).toBe(rupees(300));
  });

  it("rounds the fee half up and never above the item price", () => {
    expect(roundHalfUpDiv(5, 2)).toBe(3);
    expect(quote({ itemPricePaise: 150, shippingFeePaise: 0, checkFeePaise: 0, platformFeeBps: 100 }).platformFeePaise).toBe(2); // 1.5 → 2
    expect(quote({ itemPricePaise: 1000, shippingFeePaise: 0, checkFeePaise: 0, platformFeeBps: 10_000 }).vendorSharePaise).toBe(0);
  });

  it("rejects fractional or negative money and out-of-range fees", () => {
    expect(() => quote({ itemPricePaise: 10.5, shippingFeePaise: 0, checkFeePaise: 0, platformFeeBps: 0 })).toThrow();
    expect(() => quote({ itemPricePaise: 100, shippingFeePaise: -1, checkFeePaise: 0, platformFeeBps: 0 })).toThrow();
    expect(() => quote({ itemPricePaise: 100, shippingFeePaise: 0, checkFeePaise: 0, platformFeeBps: 10_001 })).toThrow();
  });

  it("property: shares always add up to the buyer total, and the fee is counted once", () => {
    let seed = 42;
    const rnd = (max: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % max;
    for (let i = 0; i < 2000; i++) {
      const q = quote({ itemPricePaise: rnd(5_000_000), shippingFeePaise: rnd(50_000), checkFeePaise: rnd(50_000), platformFeeBps: rnd(10_001) });
      expect(q.vendorSharePaise + q.merchantSharePaise).toBe(q.totalPaise);
      expect(q.totalPaise).toBe(q.itemPricePaise + q.shippingFeePaise + q.checkFeePaise);
      expect(q.merchantSharePaise - q.shippingFeePaise - q.checkFeePaise).toBe(q.platformFeePaise);
    }
  });
});

describe("refund allocation (PLAN.md §7.5)", () => {
  const order = quote({ itemPricePaise: rupees(10_000), shippingFeePaise: rupees(300), checkFeePaise: rupees(200), platformFeeBps: 300 });

  it("a full refund returns ₹9,700 from the seller split and ₹800 from RePart", () => {
    const a = allocateRefund(order, { item: rupees(10_000), shipping: rupees(300), check: rupees(200) });
    expect(a).toEqual({ feeSharePaise: rupees(300), vendorPortionPaise: rupees(9_700), merchantPortionPaise: rupees(800), amountPaise: rupees(10_500) });
  });

  it("returns the fee in proportion to the item refunded", () => {
    const a = allocateRefund(order, { item: rupees(5_000), shipping: 0, check: 0 });
    expect(a).toMatchObject({ feeSharePaise: rupees(150), vendorPortionPaise: rupees(4_850), merchantPortionPaise: rupees(150), amountPaise: rupees(5_000) });
  });

  it("refuses components above what was charged", () => {
    expect(() => allocateRefund(order, { item: rupees(10_001), shipping: 0, check: 0 })).toThrow();
    expect(() => allocateRefund(order, { item: 0, shipping: rupees(301), check: 0 })).toThrow();
  });

  it("property: any split of the order into refunds never exceeds the shares (§7.5 guarantees)", () => {
    let seed = 7;
    const rnd = (max: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % (max + 1);
    for (let i = 0; i < 500; i++) {
      const o = quote({ itemPricePaise: 1 + rnd(2_000_000), shippingFeePaise: rnd(30_000), checkFeePaise: rnd(30_000), platformFeeBps: rnd(3_000) });
      const first = { item: rnd(o.itemPricePaise), shipping: rnd(o.shippingFeePaise), check: rnd(o.checkFeePaise) };
      const rest = { item: o.itemPricePaise - first.item, shipping: o.shippingFeePaise - first.shipping, check: o.checkFeePaise - first.check };
      const a = allocateRefund(o, first);
      const b = allocateRefund(o, rest, first.item);
      expect(a.amountPaise + b.amountPaise).toBe(o.totalPaise);
      expect(a.vendorPortionPaise + b.vendorPortionPaise).toBe(o.vendorSharePaise);
      expect(a.merchantPortionPaise + b.merchantPortionPaise).toBe(o.merchantSharePaise);
      expect(a.feeSharePaise + b.feeSharePaise).toBe(o.platformFeePaise);
      expect(Math.min(a.vendorPortionPaise, b.vendorPortionPaise, a.feeSharePaise, b.feeSharePaise)).toBeGreaterThanOrEqual(0);
    }
  });
});
