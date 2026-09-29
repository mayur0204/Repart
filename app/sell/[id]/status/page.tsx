import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { INSPECTION_REASON_TEXT, INSPECTION_TEXT, TRUST_TEXT, TrustBadge } from "@/components/listing/trust";
import { StatusPoller } from "@/components/sell/status-poller";
import { ButtonLink } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/display";
import { LISTING_STEPS } from "@/lib/listing";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { listings, risk } from "@/server/services";
import { canTransition } from "@/server/services/listing/state";
import { StatusBadge } from "../../../seller/status";
import { withdrawListing } from "../../actions";

export const metadata: Metadata = { title: "Listing status | RePart" };

const TEXT: Partial<Record<string, string>> = {
  SUBMITTED: "Checking your listing. This usually takes under a minute. You can leave this page; we'll let you know the result.",
  SCREENING: "Checking your listing. This usually takes under a minute. You can leave this page; we'll let you know the result.",
  LIVE: "Part listed. Buyers can find it now.",
  CHANGES_REQUESTED: "Some things need changing before this listing can go live. Fix each one below, then resubmit from the review step.",
  REJECTED: "This listing can't be published on RePart.",
  WITHDRAWN: "You withdrew this listing. Buyers can't see it.",
  RESERVED: "A buyer has ordered this part.",
  SOLD: "Sold.",
};

export default async function ListingStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/sell/${id}/status`);
  const [{ listing }, status] = await Promise.all([
    listings.wizard(user.id, id).catch((err) => {
      if (err instanceof NotFoundError) notFound();
      throw err;
    }),
    risk.statusForOwner(user.id, id),
  ]);
  const checking = listing.status === "SUBMITTED" || listing.status === "SCREENING";
  const stepLabel = (slug: string | null) => LISTING_STEPS.find((s) => s.slug === slug)?.label;

  return (
    <Page title={listing.partName ?? "Your listing"} narrow>
      <StatusPoller listingId={id} status={listing.status} />
      <StatusBadge status={listing.status} />
      <p className="prose-measure" aria-live="polite">{TEXT[listing.status]}</p>
      {checking ? (
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : null}

      {status.fixes.length ? (
        <ul className="flex flex-col border border-rule bg-surface">
          {status.fixes.map((f, i) => (
            <li key={`${f.code}-${i}`} className="flex flex-col gap-1 border-b border-rule p-4 last:border-b-0">
              <span>{f.message}</span>
              {f.step ? (
                <Link href={`/sell/${id}/${f.step}`} className="text-action underline underline-offset-4">
                  Fix in {stepLabel(f.step)}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : listing.status === "CHANGES_REQUESTED" && listing.sellerMessage ? (
        <p className="border border-caution bg-caution-tint p-3 text-caution">{listing.sellerMessage}</p>
      ) : null}
      {listing.status === "REJECTED" && listing.sellerMessage ? <p className="border border-danger bg-danger-tint p-3 text-danger">{listing.sellerMessage}</p> : null}

      {listing.status === "LIVE" ? (
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <TrustBadge label={listing.trustLabel} />
          <p className="text-steel">{TRUST_TEXT[listing.trustLabel].sentence}</p>
          {listing.inspectionRequirement ? (
            <p className="text-steel">
              {INSPECTION_TEXT[listing.inspectionRequirement]} {listing.inspectionReason ? INSPECTION_REASON_TEXT[listing.inspectionReason] : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        {listing.status === "DRAFT" || listing.status === "CHANGES_REQUESTED" ? <ButtonLink href={`/sell/${id}/review`}>Continue editing</ButtonLink> : null}
        {canTransition(listing.status, "withdraw") ? (
          <InlineAction action={withdrawListing} label="Withdraw listing" variant="secondary">
            <input type="hidden" name="listingId" value={id} />
          </InlineAction>
        ) : null}
        <Link href="/seller" className="text-action underline-offset-4 hover:underline">Back to your listings</Link>
      </div>
    </Page>
  );
}
