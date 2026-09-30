import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BuyerBreakdown, SellerBreakdown } from "@/components/checkout/money";
import { PayForm } from "@/components/checkout/pay-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT, REFUND_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { retryPayment } from "../../checkout/actions";

export const metadata: Metadata = { title: "Order | RePart" };

/** Order page for the buyer or the seller (PLAN.md §4.5). Shipping and acceptance steps arrive in M9. */
export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/orders/${id}`);
  let o;
  try {
    o = await orders.forUser(user.id, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const canPay = o.role === "buyer" && o.state === "CREATED" && (!o.paymentExpiresAt || o.paymentExpiresAt > new Date());

  return (
    <Page title={o.title} actions={<Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">{o.role === "buyer" ? "What you pay" : "What you receive"}</h2>
          {o.role === "buyer" ? <BuyerBreakdown money={o.money} /> : <SellerBreakdown itemPricePaise={o.itemPricePaise} money={o.money} />}
          {o.payment ? (
            <p className="text-sm text-steel">
              {o.role === "seller" ? `Payout: ${SETTLEMENT_TEXT[o.payment.vendorSettlementStatus] ?? o.payment.vendorSettlementStatus}.` : o.payment.paidAt ? "Paid. Your money is held until you accept the part." : "Not paid yet."}
            </p>
          ) : null}
          {canPay ? (
            <>
              {o.paymentExpiresAt ? (
                <p className="text-sm">
                  Pay before <DateText date={o.paymentExpiresAt} /> or the part is released.
                </p>
              ) : null}
              <PayForm action={retryPayment} label={`Pay ${formatPrice(o.totalPaise)}`} mode="sandbox">
                <input type="hidden" name="orderId" value={o.id} />
              </PayForm>
            </>
          ) : null}
          {o.cancelReason ? <p className="text-sm text-steel">{o.cancelReason}</p> : null}
        </section>

        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Timeline</h2>
          <ol className="flex flex-col">
            {o.events.map((e, i) => (
              <li key={i} className="flex justify-between gap-4 border-b border-rule py-2">
                <span>{ORDER_STATE_TEXT[e.toState] ?? e.toState}</span>
                <DateText date={e.createdAt} className="text-sm text-steel" />
              </li>
            ))}
          </ol>
          {o.payment?.refunds.length ? (
            <>
              <h3 className="text-lg">Refunds</h3>
              <ul className="flex flex-col">
                {o.payment.refunds.map((r) => (
                  <li key={r.id} className="flex justify-between gap-4 border-b border-rule py-2">
                    <span className="tabular-nums">{formatPrice(r.amountPaise)}</span>
                    <span>{REFUND_TEXT[r.status] ?? r.status}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>
    </Page>
  );
}
