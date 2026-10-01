import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { EvidenceUpload } from "@/components/order/evidence-upload";
import { Badge, DateText } from "@/components/ui/display";
import { DISPUTE_REASON_TEXT, DISPUTE_STATUS_TEXT } from "@/lib/dispute";
import { formatPrice } from "@/lib/format";
import { REFUND_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { disputes } from "@/server/services";
import { confirmDisputePhoto, requestDisputePhoto, respondToDispute } from "../../actions";

export const metadata: Metadata = { title: "Dispute | RePart" };

/** Dispute status and next steps (PLAN.md §4.5) for the buyer and the seller of the order. */
export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/orders/${id}/dispute`);
  let d;
  try {
    d = await disputes.forUser(user.id, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const mine = d.evidence.filter((e) => e.party === (d.role === "buyer" ? "BUYER" : "SELLER")).length;
  const next =
    d.status === "RESOLVED_REFUND" ? "RePart decided on a refund. It goes back to the original payment method." + (d.returnShipment ? " A courier will collect the part for return to the seller." : "")
    : d.status === "RESOLVED_RELEASE" ? "RePart decided the sale stands. The seller's payout is being released."
    : d.sellerRespondedAt ? "Both sides are in. RePart is reviewing and will decide."
    : d.role === "seller" ? "Give your side and any photos before the deadline. RePart then decides."
    : "The seller has been asked for their side. RePart then decides. Your money stays held.";

  return (
    <Page title="Dispute" intro={d.title} actions={<Badge tone={d.open ? "caution" : "neutral"}>{DISPUTE_STATUS_TEXT[d.status] ?? d.status}</Badge>}>
      <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">What happens next</h2>
        <p>{next}</p>
        {d.open && !d.sellerRespondedAt ? (
          <p className="text-sm text-steel">
            Seller response due <DateText date={d.sellerDeadline} />.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">The problem</h2>
        <p className="font-semibold">{DISPUTE_REASON_TEXT[d.reason] ?? d.reason}</p>
        <p>{d.description}</p>
        <p className="text-sm text-steel">
          Reported <DateText date={d.createdAt} />
        </p>
      </section>

      {d.sellerResponse ? (
        <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-xl">Seller&apos;s response</h2>
          <p>{d.sellerResponse}</p>
        </section>
      ) : d.role === "seller" && d.sellerCanRespond ? (
        <section className="flex flex-col gap-3 rounded-lg border border-caution bg-surface p-4">
          <h2 className="text-xl">Your response</h2>
          <ActionForm action={respondToDispute} submitLabel="Send response">
            <input type="hidden" name="orderId" value={d.orderId} />
            <FormTextarea label="Your side of what happened" name="response" rows={5} maxLength={2000} />
          </ActionForm>
        </section>
      ) : null}

      <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">Photos</h2>
        {d.evidence.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {d.evidence.map((e) => (
              <li key={e.id} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
                <img loading="lazy" decoding="async" src={e.url} alt={`${e.party === "BUYER" ? "Buyer" : "Seller"} photo`} className="aspect-square w-full rounded-lg border border-rule object-cover" />
                <span className="text-sm text-steel">{e.party === "BUYER" ? "Buyer" : "Seller"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-steel">No photos yet.</p>
        )}
        {d.canAddEvidence ? <EvidenceUpload disputeId={d.id} remaining={5 - mine} actions={{ request: requestDisputePhoto, confirm: confirmDisputePhoto }} /> : null}
      </section>

      {!d.open ? (
        <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-xl">Decision</h2>
          {d.resolutionNote ? <p>{d.resolutionNote}</p> : null}
          {d.resolvedAt ? (
            <p className="text-sm text-steel">
              Decided <DateText date={d.resolvedAt} />
            </p>
          ) : null}
          {d.order.payment?.refunds.map((r, i) => (
            <p key={i} className="text-sm">
              Refund {formatPrice(r.amountPaise)}: {REFUND_TEXT[r.status] ?? r.status}
            </p>
          ))}
          {d.returnShipment ? <p className="text-sm">Return pickup: {d.returnShipment.status.toLowerCase().replace(/_/g, " ")}{d.returnShipment.awb ? ` (tracking ${d.returnShipment.awb})` : ""}</p> : null}
        </section>
      ) : null}
    </Page>
  );
}
