import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm, FormInput, FormSelect, InlineAction } from "@/components/forms/action-form";
import { BuyerBreakdown, SellerBreakdown } from "@/components/checkout/money";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT, REFUND_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { ShipmentTracking } from "@/components/order/timeline";
import { env } from "@/server/env";
import { advanceShipment, cancelAndRefund, confirmDeliveryReturn, recheckPayment, refundCancelledOrder, resolveOrderDispute } from "../actions";

export const metadata: Metadata = { title: "Order | Admin | RePart" };

const OPEN_PAID = ["PAID_HELD", "AWAITING_SELLER", "INSPECTION_SCHEDULED", "INSPECTION_PASSED", "PICKUP_SCHEDULED", "IN_TRANSIT", "DELIVERED", "AWAITING_HANDOVER", "ACCEPTANCE_WINDOW", "DISPUTED"];

function RefundFields() {
  return (
    <>
      <FormInput label="Reason" name="reason" required />
      <p className="text-sm text-steel">Amounts in paise. Leave blank to refund everything still refundable in that part.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormInput label="Item" name="item" inputMode="numeric" />
        <FormInput label="Delivery" name="shipping" inputMode="numeric" />
        <FormInput label="Partner Check" name="check" inputMode="numeric" />
      </div>
    </>
  );
}

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/orders/${id}`))) return <PermissionDenied />;
  let o;
  try {
    o = await orders.adminGet(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const p = o.payment;
  const devTools = process.env.NODE_ENV !== "production" && env().SHIPPING_PROVIDER === "mock";
  return (
    <Page title={o.title} intro={`Order ${o.id}`} actions={<Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Money</h2>
          <BuyerBreakdown money={o.money} />
          <SellerBreakdown itemPricePaise={o.itemPricePaise} money={o.money} />
          <p className="text-sm">RePart keeps {formatPrice(o.merchantSharePaise)} (delivery, check and the platform fee).</p>
        </section>
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4 text-sm">
          <h2 className="text-xl">Payment</h2>
          {p ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt>Provider</dt><dd>{p.provider}</dd>
              <dt>Status</dt><dd>{p.status}</dd>
              <dt>Provider order</dt><dd className="break-all">{p.providerOrderId}</dd>
              <dt>Provider payment</dt><dd className="break-all">{p.providerPaymentId ?? "None"}</dd>
              <dt>Seller vendor</dt><dd className="break-all">{p.vendorId ?? "None"}</dd>
              <dt>Seller payout</dt><dd>{SETTLEMENT_TEXT[p.vendorSettlementStatus] ?? p.vendorSettlementStatus}</dd>
              <dt>Hold deadline</dt><dd>{o.autoReleaseAt ? <DateText date={o.autoReleaseAt} /> : "None"}</dd>
            </dl>
          ) : (
            <p>No payment started.</p>
          )}
          <p>Seller vendor account: {o.seller.payoutAccount?.status ?? "not set up"}</p>
          {o.deadlineBreachedAt ? <p className="text-danger">The provider hold deadline passed on <DateText date={o.deadlineBreachedAt} />.</p> : null}
          <InlineAction action={recheckPayment} label="Re-check payment with provider" variant="secondary">
            <input type="hidden" name="orderId" value={o.id} />
          </InlineAction>
        </section>
      </div>

      {o.shipments[0] ? (
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Shipment</h2>
          <ShipmentTracking shipment={o.shipments[0]} />
          {o.state === "IN_TRANSIT" && ["FAILED", "RETURNED_TO_ORIGIN"].includes(o.shipments[0].status) ? (
            <ActionForm action={confirmDeliveryReturn} submitLabel="Confirm return, cancel and refund">
              <input type="hidden" name="orderId" value={o.id} />
              <p className="text-sm">The courier reported a delivery problem. Only confirm once the part is back with the seller: the buyer is refunded in full and the listing goes live again.</p>
              <FormInput label="Reason" name="reason" required />
              <FormSelect label="Is the part back with the seller?" name="returned" defaultValue="">
                <option value="">Not confirmed yet</option>
                <option value="yes">Yes, the seller has it back</option>
              </FormSelect>
            </ActionForm>
          ) : null}
          {devTools && o.shipments[0].awb ? (
            <ActionForm action={advanceShipment} submitLabel="Send courier event" submitVariant="secondary">
              <input type="hidden" name="orderId" value={o.id} />
              <FormSelect label="Development only: simulate a courier event" name="status" defaultValue="PICKED_UP">
                <option value="PICKED_UP">Picked up</option>
                <option value="IN_TRANSIT">In transit</option>
                <option value="OUT_FOR_DELIVERY">Out for delivery</option>
                <option value="DELIVERED">Delivered</option>
                <option value="DELIVERY_FAILED">Delivery failed</option>
                <option value="RETURNED">Returned to seller</option>
              </FormSelect>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {p?.refunds.length ? (
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <h2 className="text-xl">Refunds</h2>
          <ul className="flex flex-col text-sm">
            {p.refunds.map((r) => (
              <li key={r.id} className="border-b border-rule py-2">
                {formatPrice(r.amountPaise)} ({formatPrice(r.vendorPortionPaise)} from seller split, {formatPrice(r.merchantPortionPaise)} from RePart): {REFUND_TEXT[r.status] ?? r.status}
                {r.afterSettlement ? ", after settlement (seller recovery opened)" : r.withSplitReversal ? ", split reversed" : ""}. {r.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {o.reconciliationMismatches.length ? (
        <section className="flex flex-col gap-2 border border-caution bg-surface p-4 text-sm">
          <h2 className="text-xl">Flagged mismatches</h2>
          <ul>{o.reconciliationMismatches.map((m) => <li key={m.id}>{m.kind}{m.resolvedAt ? " (resolved)" : ""}</li>)}</ul>
        </section>
      ) : null}

      {o.state === "DISPUTED" ? (
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Resolve dispute</h2>
          {o.dispute ? <p className="text-sm">{o.dispute.reason}: {o.dispute.description}</p> : null}
          <ActionForm action={resolveOrderDispute} submitLabel="Record decision">
            <input type="hidden" name="orderId" value={o.id} />
            <FormSelect label="Decision" name="decision" defaultValue="REFUND">
              <option value="REFUND">Refund the buyer</option>
              <option value="RELEASE">Release the payout to the seller</option>
            </FormSelect>
            <RefundFields />
          </ActionForm>
        </section>
      ) : OPEN_PAID.includes(o.state) ? (
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Cancel and refund</h2>
          <ActionForm action={cancelAndRefund} submitLabel="Cancel order and refund">
            <input type="hidden" name="orderId" value={o.id} />
            <RefundFields />
          </ActionForm>
        </section>
      ) : o.state === "CANCELLED" && p?.status === "SUCCESS" ? (
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Refund captured payment</h2>
          <p className="text-sm">This order is cancelled but a payment was captured. Refund it here.</p>
          <ActionForm action={refundCancelledOrder} submitLabel="Refund">
            <input type="hidden" name="orderId" value={o.id} />
            <RefundFields />
          </ActionForm>
        </section>
      ) : null}
    </Page>
  );
}
