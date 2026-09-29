import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { listings } from "@/server/services";
import { canTransition } from "@/server/services/listing/state";
import { withdrawListing } from "../../actions";
import { StatusBadge } from "../../../seller/status";

export const metadata: Metadata = { title: "Listing status | RePart" };

const TEXT: Partial<Record<string, string>> = {
  SUBMITTED: "We've received your listing and will check it before it goes live. We'll let you know the result.",
  SCREENING: "We're checking your listing now.",
  LIVE: "Your listing is live. Buyers can find it.",
  CHANGES_REQUESTED: "Some things need changing before this listing can go live.",
  REJECTED: "This listing can't be published on RePart.",
  WITHDRAWN: "You withdrew this listing. Buyers can't see it.",
  RESERVED: "A buyer has ordered this part.",
  SOLD: "Sold.",
};

export default async function ListingStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/sell/${id}/status`);
  const { listing } = await listings.wizard(user.id, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });

  return (
    <Page title={listing.partName ?? "Your listing"} narrow>
      <StatusBadge status={listing.status} />
      <p className="prose-measure">{TEXT[listing.status]}</p>
      {listing.status === "CHANGES_REQUESTED" && listing.sellerMessage ? <p className="border border-caution bg-caution-tint p-3 text-caution">{listing.sellerMessage}</p> : null}
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
