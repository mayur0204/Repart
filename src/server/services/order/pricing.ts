/**
 * Order money, Model S: ONE platform fee, deducted from the seller (PLAN.md §7.1, decision D-10).
 *
 *   platformFee   = round_half_up(itemPrice × platformFeeBps / 10000)   (0 ≤ platformFee ≤ itemPrice)
 *   total         = itemPrice + shippingFee + checkFee                  charged to the buyer (fee NOT added)
 *   vendorShare   = itemPrice − platformFee                             split to the seller's vendor account
 *   merchantShare = shippingFee + checkFee + platformFee                stays with RePart
 *   invariant       vendorShare + merchantShare = total
 *
 * Example: item ₹10,000, delivery ₹300, check ₹200, fee ₹300 → buyer pays ₹10,500, seller gets ₹9,700, RePart keeps ₹800.
 * All values are integer paise and are computed only here, on the server. The DB CHECKs enforce the same identities.
 */
export type Quote = {
  itemPricePaise: number;
  shippingFeePaise: number;
  checkFeePaise: number;
  platformFeeBps: number;
  platformFeePaise: number;
  totalPaise: number;
  vendorSharePaise: number;
  merchantSharePaise: number;
};

const isPaise = (n: number) => Number.isInteger(n) && n >= 0;

/** Integer round-half-up of a / b for non-negative integers. */
export const roundHalfUpDiv = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

export function quote(input: { itemPricePaise: number; shippingFeePaise: number; checkFeePaise: number; platformFeeBps: number }): Quote {
  const { itemPricePaise: item, shippingFeePaise: shipping, checkFeePaise: check, platformFeeBps: bps } = input;
  if (![item, shipping, check].every(isPaise)) throw new Error("prices must be whole, non-negative paise");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("platform fee must be 0–10000 bps");
  const platformFeePaise = Math.min(item, roundHalfUpDiv(item * bps, 10_000));
  const totalPaise = item + shipping + check;
  const vendorSharePaise = item - platformFeePaise;
  const merchantSharePaise = shipping + check + platformFeePaise;
  if (vendorSharePaise + merchantSharePaise !== totalPaise) throw new Error("pricing invariant broken");
  return { itemPricePaise: item, shippingFeePaise: shipping, checkFeePaise: check, platformFeeBps: bps, platformFeePaise, totalPaise, vendorSharePaise, merchantSharePaise };
}

/** The one read model every money view uses (checkout, order pages, admin), so they can't disagree. */
export function orderMoneyView(o: Pick<Quote, "itemPricePaise" | "shippingFeePaise" | "checkFeePaise" | "platformFeePaise" | "totalPaise" | "vendorSharePaise" | "merchantSharePaise">) {
  return {
    buyerLines: [
      { label: "Item", paise: o.itemPricePaise },
      { label: "Delivery", paise: o.shippingFeePaise },
      { label: "Partner Check", paise: o.checkFeePaise },
    ].filter((l) => l.label === "Item" || l.paise > 0),
    buyerTotal: o.totalPaise,
    platformFee: o.platformFeePaise, // shown as "deducted from seller payout", never added to the buyer total
    sellerReceives: o.vendorSharePaise,
    repartKeeps: o.merchantSharePaise,
  };
}

/**
 * Refund allocation (PLAN.md §7.5): the fee is returned in proportion to the item refunded, so the platform
 * never keeps a fee on money given back. The fee share is computed on the cumulative item refunded
 * (`itemAlreadyRefunded`), so several partial refunds add up to exactly the vendor and fee shares.
 */
export function allocateRefund(
  order: Pick<Quote, "itemPricePaise" | "shippingFeePaise" | "checkFeePaise" | "platformFeePaise">,
  c: { item: number; shipping: number; check: number },
  itemAlreadyRefunded = 0,
) {
  if (![c.item, c.shipping, c.check].every(isPaise)) throw new Error("refund components must be whole, non-negative paise");
  if (c.item + itemAlreadyRefunded > order.itemPricePaise || c.shipping > order.shippingFeePaise || c.check > order.checkFeePaise) throw new Error("refund component exceeds what was charged");
  const feeUpTo = (item: number) => (order.itemPricePaise === 0 ? 0 : roundHalfUpDiv(item * order.platformFeePaise, order.itemPricePaise));
  const feeShare = feeUpTo(itemAlreadyRefunded + c.item) - feeUpTo(itemAlreadyRefunded);
  const vendorPortionPaise = c.item - feeShare;
  const merchantPortionPaise = feeShare + c.shipping + c.check;
  return { feeSharePaise: feeShare, vendorPortionPaise, merchantPortionPaise, amountPaise: vendorPortionPaise + merchantPortionPaise };
}
