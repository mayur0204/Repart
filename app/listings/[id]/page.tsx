import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ActionForm, FormSelect, FormTextarea, InlineAction } from "@/components/forms/action-form";
import { FitBar } from "@/components/listing/fit-bar";
import { INSPECTION_TEXT, TRUST_TEXT, TrustBadge } from "@/components/listing/trust";
import { VehiclePicker } from "@/components/search/vehicle-picker";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { Badge, DateText, PartNumberText, Price } from "@/components/ui/display";
import { Icon, type IconName } from "@/components/ui/icon";
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

const card = "flex flex-col gap-4 rounded-lg border border-rule bg-surface p-5 lg:p-6";

function Compat({ title, rows, tone }: { title: string; rows: Array<{ label: string; note?: string | null }>; tone?: "caution" | "danger" }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className={tone === "danger" ? "text-lg text-danger" : tone === "caution" ? "text-lg text-caution" : "text-lg"}>{title}</h3>
      <ul className="flex flex-col text-sm">
        {rows.map((r) => (
          <li key={r.label + (r.note ?? "")} className="border-b border-rule py-2 last:border-b-0">
            {r.label}
            {r.note ? <span className="block text-steel">{r.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A side-panel block with a leading icon (Stitch listing detail right rail). */
function InfoBlock({ icon, title, children }: { icon: IconName; title: ReactNode; children: ReactNode }) {
  return (
    <section className="flex gap-3 rounded-lg border border-rule bg-surface p-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-page text-action"><Icon name={icon} /></span>
      <div className="flex flex-1 flex-col gap-1">
        {typeof title === "string" ? <h2 className="text-base">{title}</h2> : title}
        {children}
      </div>
    </section>
  );
}

/** Listing detail (Stitch "Listing Detail Page"): gallery left, sticky buy panel right; fit bar directly under title and price (brief §10). */
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
        <ButtonLink href={buyHref} fullWidth className="min-h-12 text-lg">Buy now</ButtonLink>
      ) : (
        <Button fullWidth disabled>{isSeller ? "Your listing" : "Not available"}</Button>
      )}
      {!checkCovered && l.status === "LIVE" ? <p className="text-sm font-semibold">Partner Check not available in your area</p> : null}
      <div className="grid gap-2 sm:grid-cols-2 [&_button]:w-full">
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
      <p className="flex items-start gap-2 text-sm text-steel">
        <Icon name="lock" size="sm" className="mt-0.5 shrink-0" />
        Your payment is held until you confirm the part is OK.
      </p>
    </div>
  );

  return (
    <main className="mx-auto flex max-w-(--container-page) flex-col gap-4 px-4 py-6 pb-28 lg:px-8 lg:pb-8">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-steel">
          <li><Link href="/" className="hover:text-ink hover:underline underline-offset-4">Home</Link></li>
          {l.category ? (
            <li className="flex items-center gap-1">
              <Icon name="chevron" size="sm" />
              <Link href={`/search?category=${l.category.slug}`} className="hover:text-ink hover:underline underline-offset-4">{l.category.name}</Link>
            </li>
          ) : null}
          <li className="flex min-w-0 items-center gap-1">
            <Icon name="chevron" size="sm" />
            <span aria-current="page" className="truncate text-ink">{l.title}</span>
          </li>
        </ol>
      </nav>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-12 lg:gap-8">
        <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-3 lg:col-span-7 lg:col-start-1" aria-label="Photos">
          {l.photos.length ? (
            <>
              <div role="region" aria-label="Photo gallery, scroll sideways for more" tabIndex={0} className="flex snap-x snap-mandatory overflow-x-auto rounded-md">
                {l.photos.map((p, i) => (
                  <figure key={p.url} id={`photo-${i + 1}`} className="relative w-full shrink-0 snap-start scroll-mt-24">
                    {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
                    <img src={p.url} alt={`${l.title}: ${p.caption}`} loading={i === 0 ? "eager" : "lazy"} fetchPriority={i === 0 ? "high" : undefined} decoding="async" className="aspect-square w-full rounded-md bg-page object-cover" />
                    <figcaption className="absolute bottom-3 left-3 rounded-full bg-ink px-3 py-1 text-sm text-surface">
                      {p.caption} <span className="num">({i + 1} of {l.photos.length})</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
              {l.photos.length > 1 ? (
                <ul className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  {l.photos.map((p, i) => (
                    <li key={p.url}>
                      <a href={`#photo-${i + 1}`} aria-label={`Show photo ${i + 1}: ${p.caption}`} className="block overflow-hidden rounded-md border border-rule hover:border-ink">
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
                        <img src={p.url} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-md bg-page text-steel">No photos yet</div>
          )}
        </section>

        <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:self-start">
          <section className="flex flex-col gap-4 rounded-lg border border-rule bg-surface p-5 lg:p-6" aria-label="Price and fit">
            <div className="flex flex-wrap items-center gap-2">
              {l.isSample ? <Badge tone="caution" icon={false}>SAMPLE listing</Badge> : null}
              {grade ? <Badge icon={false}>{grade.label}</Badge> : null}
              {!available ? <Badge tone="neutral">{l.status === "SOLD" ? "Sold" : "Someone has ordered this part"}</Badge> : null}
            </div>
            <div className="flex flex-col gap-2">
              <h1 className="text-2xl lg:text-3xl">{l.title}</h1>
              <Price paise={l.pricePaise} size="lg" />
            </div>

            <FitBar fit={l.fit}>
              {l.fit.state === "NO_VEHICLE" && vehicles ? <VehiclePicker catalogue={vehicles} action={here} submitLabel="Check fit" /> : null}
              {ctx.vehicle && !ctx.fromGarage ? <Link href={here} className="text-sm underline underline-offset-4">Clear bike</Link> : null}
            </FitBar>

            {available ? actions : null}
          </section>

          <InfoBlock icon="shield" title={<span className="self-start"><TrustBadge label={l.trustLabel} /></span>}>
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
          </InfoBlock>

          <InfoBlock icon={l.fulfilmentMode === "LOCAL_PICKUP" ? "location" : "truck"} title="Delivery">
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
                  <input name="pin" inputMode="numeric" maxLength={6} defaultValue={ctx.pincode ?? ""} className="min-h-11 rounded-md border border-rule bg-surface px-3 font-normal" />
                </label>
                <button type="submit" className={buttonClasses("secondary")}>Estimate</button>
              </form>
            )}
          </InfoBlock>

          {l.seller ? (
            <InfoBlock icon="store" title="Seller">
              <p className="text-sm">
                <Link href={`/sellers/${l.seller.id}`} className="font-semibold text-action underline underline-offset-4">{l.seller.displayName}</Link>
                {l.seller.isSample ? " (SAMPLE)" : ""}. Member since <DateText date={l.seller.memberSince} />. {l.seller.completedSales} completed {l.seller.completedSales === 1 ? "sale" : "sales"}.{" "}
                {l.seller.rating ? `Rated ${l.seller.rating.average} out of 5 (${l.seller.rating.count}).` : "No ratings yet."}
              </p>
            </InfoBlock>
          ) : null}
        </div>

        <div className="flex flex-col gap-6 lg:col-span-7 lg:col-start-1">
          <section className={card} aria-labelledby="facts">
            <h2 id="facts" className="text-xl">About this part</h2>
            {l.partNumber || l.equivalents.length ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-steel">Part number and equivalents</h3>
                <ul className="flex flex-wrap gap-2">
                  {l.partNumber ? (
                    <li>
                      <Link href={partNumberPath(l.partNumber)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-ink bg-surface px-3 hover:bg-page">
                        <PartNumberText value={l.partNumber.display} />
                        <span className="text-sm text-steel">{l.partNumber.brand}{l.partNumber.isSample ? ", SAMPLE" : ""}</span>
                      </Link>
                    </li>
                  ) : null}
                  {l.equivalents.map((e) => (
                    <li key={e.id}>
                      <Link href={partNumberPath(e)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-rule bg-page px-3 hover:border-ink">
                        <PartNumberText value={e.display} />
                        <span className="text-sm text-steel">{e.brand}: {e.label}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {l.partNumber?.isSample ? <p className="text-sm text-steel">SAMPLE catalogue data.</p> : null}
              </div>
            ) : null}
            {l.category ? <p className="text-steel">{l.category.name}{l.category.isSafetyCritical ? ", a safety-critical part" : ""}.</p> : null}
            {l.kmUsedApprox !== null ? <p className="num">About {l.kmUsedApprox.toLocaleString("en-IN")} km used.</p> : null}
            {l.reasonForSale ? <p>Reason for sale: {l.reasonForSale}</p> : null}
            {l.description ? <p className="prose-measure whitespace-pre-line rounded-md bg-page p-4">{l.description}</p> : null}
          </section>

          {grade ? (
            <section className={card} aria-labelledby="condition">
              <div className="flex flex-col gap-1">
                <h2 id="condition" className="text-xl">Condition: {grade.label}</h2>
                <p className="text-steel">{grade.meaning}</p>
              </div>
              {l.checklist.length ? (
                <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
                  {l.checklist.map((c) => (
                    <li key={c.question} className="flex justify-between gap-4 border-b border-rule py-2">
                      <span>{c.question}</span>
                      <span className="font-semibold">{c.answer === "YES" ? "Yes" : c.answer === "NO" ? "No" : "Not answered"}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section className={card} aria-labelledby="fits">
            <h2 id="fits" className="text-xl">Which bikes it fits</h2>
            <Compat title="Recorded by part number or mechanic" rows={l.compatibility.catalogue} />
            <Compat title="The seller says it fits" rows={l.compatibility.sellerDeclared} tone="caution" />
            <Compat title="Fits with a modification" rows={l.compatibility.modification} tone="caution" />
            <Compat title="Known not to fit" rows={l.compatibility.notFit} tone="danger" />
          </section>

          {ctx.user && available ? (
            <details className="rounded-lg border border-rule bg-surface p-4">
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
        </div>
      </div>

      {available ? (
        <div className="fixed inset-x-0 bottom-14 z-20 flex items-center justify-between gap-4 border-t border-rule bg-surface p-3 lg:hidden">
          <Price paise={l.pricePaise} size="md" />
          {isSeller ? <Button disabled>Your listing</Button> : <ButtonLink href={buyHref}>Buy now</ButtonLink>}
        </div>
      ) : null}
    </main>
  );
}
