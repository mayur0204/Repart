import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, FormSelect, FormTextarea, InlineAction } from "@/components/forms/action-form";
import { FitBar } from "@/components/listing/fit-bar";
import { INSPECTION_TEXT, TRUST_TEXT, TrustBadge } from "@/components/listing/trust";
import { VehiclePicker } from "@/components/search/vehicle-picker";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Badge, DateText, PartNumberText, Price } from "@/components/ui/display";
import { formatPrice } from "@/lib/format";
import { GRADE_TEXT, type Grade } from "@/lib/listing";
import { withNext } from "@/lib/return-to";
import { partNumberPath } from "@/lib/slug";
import { buyerContext } from "@/server/buyer-context";
import { catalogue, inspections, publicSearch } from "@/server/services";
import { REPORT_REASONS } from "@/server/services/search/public";
import { parseSearchQuery } from "@/server/services/search/search";
import { startConversation } from "../../messages/actions";
import { reportListing, toggleSaveListing } from "../actions";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const l = await publicSearch.listing((await params).id, { vehicle: null, pincode: null });
  if (!l) return { title: "Listing not found | RePart" };
  return { title: `${l.title} | RePart`, description: `${l.title}, used, ${formatPrice(l.pricePaise)} on RePart. Check it fits your bike, then pay safely: the seller is paid only after you confirm it's OK.` };
}

