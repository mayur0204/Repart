import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SellerBreakdown } from "@/components/checkout/money";
import { ActionForm, FormInput, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { PartnerCheckPanel } from "@/components/order/partner-check";
import { OrderTimeline, ShipmentTracking } from "@/components/order/timeline";
import { Badge, DateText } from "@/components/ui/display";
import { DISPUTE_REASON_TEXT, DISPUTE_STATUS_TEXT } from "@/lib/dispute";
import { ORDER_STATE_TEXT, RESTRICTION_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { fulfilment } from "@/server/services";
import { respondToDispute } from "../../../orders/actions";
import { bookPickup, confirmOrder, declineOrder } from "../actions";

export const metadata: Metadata = { title: "Order | RePart" };

const slotLabel = (s: { start: Date; end: Date }) => {
  const day = s.start.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const t = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return `${day}, ${t(s.start)} to ${t(s.end)}`;
};

function SlotSelect({ slots, label, name = "slot" }: { slots: Array<{ id: string; start: Date; end: Date }>; label: string; name?: string }) {
  return (
    <FormSelect label={label} name={name} defaultValue={slots[0]?.id}>
      {slots.map((s) => (
        <option key={s.id} value={s.id}>{slotLabel(s)}</option>
      ))}
    </FormSelect>
  );
}

/** Seller order page (PLAN.md §4.4 /seller/orders/[id]): confirm with countdown, pickup slot + packaging guide, shipment status. */
export default async function SellerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/seller/orders/${id}`);
  let o;
  try {
    o = await fulfilment.sellerOrder(user.id, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const delivery = o.fulfilmentMode === "DELIVERY";
  const restriction = RESTRICTION_TEXT[o.listing.category?.shippingRestriction ?? "NONE"];

  return (
    <Page title={o.title} actions={<Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>}>
      {o.state === "AWAITING_SELLER" ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Confirm the part is available</h2>
          {o.sellerConfirmBy ? (
            <p>
              Confirm by <DateText date={o.sellerConfirmBy} /> ({o.sellerHoursLeft} hours left). If you don&apos;t, the order is cancelled and the buyer is refunded.
            </p>
          ) : null}
          {o.inspectionReason ? (
            <p className="text-sm">
              {o.inspectionReason === "AUDIT" ? "This order was picked for a routine quality check (free for everyone). " : "This part needs a Partner Check. "}
              {o.inspectionCoverage ? "Choose when a partner garage mechanic can check the part at your pickup address." : "No partner garage serves your area yet. Confirm anyway: RePart will arrange the check and tell you the appointment."}
            </p>
          ) : null}
          {!delivery ? <p className="text-sm">Local pickup: after you confirm, agree a time and place with the buyer in Messages.</p> : null}
          <ActionForm action={confirmOrder} submitLabel="Confirm order">
            <input type="hidden" name="orderId" value={o.id} />
            {o.inspectionReason && o.inspectionCoverage ? (
              o.inspectionSlots.length ? (
                <SlotSelect slots={o.inspectionSlots} label="Partner Check slot" name="inspectionSlot" />
              ) : (
                <p className="text-sm text-danger">All partner garages are fully booked for the next few days. Try again tomorrow.</p>
              )
            ) : null}
            {delivery && o.slots.length ? <SlotSelect slots={o.slots} label={o.inspectionReason ? "Preferred pickup slot after the check" : "Pickup slot"} /> : null}
          </ActionForm>
          <details>
            <summary className="min-h-11 cursor-pointer py-2 text-action">Can&apos;t sell it after all?</summary>
            <ActionForm action={declineOrder} submitLabel="Decline order" submitVariant="secondary">
              <input type="hidden" name="orderId" value={o.id} />
              <FormInput label="Reason (optional, shown to the buyer)" name="reason" maxLength={300} />
              <p className="text-sm text-steel">The buyer gets a full refund and your listing is withdrawn.</p>
            </ActionForm>
          </details>
        </section>
      ) : null}

      {o.dispute ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Dispute</h2>
          <p>
            The buyer reported a problem: {DISPUTE_REASON_TEXT[o.dispute.reason] ?? o.dispute.reason}. {DISPUTE_STATUS_TEXT[o.dispute.status] ?? o.dispute.status}.
          </p>
          {o.sellerCanRespond && o.disputeDeadline ? (
            <>
              <p className="text-sm">
                Respond by <DateText date={o.disputeDeadline} />. After that RePart decides without your side.
              </p>
              <ActionForm action={respondToDispute} submitLabel="Send response">
                <input type="hidden" name="orderId" value={o.id} />
                <FormTextarea label="Your side of what happened" name="response" rows={4} maxLength={2000} />
              </ActionForm>
            </>
          ) : null}
          <Link href={`/orders/${o.id}/dispute`} className="text-action underline underline-offset-4">View the dispute and add photos</Link>
        </section>
      ) : null}
      {o.state === "COMPLETED" ? (
        <p className="border border-rule bg-surface p-3">
          Order complete. <Link href={`/orders/${o.id}/review`} className="text-action underline underline-offset-4">Leave a review for the buyer</Link>
        </p>
      ) : null}

      {o.inspection || o.state === "INSPECTION_SCHEDULED" ? <PartnerCheckPanel inspection={o.inspection} audience="seller" reason={o.inspectionReason} /> : null}

      {o.state === "INSPECTION_PASSED" && delivery ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Book the pickup</h2>
          <p>The Partner Check passed. Choose a pickup slot for the courier.</p>
          <ActionForm action={bookPickup} submitLabel="Book pickup">
            <input type="hidden" name="orderId" value={o.id} />
            <SlotSelect slots={o.slots} label="Pickup slot" />
          </ActionForm>
        </section>
      ) : null}

      {o.state === "AWAITING_HANDOVER" ? (
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <h2 className="text-xl">Hand over the part</h2>
          <p>Agree a safe, public place and a time with the buyer. The buyer confirms the handover in the app.</p>
          {o.conversationId ? <Link href={`/messages/${o.conversationId}`} className="text-action underline underline-offset-4">Open messages with the buyer</Link> : null}
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">{delivery ? "Shipping" : "Local pickup"}</h2>
          {delivery && o.listing.category ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-lg">Packaging guide</h3>
              <p className="text-sm">{o.listing.category.packagingGuide}</p>
              {restriction ? <p className="text-sm font-semibold">{restriction}</p> : null}
            </div>
          ) : null}
          {o.shipment ? <ShipmentTracking shipment={o.shipment} /> : delivery ? <p className="text-sm text-steel">No pickup booked yet.</p> : null}
        </section>
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Progress</h2>
          <OrderTimeline steps={o.timeline} />
        </section>
      </div>

      <section className="flex max-w-xl flex-col gap-2 border border-rule bg-surface p-4">
        <h2 className="text-xl">What you receive</h2>
        <SellerBreakdown itemPricePaise={o.itemPricePaise} money={o.money} />
        {o.payment ? <p className="text-sm text-steel">Payout: {SETTLEMENT_TEXT[o.payment.vendorSettlementStatus] ?? o.payment.vendorSettlementStatus}.</p> : null}
        {o.cancelReason ? <p className="text-sm">{o.cancelReason}</p> : null}
      </section>
    </Page>
  );
}
