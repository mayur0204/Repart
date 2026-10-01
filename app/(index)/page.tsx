import Link from "next/link";
import { ListingTile } from "@/components/listing/listing-tile";
import { VehiclePicker } from "@/components/search/vehicle-picker";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { sampleImageFor } from "@/lib/sample-images";
import { buyerContext } from "@/server/buyer-context";
import { catalogue, categories, publicSearch } from "@/server/services";

const CHECKS: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: "check", title: "Fit checked by part number", body: "We match the part number against our catalogue of which parts fit which bikes." },
  { icon: "shield", title: "Partner Check on safety parts", body: "Brakes, tyres and other safety-critical parts are inspected by a partner mechanic before they ship." },
  { icon: "wallet", title: "Your payment is held", body: "You pay RePart, and the seller is paid only after you confirm the part arrived as described." },
];

/** Home (brief §9, Stitch "Marketplace Home"): a working search first; how checks work; categories; parts for the primary bike; recently listed; Sell prompt. */
export default async function HomePage() {
  const ctx = await buyerContext({});
  const [vehicles, recent, forBike, cats] = await Promise.all([
    catalogue.vehicles(),
    publicSearch.search({ sort: "newest" }, ctx.vehicle),
    ctx.fromGarage && ctx.vehicle ? publicSearch.search({ vehicle: ctx.vehicle.variantId, sort: "best" }, ctx.vehicle) : null,
    categories.list(),
  ]);
  const topCategories = cats.filter((c) => !c.parent).slice(0, 8);

  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-14 px-4 py-8 lg:px-8 lg:py-12">
      <section className="grid gap-8 lg:grid-cols-12 lg:items-start" aria-labelledby="find">
        <div className="flex flex-col gap-6 lg:col-span-7">
          <div className="flex flex-col gap-3">
            <h1 id="find" className="text-3xl lg:text-4xl lg:font-extrabold">Find a used part that fits</h1>
            <p className="prose-measure text-lg text-steel">Used motorcycle and scooter parts from people who ride. Checked before they ship, paid for safely.</p>
          </div>
          <div className="flex flex-col gap-5 rounded-lg border border-rule bg-surface p-5 lg:p-6">
            <div className="flex flex-col gap-3">
              <h2 className="text-xl">What do you ride?</h2>
              <VehiclePicker catalogue={vehicles} action="/search" submitLabel="Show parts" initial={ctx.fromGarage && ctx.vehicle ? { variantId: ctx.vehicle.variantId } : undefined} />
            </div>
            <form method="get" action="/search" role="search" className="flex flex-col gap-2 border-t border-rule pt-5">
              <label htmlFor="home-pn" className="font-heading text-base font-semibold">Or search by part number</label>
              <div className="flex gap-2">
                <input id="home-pn" name="pn" placeholder="For example SAMPLE-BRK-0001" className="min-h-11 flex-1 rounded-md border border-rule bg-surface px-3" />
                <button type="submit" className={buttonClasses("secondary")}>Search</button>
              </div>
              <p className="text-sm text-steel">We also show equivalent and replacement numbers.</p>
            </form>
          </div>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-5">
          <figure className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG illustration */}
            <img src="/sample/hero.svg" alt="SAMPLE illustration of a motorcycle" width={640} height={400} fetchPriority="high" className="aspect-[8/5] w-full rounded-lg border border-rule bg-brand-tint" />
            <figcaption className="absolute top-3 left-3 rounded-full bg-surface px-2.5 py-0.5 text-sm font-semibold text-ink">SAMPLE illustration</figcaption>
          </figure>
          <section className="flex flex-col gap-5 rounded-lg bg-ink p-6 text-surface" aria-labelledby="how">
            <h2 id="how" className="text-2xl">How RePart works</h2>
            <ul className="flex flex-col gap-4">
              {CHECKS.map((c) => (
                <li key={c.title} className="flex gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-ink">
                    <Icon name={c.icon} />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-base text-surface">{c.title}</h3>
                    <p className="text-sm text-rule">{c.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Link href="/how-it-works" className="text-sm font-semibold text-surface underline underline-offset-4">More about how it works</Link>
          </section>
        </div>
      </section>

      {topCategories.length ? (
        <section className="flex flex-col gap-4" aria-labelledby="cats">
          <h2 id="cats" className="text-2xl">Shop by category</h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {topCategories.map((c) => {
              const img = sampleImageFor(c.name);
              return (
                <li key={c.id}>
                  <Link href={`/search?category=${c.slug}`} className="flex min-h-16 items-center justify-between gap-2 rounded-lg border border-rule bg-surface px-4 py-3 font-heading font-semibold transition-colors duration-150 hover:border-ink">
                    <span className="flex items-center gap-3">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element -- static SVG illustration
                        <img src={img} alt="" width={48} height={48} loading="lazy" className="size-12 shrink-0 rounded-md" />
                      ) : null}
                      {c.name}
                    </span>
                    <Icon name="chevron" size="sm" className="shrink-0 text-steel" />
                  </Link>
                </li>
                );
            })}
          </ul>
        </section>
      ) : null}

      {forBike && ctx.vehicle ? (
        <section className="flex flex-col gap-4" aria-labelledby="for-bike">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 id="for-bike" className="text-2xl">Parts for your {ctx.vehicle.label}</h2>
            {forBike.total > 8 ? <Link href={`/search?vehicle=${ctx.vehicle.variantId}`} className="font-semibold text-action underline-offset-4 hover:underline">See all {forBike.total} parts for your bike</Link> : null}
          </div>
          {forBike.tiles.length ? (
            <ul className="grid gap-3 lg:grid-cols-4 lg:gap-5">{forBike.tiles.slice(0, 8).map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
          ) : (
            <p className="text-steel">Nothing listed for your bike yet. Save a search to hear when something is.</p>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-4" aria-labelledby="recent">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="recent" className="text-2xl">Recently listed</h2>
          <Link href="/search?sort=newest" className="font-semibold text-action underline-offset-4 hover:underline">See all parts</Link>
        </div>
        {recent.tiles.length ? (
          <ul className="grid gap-3 lg:grid-cols-4 lg:gap-5">{recent.tiles.slice(0, 8).map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
        ) : (
          <p className="text-steel">No parts listed yet.</p>
        )}
      </section>

      <section className="flex flex-col items-start gap-4 rounded-lg bg-ink p-6 text-surface lg:flex-row lg:items-center lg:justify-between lg:p-10">
        <div className="flex items-center gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- static decorative SVG */}
          <img src="/sample/parcel.svg" alt="" width={96} height={96} loading="lazy" className="hidden size-24 shrink-0 lg:block" />
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl text-surface lg:text-3xl">Got a part you no longer need?</h2>
            <p className="prose-measure text-rule">List it in seven short steps. We check it and handle payment and delivery.</p>
          </div>
        </div>
        <ButtonLink href="/sell" className="shrink-0">
          <Icon name="plus" size="sm" />
          Sell a part
        </ButtonLink>
      </section>
    </main>
  );
}
