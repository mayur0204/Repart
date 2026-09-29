import type { Metadata } from "next";
import { Page } from "@/components/layout/page";
import { ListingTile } from "@/components/listing/listing-tile";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { buyerContext } from "@/server/buyer-context";
import { publicSearch } from "@/server/services";

export const metadata: Metadata = { title: "Saved parts | RePart" };

export default async function SavedListingsPage() {
  const user = await requireMemberPage("/account/saved");
  const ctx = await buyerContext({});
  const tiles = await publicSearch.saved(user.id, ctx.vehicle);
  return (
    <Page title="Saved parts" intro="Parts you saved that are still for sale. Sold and withdrawn parts drop off this list.">
      {tiles.length ? (
        <ul className="grid gap-3 lg:grid-cols-4">{tiles.map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
      ) : (
        <EmptyState title="Nothing saved yet" body="Select Save on any listing to keep it here." action={<ButtonLink href="/search" variant="secondary">Search parts</ButtonLink>} />
      )}
    </Page>
  );
}
