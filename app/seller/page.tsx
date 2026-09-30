import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { DateText, Price } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { listings } from "@/server/services";
import type { ListingStatus } from "@/server/services/listing/listing";
import { STATUS_LABEL, StatusBadge } from "./status";

export const metadata: Metadata = { title: "Your listings | RePart" };

const ORDER: ListingStatus[] = ["CHANGES_REQUESTED", "DRAFT", "SUBMITTED", "SCREENING", "LIVE", "RESERVED", "SOLD", "WITHDRAWN", "REJECTED"];

export default async function SellerDashboard() {
  const user = await requireMemberPage("/seller");
  const groups = await listings.sellerListings(user.id);
  const statuses = ORDER.filter((s) => groups.get(s)?.length);

  return (
    <Page
      title="Your listings"
      actions={
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/seller/orders" variant="secondary">Orders</ButtonLink>
          <ButtonLink href="/seller/payouts" variant="secondary">Payouts</ButtonLink>
          <ButtonLink href="/sell">Sell a part</ButtonLink>
        </div>
      }
    >
      {statuses.length === 0 ? (
        <EmptyState title="No listings yet" body="List a part in seven short steps. Your draft is saved as you go." action={<ButtonLink href="/sell">Sell a part</ButtonLink>} />
      ) : (
        statuses.map((status) => (
          <section key={status} className="flex flex-col gap-2" aria-labelledby={`h-${status}`}>
            <h2 id={`h-${status}`} className="text-xl">
              {STATUS_LABEL[status].label} <span className="num text-steel">({groups.get(status)!.length})</span>
            </h2>
            <ul className="flex flex-col border border-rule bg-surface">
              {groups.get(status)!.map((l) => (
                <li key={l.id} className="border-b border-rule last:border-b-0">
                  <Link href={status === "DRAFT" ? `/sell/${l.id}/review` : `/sell/${l.id}/status`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 p-4 hover:bg-page">
                    <span className="flex flex-col">
                      <span className="font-semibold text-action">{l.title ?? "Untitled draft"}</span>
                      <span className="text-sm text-steel">
                        {l._count.photos} photos. Updated <DateText date={l.updatedAt} />.
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {l.pricePaise ? <Price paise={l.pricePaise} size="sm" /> : null}
                      <StatusBadge status={l.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Page>
  );
}
