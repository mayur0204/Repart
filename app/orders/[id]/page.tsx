import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BuyerBreakdown } from "@/components/checkout/money";
import { PayForm } from "@/components/checkout/pay-form";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { PartnerCheckPanel } from "@/components/order/partner-check";
import { OrderTimeline, ShipmentTracking } from "@/components/order/timeline";
import { Badge, DateText } from "@/components/ui/display";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT, REFUND_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { retryPayment } from "../../checkout/actions";
import { cancelOrder, confirmHandover } from "../actions";

export const metadata: Metadata = { title: "Order | RePart" };

/** Buyer order page (PLAN.md §4.5): timeline, tracking, fulfilment status. Acceptance and disputes are M11. */
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
  if (o.role === "seller") redirect(`/seller/orders/${o.id}`);
  const delivery = o.fulfilmentMode === "DELIVERY";
  const refundTotal = o.cancelRefund ? o.cancelRefund.item + o.cancelRefund.shipping + o.cancelRefund.check : 0;

  return (
    <Page title={o.title} actions={<Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>}>
      {o.state === "AWAITING_SELLER" && o.sellerConfirmBy ? (
        <p className="border border-rule bg-surface p-3">
          Waiting for the seller to confirm, by <DateText date={o.sellerConfirmBy} /> ({o.sellerHoursLeft} hours left). If they don&apos;t, you get a full refund.
        </p>
      ) : null}
      {o.inspectionReason || o.inspection ? <PartnerCheckPanel inspection={o.inspection} audience="buyer" reason={o.inspectionReason} waitingForSeller={o.state === "PAID_HELD" || o.state === "AWAITING_SELLER"} /> : null}
      {o.state === "AWAITING_HANDOVER" ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Collect the part</h2>
          <p>Agree a safe, public place and a time with the seller in Messages. When you have the part, confirm the handover here.</p>
          {o.conversationId ? <Link href={`/messages/${o.conversationId}`} className="text-action underline underline-offset-4">Open messages with the seller</Link> : null}
          <ActionForm action={confirmHandover} submitLabel="I have the part">
            <input type="hidden" name="orderId" value={o.id} />
          </ActionForm>
        </section>
      ) : null}
      {o.state === "ACCEPTANCE_WINDOW" && o.acceptanceEndsAt ? (
        <p className="border border-caution bg-surface p-3">
          Check the part. You have until <DateText date={o.acceptanceEndsAt} /> ({o.acceptanceHoursLeft} hours left) to report a problem.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Progress</h2>
          <OrderTimeline steps={o.timeline} />
          {o.cancelReason ? <p className="text-sm text-steel">{o.cancelReason}</p> : null}
        </section>

        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">{delivery ? "Delivery" : "Local pickup"}</h2>
          {o.shipment ? <ShipmentTracking shipment={o.shipment} /> : <p className="text-sm text-steel">{delivery ? "The courier pickup is booked once the seller confirms." : "You collect the part from the seller."}</p>}
        </section>

        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">What you pay</h2>
          <BuyerBreakdown money={o.money} />
          {o.payment ? <p className="text-sm text-steel">{o.payment.paidAt ? "Paid. Your money is held until you accept the part." : "Not paid yet."}</p> : null}
          {o.paymentOpen ? (
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

        {o.cancelRefund ? (
          <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
            <h2 className="text-xl">Cancel this order</h2>
            <p className="text-sm">
              You can cancel until the part is picked up. You&apos;d get back {formatPrice(refundTotal)}
              {o.cancelRefund.check === 0 && o.checkFeePaise > 0 ? " (the Partner Check fee isn't refunded once the check is done)" : ""}.
            </p>
            <ActionForm action={cancelOrder} submitLabel="Cancel order" submitVariant="secondary">
              <input type="hidden" name="orderId" value={o.id} />
              <FormInput label="Reason (optional)" name="reason" maxLength={300} />
            </ActionForm>
          </section>
        ) : null}
      </div>
    </Page>
  );
}
