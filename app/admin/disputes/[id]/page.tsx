import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, FormInput, FormSelect, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { Checkbox } from "@/components/ui/field";
import { PermissionDenied } from "@/components/ui/states";
import { DISPUTE_REASON_TEXT, DISPUTE_STATUS_TEXT } from "@/lib/dispute";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT, REFUND_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { disputes } from "@/server/services";
import { bookDisputeReturn, resolveOrderDispute } from "../../orders/actions";

export const metadata: Metadata = { title: "Dispute | Admin | RePart" };

/** Evidence view and resolution actions (PLAN.md §4.8). Resolution is always an explicit admin decision with a reason (D-6). */
export default async function AdminDisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/disputes/${id}`))) return <PermissionDenied />;
  let d;
  try {
    d = await disputes.adminGet(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const o = d.order;
  const local = o.fulfilmentMode === "LOCAL_PICKUP";
  return (
    <Page title={o.listing.title ?? o.listing.partName ?? "Dispute"} intro={`Order ${o.id}`} actions={<Badge tone={d.open ? "caution" : "neutral"}>{DISPUTE_STATUS_TEXT[d.status] ?? d.status}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <h2 className="text-xl">The problem</h2>
          <p className="font-semibold">{DISPUTE_REASON_TEXT[d.reason] ?? d.reason}</p>
          <p>{d.description}</p>
          <p className="text-sm text-steel">
            Buyer {o.buyer.name ?? "unnamed"}, reported <DateText date={d.createdAt} />
          </p>
          <h3 className="text-lg">Seller&apos;s response</h3>
          {d.sellerResponse ? <p>{d.sellerResponse}</p> : <p className="text-sm text-steel">No response yet. Due <DateText date={d.sellerDeadline} />.</p>}
          <p className="text-sm text-steel">Seller {o.seller.name ?? "unnamed"}</p>
        </section>
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4 text-sm">
          <h2 className="text-xl">Order and money</h2>
          <p>
            {ORDER_STATE_TEXT[o.state] ?? o.state}. <Link href={`/admin/orders/${o.id}`} className="text-action underline underline-offset-4">Order details</Link>
          </p>
          <p>
            Item {formatPrice(o.itemPricePaise)}, delivery {formatPrice(o.shippingFeePaise)}, Partner Check {formatPrice(o.checkFeePaise)}. Buyer paid {formatPrice(o.totalPaise)}.
          </p>
          {o.payment ? <p>Seller payout: {SETTLEMENT_TEXT[o.payment.vendorSettlementStatus] ?? o.payment.vendorSettlementStatus}.</p> : null}
          <p className={d.open ? "font-semibold" : ""}>
            Payment provider releases the seller&apos;s money automatically on {o.autoReleaseAt ? <DateText date={o.autoReleaseAt} /> : "(no hold date)"}.
          </p>
          {o.payment?.refunds.map((r, i) => (
            <p key={i}>
              Refund {formatPrice(r.amountPaise)}: {REFUND_TEXT[r.status] ?? r.status}
            </p>
          ))}
          {d.returnShipment ? <p>Return pickup: {d.returnShipment.status.toLowerCase().replace(/_/g, " ")}{d.returnShipment.awb ? ` (tracking ${d.returnShipment.awb})` : ""}</p> : null}
        </section>
      </div>

      <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">Photos</h2>
        {d.evidence.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {d.evidence.map((e) => (
              <li key={e.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
                <img src={e.url} alt={`${e.party.toLowerCase()} evidence`} className="aspect-square w-full border border-rule object-cover" />
                <span className="text-sm text-steel">{e.party === "BUYER" ? "Buyer" : e.party === "SELLER" ? "Seller" : "Admin"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-steel">No photos.</p>
        )}
      </section>

      {d.open && o.state === "DISPUTED" ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Decide</h2>
          <ActionForm action={resolveOrderDispute} submitLabel="Record decision">
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="disputeId" value={d.id} />
            <FormSelect label="Decision" name="decision" defaultValue="REFUND">
              <option value="REFUND">Refund the buyer</option>
              <option value="RELEASE">Release the payout to the seller</option>
            </FormSelect>
            <FormInput label="Reason (required, shown to both sides)" name="reason" required />
            <p className="text-sm text-steel">Refund amounts in paise. Leave blank to refund everything still refundable in that part.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormInput label="Item" name="item" inputMode="numeric" />
              <FormInput label="Delivery" name="shipping" inputMode="numeric" />
              <FormInput label="Partner Check" name="check" inputMode="numeric" />
            </div>
            {local ? (
              <Checkbox name="returnInPerson" label="The buyer hands the part back to the seller in person" description="Local pickup: no courier return is booked." />
            ) : (
              <p className="text-sm text-steel">{d.reason === "NOT_RECEIVED" ? "No return is booked for a part that never arrived." : "On a refund, a courier return to the seller is booked automatically (paid by RePart)."}</p>
            )}
          </ActionForm>
        </section>
      ) : null}
      {o.state === "RESOLVED_REFUND" && !d.returnShipment && !local && d.reason !== "NOT_RECEIVED" ? (
        <InlineAction action={bookDisputeReturn} label="Book the return pickup" variant="secondary">
          <input type="hidden" name="orderId" value={o.id} />
          <input type="hidden" name="disputeId" value={d.id} />
        </InlineAction>
      ) : null}

      <section className="flex flex-col gap-2 border border-rule bg-surface p-4 text-sm">
        <h2 className="text-xl">History</h2>
        <ul className="flex flex-col">
          {d.audit.map((a, i) => (
            <li key={i} className="flex justify-between gap-4 border-b border-rule py-1">
              <span>{a.action.replace(/[._]/g, " ")}</span>
              <span className="text-steel">
                {a.actorType.toLowerCase().replace("_", " ")}, <DateText date={a.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
