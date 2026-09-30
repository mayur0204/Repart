import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ActionForm, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { DateText } from "@/components/ui/display";
import { DISPUTE_REASON_TEXT } from "@/lib/dispute";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { reportProblem } from "../../actions";

export const metadata: Metadata = { title: "Report a problem | RePart" };

/** Report a problem (brief §9): reason, description, then photos on the dispute page. Buyer, during the acceptance window only. */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/orders/${id}/report`);
  let o;
  try {
    o = await orders.forUser(user.id, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (o.role !== "buyer") notFound();
  if (o.state === "DISPUTED") redirect(`/orders/${id}/dispute`);
  if (o.state !== "ACCEPTANCE_WINDOW" || !o.acceptanceHoursLeft) redirect(`/orders/${id}`);

  return (
    <Page title="Report a problem" intro={o.title} narrow>
      {o.acceptanceEndsAt ? (
        <p className="text-sm">
          You can report a problem until <DateText date={o.acceptanceEndsAt} /> ({o.acceptanceHoursLeft} hours left). Your money stays held while RePart reviews it.
        </p>
      ) : null}
      <ActionForm action={reportProblem} submitLabel="Report problem">
        <input type="hidden" name="orderId" value={o.id} />
        <FormSelect label="What went wrong?" name="reason" defaultValue="">
          <option value="" disabled>Choose</option>
          {Object.entries(DISPUTE_REASON_TEXT).map(([v, t]) => (
            <option key={v} value={v}>{t}</option>
          ))}
        </FormSelect>
        <FormTextarea label="Describe the problem (at least 20 characters)" name="description" rows={5} maxLength={2000} />
        <p className="text-sm text-steel">After you report it you can add up to 5 photos. The seller is asked for their side, then RePart decides.</p>
      </ActionForm>
    </Page>
  );
}
