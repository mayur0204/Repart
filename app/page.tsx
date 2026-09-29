import Link from "next/link";
import { ListingTile } from "@/components/listing/listing-tile";
import { VehiclePicker } from "@/components/search/vehicle-picker";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { buyerContext } from "@/server/buyer-context";
import { catalogue, publicSearch } from "@/server/services";

/** Home (brief §9): a working search first; parts for the primary bike; three sentences on checks; recently listed; Sell prompt. */
export default async function HomePage() {
  const ctx = await buyerContext({});
  const [vehicles, recent, forBike] = await Promise.all([
    catalogue.vehicles(),
    publicSearch.search({ sort: "newest" }, ctx.vehicle),
    ctx.fromGarage && ctx.vehicle ? publicSearch.search({ vehicle: ctx.vehicle.variantId, sort: "best" }, ctx.vehicle) : null,
  ]);

  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-10 px-4 py-8 lg:px-8">
      <section className="flex flex-col gap-6" aria-labelledby="find">
        <h1 id="find" className="text-3xl">Find a used part that fits</h1>
        <div className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">What do you ride?</h2>
          <VehiclePicker catalogue={vehicles} action="/search" submitLabel="Show parts" initial={ctx.fromGarage && ctx.vehicle ? { variantId: ctx.vehicle.variantId } : undefined} />
        </div>
        <form method="get" action="/search" role="search" className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <label htmlFor="home-pn" className="text-xl font-semibold [font-stretch:87.5%]">Search by part number</label>
          <div className="flex gap-2">
            <input id="home-pn" name="pn" placeholder="For example SAMPLE-BRK-0001" className="min-h-11 flex-1 border border-rule bg-surface px-3" />
            <button type="submit" className={buttonClasses("primary")}>Search</button>
          </div>
          <p className="text-sm text-steel">We also show equivalent and replacement numbers.</p>
        </form>
      </section>

      {forBike && ctx.vehicle ? (
        <section className="flex flex-col gap-3" aria-labelledby="for-bike">
          <h2 id="for-bike" className="text-2xl">Parts for your {ctx.vehicle.label}</h2>
          {forBike.tiles.length ? (
            <ul className="grid gap-3 lg:grid-cols-4">{forBike.tiles.slice(0, 8).map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
          ) : (
            <p className="text-steel">Nothing listed for your bike yet. Save a search to hear when something is.</p>
          )}
          {forBike.total > 8 ? <Link href={`/search?vehicle=${ctx.vehicle.variantId}`} className="text-action underline-offset-4 hover:underline">See all {forBike.total} parts for your bike</Link> : null}
        </section>
      ) : null}

      <section className="prose-measure flex flex-col gap-2" aria-labelledby="how">
        <h2 id="how" className="text-2xl">How RePart works</h2>
        <p>Every listing is checked before it goes live: the photos, the details and the part number against our catalogue of which parts fit which bikes.</p>
        <p>Safety-critical parts such as brakes and tyres are inspected by a partner mechanic before they ship, and other parts can have an optional check.</p>
        <p>You pay RePart, not the seller, and the seller is paid only after you confirm the part arrived as described. <Link href="/how-it-works" className="text-action underline">More about how it works</Link>.</p>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="recent">
        <h2 id="recent" className="text-2xl">Recently listed</h2>
        {recent.tiles.length ? (
          <ul className="grid gap-3 lg:grid-cols-4">{recent.tiles.slice(0, 8).map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
        ) : (
          <p className="text-steel">No parts listed yet.</p>
        )}
        <Link href="/search?sort=newest" className="text-action underline-offset-4 hover:underline">See all parts</Link>
      </section>

      <section className="flex flex-col items-start gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">Got a part you no longer need?</h2>
        <p className="text-steel">List it in seven short steps. We check it and handle payment and delivery.</p>
        <ButtonLink href="/sell">Sell a part</ButtonLink>
      </section>
    </main>
  );
}
