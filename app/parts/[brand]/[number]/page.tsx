import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, FormInput, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, PartNumberText } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/ui/states";
import { ListingTile } from "@/components/listing/listing-tile";
import { withNext } from "@/lib/return-to";
import { partNumberPath } from "@/lib/slug";
import { buyerContext } from "@/server/buyer-context";
import { interchange, publicSearch } from "@/server/services";
import { matchLabel } from "@/server/services/interchange/graph";
import { suggestEquivalent } from "../../actions";

type Params = { params: Promise<{ brand: string; number: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { number } = await params;
  return { title: `${decodeURIComponent(number)} | RePart` };
}

type VehicleRow = { variant: { id: string; name: string; yearFrom: number; yearTo: number | null; model: { name: string; make: { name: string } } }; via: { display: string }; source: string; viaModification: string | null };
const vehicleName = (v: VehicleRow["variant"]) => `${v.model.make.name} ${v.model.name} ${v.name} (${v.yearFrom} to ${v.yearTo ?? "now"})`;

function VehicleList({ rows, extra }: { rows: VehicleRow[]; extra?: (r: VehicleRow) => React.ReactNode }) {
  const unique = [...new Map(rows.map((r) => [r.variant.id + r.via.display, r])).values()].sort((a, b) => vehicleName(a.variant).localeCompare(vehicleName(b.variant)));
  return (
    <ul className="flex flex-col border border-rule bg-surface">
      {unique.map((r) => (
        <li key={r.variant.id + r.via.display} className="flex flex-col gap-0.5 border-b border-rule p-3 last:border-b-0">
          <span className="font-semibold">{vehicleName(r.variant)}</span>
          <span className="text-sm text-steel">
            Via <PartNumberText value={r.via.display} />
            {extra ? <> {extra(r)}</> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function PartNumberPage({ params }: Params) {
  const { brand, number } = await params;
  const data = await interchange.partNumberPage(brand, decodeURIComponent(number));
  if (!data) notFound();
  const ctx = await buyerContext({});
  const user = ctx.user;
  const { part } = data;
  const listings = await publicSearch.search({ pn: part.display, sort: "best" }, ctx.vehicle);
  const here = partNumberPath(part);

  return (
    <Page
      title={`${part.brand} ${part.display}`}
      intro={
        <>
          {part.category.name}. {part.isOem ? "Original manufacturer number." : "Aftermarket number."}
          {part.category.isSafetyCritical ? " Safety-critical part: only equivalents from a manufacturer catalogue or confirmed by a mechanic are shown." : ""}
        </>
      }
    >
      <p className="part-no text-2xl">{part.display}</p>

      {!data.isCurrent && data.current.length ? (
        <p className="flex items-start gap-2 border border-caution bg-caution-tint p-3 text-caution">
          <Icon name="alert" className="mt-0.5 shrink-0" />
          <span>
            This number has been replaced by{" "}
            {data.current.map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ", " : ""}
                <Link href={partNumberPath(c)} className="underline underline-offset-4"><PartNumberText value={c.display} /></Link> ({c.brand})
              </span>
            ))}
            .
          </span>
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col gap-3 lg:col-span-7" aria-labelledby="eq-heading">
          <h2 id="eq-heading" className="text-xl">Equivalent part numbers</h2>
          {data.equivalents.length === 0 && data.modifications.length === 0 ? (
            <EmptyState title="No known equivalents" body="If you know a number that is the same part, suggest it below." />
          ) : (
            <ul className="flex flex-col border border-rule bg-surface">
              {data.equivalents.map((m) => (
                <li key={m.partNumberId} className="flex flex-col gap-1 border-b border-rule p-3 last:border-b-0">
                  <Link href={partNumberPath(m.part)} className="text-action underline-offset-4 hover:underline">
                    <PartNumberText value={m.part.display} /> <span className="text-ink">{m.part.brand}</span>
                  </Link>
                  <span className="text-sm text-steel">{matchLabel(m)}</span>
                </li>
              ))}
              {data.modifications.map((m) => (
                <li key={m.partNumberId} className="flex flex-col gap-1 border-b border-rule p-3 last:border-b-0">
                  <Link href={partNumberPath(m.part)} className="text-action underline-offset-4 hover:underline">
                    <PartNumberText value={m.part.display} /> <span className="text-ink">{m.part.brand}</span>
                  </Link>
                  <Badge tone="caution">Fits with modification</Badge>
                  <span className="text-sm">{m.notes}</span>
                </li>
              ))}
            </ul>
          )}

          <h2 className="text-xl">Listings</h2>
          {listings.tiles.length ? (
            <ul className="grid gap-3 lg:grid-cols-2">{listings.tiles.map((t) => <li key={t.id}><ListingTile tile={t} /></li>)}</ul>
          ) : (
            <EmptyState title="No listings for this part right now" body="Save a search for this number to hear when one is listed." action={<Link href={`/search?pn=${encodeURIComponent(part.display)}`} className="text-action underline">Search for it</Link>} />
          )}
        </section>

        <section className="flex flex-col gap-3 lg:col-span-5" aria-labelledby="veh-heading">
          <h2 id="veh-heading" className="text-xl">Compatible vehicles</h2>
          {data.fits.length === 0 && data.fitsWithModification.length === 0 ? (
            <p className="text-steel">No vehicles are recorded for this part number or its equivalents yet.</p>
          ) : null}
          {data.fits.length ? <VehicleList rows={data.fits} /> : null}
          {data.fitsWithModification.length ? (
            <>
              <h3 className="text-lg">Fits with modification</h3>
              <VehicleList rows={data.fitsWithModification} extra={(r) => <>. {r.viaModification}</>} />
            </>
          ) : null}
          {data.doesNotFit.length ? (
            <>
              <h3 className="text-lg">Known not to fit</h3>
              <VehicleList rows={data.doesNotFit} />
            </>
          ) : null}
        </section>
      </div>

      <section className="flex max-w-2xl flex-col gap-3 border border-rule bg-surface p-4" aria-labelledby="suggest-heading">
        <h2 id="suggest-heading" className="text-xl">Suggest an equivalent part number</h2>
        <p className="text-steel">Our team checks every suggestion before it affects fit results.</p>
        {user ? (
          <ActionForm action={suggestEquivalent} submitLabel="Send suggestion">
            <input type="hidden" name="fromPartNumberId" value={part.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput label="Brand" name="brand" />
              <FormInput label="Part number" name="number" />
            </div>
            <FormSelect label="How they relate" name="type" defaultValue="">
              <option value="">Choose</option>
              <option value="EXACT_EQUIVALENT">Same part, different number</option>
              <option value="SUPERSEDED_BY">{part.display} is replaced by this number</option>
              <option value="FITS_WITH_MODIFICATION">Fits with a modification</option>
            </FormSelect>
            <FormTextarea label="Notes" name="notes" rows={3} help="Needed for a modification: say exactly what has to change." />
          </ActionForm>
        ) : (
          <ButtonLink href={withNext("/sign-in", here)} variant="secondary">Sign in to suggest</ButtonLink>
        )}
      </section>
    </Page>
  );
}
