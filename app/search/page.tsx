import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { ListingTile } from "@/components/listing/listing-tile";
import { buttonClasses } from "@/components/ui/button";
import { PartNumberText } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { withNext } from "@/lib/return-to";
import { partNumberPath } from "@/lib/slug";
import { buyerContext } from "@/server/buyer-context";
import { categories, publicSearch } from "@/server/services";
import { DISTANCES, parseSearchQuery, type SearchQuery } from "@/server/services/search/search";
import { saveSearch } from "./actions";

export const metadata: Metadata = { title: "Search | RePart" };

const SORT_LABEL = { best: "Best fit", newest: "Newest", price: "Price, low to high", nearest: "Nearest" } as const;
const field = "min-h-11 w-full border border-rule bg-surface px-3";

function qs(q: SearchQuery, over: Partial<Record<keyof SearchQuery, string | number | undefined>> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...over })) if (v !== undefined && v !== "") p.set(k, String(v));
  return `/search?${p.toString()}`;
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = parseSearchQuery(await searchParams);
  const ctx = await buyerContext({ vehicle: query.vehicle, year: query.year, pin: query.pin });
  const withPin = { ...query, pin: query.pin ?? ctx.pincode ?? undefined };
  const [result, cats] = await Promise.all([publicSearch.search(withPin, ctx.vehicle), categories.list()]);
  const heading = query.pn ? `Part number ${query.pn}` : query.vehicle && result.vehicle ? `Parts for your ${result.vehicle.label}` : query.q ? `Results for "${query.q}"` : "All parts";
  const current = new URL(qs(query), "http://x").pathname + new URL(qs(query), "http://x").search;

  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:grid lg:grid-cols-12 lg:px-8">
      <aside className="flex flex-col gap-4 lg:col-span-3">
        <form method="get" action="/search" className="flex flex-col gap-3 border border-rule bg-surface p-4" aria-label="Filters">
          {(["q", "pn", "vehicle", "year"] as const).map((k) => (query[k] ? <input key={k} type="hidden" name={k} value={String(query[k])} /> : null))}
          <h2 className="text-lg">Filters</h2>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Category
            <select name="category" defaultValue={query.category ?? ""} className={field}>
              <option value="">All categories</option>
              {cats.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Condition
            <select name="condition" defaultValue={query.condition ?? ""} className={field}>
              <option value="">Any condition</option>
              <option value="LIKE_NEW">Like new</option>
              <option value="GOOD">Good</option>
              <option value="FAIR">Fair</option>
              <option value="FOR_REPAIR">For repair</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm font-semibold">Min ₹<input name="min" inputMode="numeric" defaultValue={query.min ?? ""} className={field} /></label>
            <label className="flex flex-col gap-1 text-sm font-semibold">Max ₹<input name="max" inputMode="numeric" defaultValue={query.max ?? ""} className={field} /></label>
          </div>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Your pincode
            <input name="pin" inputMode="numeric" maxLength={6} defaultValue={withPin.pin ?? ""} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Distance
            <select name="distance" defaultValue={query.distance ?? ""} className={field}>
              <option value="">Any distance</option>
              {DISTANCES.map((d) => <option key={d} value={d}>Within {d} km</option>)}
            </select>
          </label>
          {withPin.pin && !result.userPincodeKnown ? <p className="text-sm text-steel">We don&apos;t have location data for {withPin.pin} yet, so distance isn&apos;t shown.</p> : null}
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Trust label
            <select name="trust" defaultValue={query.trust ?? ""} className={field}>
              <option value="">Any</option>
              <option value="PARTNER_CHECK">Partner Check</option>
              <option value="SCREENED">Screened by RePart</option>
              <option value="SELLER_DECLARED">Seller-declared</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Delivery or pickup
            <select name="mode" defaultValue={query.mode ?? ""} className={field}>
              <option value="">Either</option>
              <option value="DELIVERY">Delivery</option>
              <option value="LOCAL_PICKUP">Local pickup</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">
            Sort by
            <select name="sort" defaultValue={query.sort ?? ""} className={field}>
              <option value="">Default</option>
              {Object.entries(SORT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button type="submit" className={buttonClasses("primary")}>Show results</button>
          <Link href={qs({ q: query.q, pn: query.pn, vehicle: query.vehicle, year: query.year })} className="text-sm text-action underline-offset-4 hover:underline">Clear filters</Link>
        </form>
      </aside>

      <section className="flex flex-col gap-4 lg:col-span-9" aria-labelledby="results-heading">
        <div className="flex flex-col gap-1">
          <h1 id="results-heading" className="text-2xl lg:text-3xl">{heading}</h1>
          <p className="num text-steel" aria-live="polite">{result.total} {result.total === 1 ? "part" : "parts"}</p>
          {result.partNumbers.length ? (
            <p className="text-sm text-steel">
              Includes equivalent and replacement numbers. See the part page for{" "}
              {result.partNumbers.map((p, i) => (
                <span key={p.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={partNumberPath(p)} className="text-action underline"><PartNumberText value={p.display} /></Link> ({p.brand}{p.isSample ? ", SAMPLE" : ""})
                </span>
              ))}
              .
            </p>
          ) : null}
        </div>

        {result.total === 0 ? (
          <EmptyState
            title={result.unknownPartNumber ? `${query.pn} isn't in our catalogue` : "No parts match yet"}
            body={
              result.unknownPartNumber
                ? "Check the number for typing mistakes, or search by your bike instead. Spaces and dashes don't matter."
                : "Try widening the distance, removing a filter or searching by part number. Or save this search and we'll tell you when a match is listed."
            }
          />
        ) : (
          <ul className="grid gap-3 lg:grid-cols-3">
            {result.tiles.map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}
          </ul>
        )}

        {result.pages > 1 ? (
          <nav aria-label="Pages" className="flex items-center gap-4">
            {result.page > 1 ? <Link href={qs(query, { page: result.page - 1 })} className={buttonClasses("secondary")}>Previous page</Link> : null}
            <span className="num text-steel">Page {result.page} of {result.pages}</span>
            {result.page < result.pages ? <Link href={qs(query, { page: result.page + 1 })} className={buttonClasses("secondary")}>Next page</Link> : null}
          </nav>
        ) : null}

        {query.q || query.pn || query.vehicle || query.category ? (
          <section className="flex max-w-xl flex-col gap-2 border border-rule bg-surface p-4">
            <h2 className="text-lg">Get told about new matches</h2>
            {ctx.user ? (
              <ActionForm action={saveSearch} submitLabel="Save this search">
                <input type="hidden" name="query" value={JSON.stringify({ ...query, page: undefined, sort: undefined })} />
                <FormInput label="Name for this search" name="label" defaultValue={heading.slice(0, 80)} />
              </ActionForm>
            ) : (
              <Link href={withNext("/sign-in", current)} className={buttonClasses("secondary")}>Sign in to save this search</Link>
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}
