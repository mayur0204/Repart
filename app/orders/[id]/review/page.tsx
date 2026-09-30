import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { disputes } from "@/server/services";
import { leaveReview } from "../../actions";

export const metadata: Metadata = { title: "Leave a review | RePart" };

/** Reviews both ways (brief §5): only after COMPLETED, one per order per direction, rating 1–5, text optional. */
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/orders/${id}/review`);
  let s;
  try {
    s = await disputes.reviewState(user.id, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const whom = s.direction === "BUYER_TO_SELLER" ? "the seller" : "the buyer";
  return (
    <Page title="Leave a review" intro={s.title} narrow>
      {s.mine ? (
        <p className="border border-rule bg-surface p-4">
          You rated {whom} {s.mine.rating} out of 5.{s.mine.text ? ` "${s.mine.text}"` : ""}
        </p>
      ) : !s.completed ? (
        <p className="border border-rule bg-surface p-4">Reviews open once the order is completed.</p>
      ) : (
        <ActionForm action={leaveReview} submitLabel="Submit review">
          <input type="hidden" name="orderId" value={id} />
          <FormSelect label={`How was ${whom}?`} name="rating" defaultValue="">
            <option value="" disabled>Choose a rating</option>
            <option value="5">5, excellent</option>
            <option value="4">4, good</option>
            <option value="3">3, okay</option>
            <option value="2">2, poor</option>
            <option value="1">1, bad</option>
          </FormSelect>
          <FormTextarea label="Anything to add? (optional)" name="text" rows={4} maxLength={1000} />
        </ActionForm>
      )}
    </Page>
  );
}
