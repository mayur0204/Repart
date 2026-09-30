import { formatPrice } from "@/lib/format";

type Money = { buyerLines: Array<{ label: string; paise: number }>; buyerTotal: number; platformFee: number; sellerReceives: number };

/** Buyer breakdown (PLAN.md §7.1): the platform fee is shown but never added to the total. */
export function BuyerBreakdown({ money }: { money: Money }) {
  return (
    <dl className="flex flex-col">
      {money.buyerLines.map((l) => (
        <div key={l.label} className="flex justify-between gap-4 border-b border-rule py-2">
          <dt>{l.label}</dt>
          <dd className="tabular-nums">{formatPrice(l.paise)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-b border-ink py-2 font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatPrice(money.buyerTotal)}</dd>
      </div>
      <div className="flex justify-between gap-4 py-2 text-sm text-steel">
        <dt>Platform fee</dt>
        <dd>{money.platformFee > 0 ? `${formatPrice(money.platformFee)}, deducted from seller payout` : "Deducted from seller payout"}</dd>
      </div>
    </dl>
  );
}

/** Seller view of the same order: item price, minus the one platform fee, is what they receive. */
export function SellerBreakdown({ itemPricePaise, money }: { itemPricePaise: number; money: Money }) {
  return (
    <dl className="flex flex-col">
      <div className="flex justify-between gap-4 border-b border-rule py-2">
        <dt>Item price</dt>
        <dd className="tabular-nums">{formatPrice(itemPricePaise)}</dd>
      </div>
      <div className="flex justify-between gap-4 border-b border-rule py-2">
        <dt>Platform fee</dt>
        <dd className="tabular-nums">{money.platformFee > 0 ? `−${formatPrice(money.platformFee)}` : formatPrice(0)}</dd>
      </div>
      <div className="flex justify-between gap-4 py-2 font-semibold">
        <dt>You receive</dt>
        <dd className="tabular-nums">{formatPrice(money.sellerReceives)}</dd>
      </div>
    </dl>
  );
}
