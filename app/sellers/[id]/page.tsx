import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Page } from "@/components/layout/page";
import { ListingTile } from "@/components/listing/listing-tile";
import { Badge, DateText } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { publicSearch } from "@/server/services";

export const metadata: Metadata = { title: "Seller | RePart" };

/** Seller public profile (PLAN.md §4.1): first name, member since, completed sales, rating, live listings. No contact details. */
export default async function SellerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await publicSearch.seller((await params).id);
  if (!profile) notFound();
  const { seller, tiles } = profile;
  return (
    <Page
      title={seller.displayName}
      intro={
        <>
          Member since <DateText date={seller.memberSince} />. {seller.completedSales} completed {seller.completedSales === 1 ? "sale" : "sales"}.{" "}
          {seller.rating ? `Rated ${seller.rating.average} out of 5 from ${seller.rating.count} ${seller.rating.count === 1 ? "review" : "reviews"}.` : "No ratings yet."}
        </>
      }
    >
      {seller.isSample ? <Badge tone="caution" icon={false}>SAMPLE seller</Badge> : null}
      <h2 className="text-xl">Parts for sale</h2>
      {tiles.length ? (
        <ul className="grid gap-3 lg:grid-cols-4">{tiles.map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
      ) : (
        <EmptyState title="Nothing for sale right now" body="This seller has no live listings. Search for the part you need instead." />
      )}
    </Page>
  );
}
