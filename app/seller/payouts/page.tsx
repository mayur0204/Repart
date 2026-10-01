import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { PayoutFields } from "@/components/seller/payout-fields";
import { Badge, DateText, type Tone } from "@/components/ui/display";
import { requireMemberPage } from "@/server/auth/current";
import { payouts } from "@/server/services";
import { submitPayoutDetails } from "./actions";

export const metadata: Metadata = { title: "Payouts | RePart" };

const STATUS: Record<string, { label: string; tone: Tone; text: string }> = {
  NOT_STARTED: { label: "Not started", tone: "neutral", text: "Add your payout details to sell with delivery and receive payments." },
  SUBMITTED: { label: "Submitted", tone: "neutral", text: "Your details were sent to our payment partner. If this doesn't change, submit them again; nothing will be duplicated." },
  PENDING: { label: "Processing", tone: "neutral", text: "Our payment partner is checking your bank or UPI details and KYC. This can take up to a day." },
  ACTION_REQUIRED: { label: "Action required", tone: "caution", text: "Our payment partner couldn't verify your details. Contact support to update them." },
  ACTIVE: { label: "Active", tone: "fit", text: "You can receive payouts." },
  ON_HOLD: { label: "On hold", tone: "caution", text: "Our payment partner needs more documents. Contact support." },
  BLOCKED: { label: "Blocked", tone: "danger", text: "Payouts are blocked for this account. Contact support." },
  REJECTED: { label: "Blocked", tone: "danger", text: "Payouts are blocked for this account. Contact support." },
};

/** Payout onboarding and status (PLAN.md §4.4 /seller/payouts). */
export default async function PayoutsPage() {
  const user = await requireMemberPage("/seller/payouts");
  const s = await payouts.sync(user.id); // refreshes from the provider at most once a minute
  const st = STATUS[s.status] ?? STATUS.PENDING!;

  return (
    <Page title="Payouts" intro="RePart pays sellers through our payment partner, Cashfree. Your bank, UPI and PAN details go straight to them and are not stored by RePart.">
      <section className="flex max-w-2xl flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl">Payout account</h2>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <p className="text-steel">{st.text}</p>
        {s.remarks && s.status !== "ACTIVE" ? <p className="text-sm text-steel">{s.remarks}</p> : null}
        {s.payoutMethod ? <p className="text-sm text-steel">Paid to your {s.payoutMethod === "BANK" ? "bank account" : "UPI id"}. Settlement: {s.schedule}.</p> : null}
        {s.checkedAt ? <p className="text-sm text-steel">Last checked <DateText date={s.checkedAt} />.</p> : null}
        {!s.eligible ? <p className="text-sm font-semibold">Buy Now and payouts are unavailable until your vendor account is active.</p> : null}
      </section>

      {s.canSubmit ? (
        <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-xl">Your payout details</h2>
          <ActionForm action={submitPayoutDetails} submitLabel="Submit payout details">
            <PayoutFields defaults={{ name: user.name ?? "", email: user.email ?? "" }} />
          </ActionForm>
        </section>
      ) : null}
    </Page>
  );
}