function Compat({ title, rows, tone }: { title: string; rows: Array<{ label: string; note?: string | null }>; tone?: "caution" | "danger" }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className={tone === "danger" ? "text-lg text-danger" : tone === "caution" ? "text-lg text-caution" : "text-lg"}>{title}</h3>
      <ul className="flex flex-col text-sm">
        {rows.map((r) => (
          <li key={r.label + (r.note ?? "")} className="border-b border-rule py-1">
            {r.label}
            {r.note ? <span className="block text-steel">{r.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function ListingPage({ params, searchParams }: Props) {
  const { id } = await params;
  const q = parseSearchQuery(await searchParams);
  const ctx = await buyerContext({ vehicle: q.vehicle, year: q.year, pin: q.pin });
  const l = await publicSearch.listing(id, { vehicle: ctx.vehicle, pincode: ctx.pincode });
  if (!l) notFound();
  const [saved, vehicles] = await Promise.all([ctx.user ? publicSearch.isSaved(ctx.user.id, id) : false, l.fit.state === "NO_VEHICLE" ? catalogue.vehicles() : null]);
  // M10: a required Partner Check needs a garage in the seller's area (A-12); the label names the garage and date.
  const [checkCovered, lastCheck] = await Promise.all([l.inspectionRequirement === "REQUIRED" ? inspections.coverageForListing(id) : true, l.trustLabel === "PARTNER_CHECK" ? inspections.partnerCheckFor(id) : null]);
  const available = l.status === "LIVE" && checkCovered;
  const isSeller = ctx.user?.id === l.seller?.id;
  const buyHref = ctx.user ? `/checkout/${id}` : withNext("/sign-in", `/checkout/${id}`);
  const here = `/listings/${id}`;
  const grade = l.conditionGrade ? GRADE_TEXT[l.conditionGrade as Grade] : null;
  const partnerCheck =
    l.inspectionRequirement === "REQUIRED" ? `Partner Check included (${formatPrice(l.checkFeePaise)}). ${INSPECTION_TEXT.REQUIRED}`
    : l.inspectionRequirement === "OPTIONAL" ? `${INSPECTION_TEXT.OPTIONAL} It costs ${formatPrice(l.checkFeePaise)}.`
    : INSPECTION_TEXT.NOT_NEEDED;

  const actions = (
    <div className="flex flex-col gap-2">
      {available && !isSeller ? (
        <ButtonLink href={buyHref} fullWidth>Buy now</ButtonLink>
      ) : (
        <Button fullWidth disabled>{isSeller ? "Your listing" : "Not available"}</Button>
      )}
      {!checkCovered && l.status === "LIVE" ? <p className="text-sm font-semibold">Partner Check not available in your area</p> : null}
      <p className="text-sm text-steel">Your payment is held until you confirm the part is OK.</p>
      {!ctx.user ? (
        <ButtonLink href={withNext("/sign-in", here)} variant="secondary" fullWidth>Sign in to message the seller</ButtonLink>
      ) : ctx.user.id !== l.seller?.id ? (
        <ActionForm action={startConversation} submitLabel="Message seller" submitVariant="secondary" fullWidthSubmit>
          <input type="hidden" name="listingId" value={id} />
        </ActionForm>
      ) : null}
      {ctx.user ? (
        <InlineAction action={toggleSaveListing} label={saved ? "Remove from saved" : "Save"} variant="secondary">
          <input type="hidden" name="listingId" value={id} />
        </InlineAction>
      ) : (
        <ButtonLink href={withNext("/sign-in", here)} variant="secondary" fullWidth>Sign in to save</ButtonLink>
      )}
    </div>
  );

  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 pb-28 lg:grid lg:grid-cols-12 lg:px-8 lg:pb-8">
      <section className="flex flex-col gap-2 lg:col-span-7" aria-label="Photos">
        {l.photos.length ? (
          <ul className="grid grid-cols-2 gap-2">
            {l.photos.map((p, i) => (
              <li key={p.url} className={i === 0 ? "col-span-2" : undefined}>
                <figure className="flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
                  <img src={p.url} alt={`${l.title}: ${p.caption}`} loading={i === 0 ? "eager" : "lazy"} fetchPriority={i === 0 ? "high" : undefined} decoding="async" className="aspect-square w-full border border-rule object-cover" />
                  <figcaption className="text-sm text-steel">{p.caption}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex aspect-square w-full items-center justify-center border border-rule bg-page text-steel">No photos yet</div>
        )}
      </section>

      <div className="flex flex-col gap-4 lg:col-span-5 lg:self-start lg:sticky lg:top-20">
        <div className="flex flex-wrap items-center gap-2">
          {l.isSample ? <Badge tone="caution" icon={false}>SAMPLE listing</Badge> : null}
          {!available ? <Badge tone="neutral">{l.status === "SOLD" ? "Sold" : "Someone has ordered this part"}</Badge> : null}
        </div>
        <h1 className="text-2xl lg:text-3xl">{l.title}</h1>
        <Price paise={l.pricePaise} size="lg" />

        <FitBar fit={l.fit}>
          {l.fit.state === "NO_VEHICLE" && vehicles ? <VehiclePicker catalogue={vehicles} action={here} submitLabel="Check fit" /> : null}
          {ctx.vehicle && !ctx.fromGarage ? <Link href={here} className="text-sm underline underline-offset-4">Clear bike</Link> : null}
        </FitBar>

        {available ? actions : null}

        <section className="flex flex-col gap-1 border border-rule bg-surface p-3">
          <TrustBadge label={l.trustLabel} />
          <p className="text-sm text-steel">
            {lastCheck ? (
              <>
                Inspected by {lastCheck.garageName} on <DateText date={lastCheck.date} />. Visual and basic check.
              </>
            ) : (
              TRUST_TEXT[l.trustLabel].sentence
            )}
          </p>
          <p className="text-sm">{partnerCheck}</p>
        </section>

        <section className="flex flex-col gap-1 border border-rule bg-surface p-3">
          <h2 className="text-lg">Delivery</h2>
          {l.fulfilmentMode === "LOCAL_PICKUP" ? (
            <p className="text-sm">Local pickup only{l.location ? `, from ${l.location}` : ""}.</p>
          ) : l.delivery ? (
            <p className="text-sm">
              Delivery to {ctx.pincode}: about <Price paise={l.delivery.amountPaise} size="sm" />, {l.delivery.etaDays} days.
              {l.distanceKm !== null ? ` Ships from ${l.location}, ${l.distanceKm} km away.` : ""}
            </p>
          ) : (
            <form method="get" action={here} className="flex items-end gap-2">
              <label className="flex flex-1 flex-col gap-1 text-sm font-semibold">
                Your pincode for a delivery estimate
                <input name="pin" inputMode="numeric" maxLength={6} defaultValue={ctx.pincode ?? ""} className="min-h-11 border border-rule bg-surface px-3" />
              </label>
              <button type="submit" className={buttonClasses("secondary")}>Estimate</button>
            </form>
          )}
        </section>

        {l.seller ? (
          <section className="flex flex-col gap-1 border border-rule bg-surface p-3">
            <h2 className="text-lg">Seller</h2>
            <p className="text-sm">
              <Link href={`/sellers/${l.seller.id}`} className="text-action underline underline-offset-4">{l.seller.displayName}</Link>
              {l.seller.isSample ? " (SAMPLE)" : ""}. Member since <DateText date={l.seller.memberSince} />. {l.seller.completedSales} completed {l.seller.completedSales === 1 ? "sale" : "sales"}.{" "}
              {l.seller.rating ? `Rated ${l.seller.rating.average} out of 5 (${l.seller.rating.count}).` : "No ratings yet."}
            </p>
          </section>
        ) : null}
      </div>

      <section className="flex flex-col gap-4 lg:col-span-7" aria-labelledby="facts">
        <h2 id="facts" className="text-xl">About this part</h2>
        {l.partNumber ? (
          <p>
            Part number{" "}
            <Link href={partNumberPath(l.partNumber)} className="text-action underline-offset-4 hover:underline"><PartNumberText value={l.partNumber.display} /></Link> ({l.partNumber.brand})
            {l.partNumber.isSample ? " SAMPLE catalogue data." : ""}
          </p>
        ) : null}
        {l.equivalents.length ? (
          <ul className="flex flex-col text-sm">
            {l.equivalents.map((e) => (
              <li key={e.id} className="border-b border-rule py-1">
                <Link href={partNumberPath(e)} className="text-action underline-offset-4 hover:underline"><PartNumberText value={e.display} /></Link> ({e.brand}): {e.label}
              </li>
            ))}
          </ul>
        ) : null}
        {l.category ? <p className="text-steel">{l.category.name}{l.category.isSafetyCritical ? ", a safety-critical part" : ""}.</p> : null}
        {grade ? (
          <div className="flex flex-col gap-1">
            <p><span className="font-semibold">Condition: {grade.label}.</span> {grade.meaning}</p>
            <ul className="flex flex-col text-sm">
              {l.checklist.map((c) => (
                <li key={c.question} className="flex justify-between gap-4 border-b border-rule py-1">
                  <span>{c.question}</span>
                  <span className="font-semibold">{c.answer === "YES" ? "Yes" : c.answer === "NO" ? "No" : "Not answered"}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {l.kmUsedApprox !== null ? <p className="num">About {l.kmUsedApprox.toLocaleString("en-IN")} km used.</p> : null}
        {l.reasonForSale ? <p>Reason for sale: {l.reasonForSale}</p> : null}
        {l.description ? <p className="prose-measure whitespace-pre-line">{l.description}</p> : null}

        <h2 className="text-xl">Which bikes it fits</h2>
        <Compat title="Recorded by part number or mechanic" rows={l.compatibility.catalogue} />
        <Compat title="The seller says it fits" rows={l.compatibility.sellerDeclared} tone="caution" />
        <Compat title="Fits with a modification" rows={l.compatibility.modification} tone="caution" />
        <Compat title="Known not to fit" rows={l.compatibility.notFit} tone="danger" />

        {ctx.user && available ? (
          <details className="border border-rule bg-surface p-3">
            <summary className="cursor-pointer font-semibold">Report this listing</summary>
            <ActionForm action={reportListing} submitLabel="Send report" submitVariant="secondary" className="mt-3">
              <input type="hidden" name="listingId" value={id} />
              <FormSelect label="What's wrong?" name="reason" defaultValue="">
                <option value="">Choose a reason</option>
                {Object.entries(REPORT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </FormSelect>
              <FormTextarea label="Details (optional)" name="details" rows={3} />
            </ActionForm>
          </details>
        ) : null}
      </section>

      {available ? (
        <div className="fixed inset-x-0 bottom-14 z-20 flex items-center justify-between gap-4 border-t border-rule bg-surface p-3 lg:hidden">
          <Price paise={l.pricePaise} size="md" />
          {isSeller ? <Button disabled>Your listing</Button> : <ButtonLink href={buyHref}>Buy now</ButtonLink>}
        </div>
      ) : null}
    </main>
  );
}
