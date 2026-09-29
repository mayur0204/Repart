import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, InlineAction } from "@/components/forms/action-form";
import { WizardFrame } from "@/components/sell/wizard-frame";
import { Badge, PartNumberText, Price } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { GRADE_TEXT, LISTING_STEPS, type Grade } from "@/lib/listing";
import { addresses, photos } from "@/server/services";
import { submitListing, withdrawListing } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Review | Sell a part | RePart" };

export default async function ReviewStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, state, incomplete, reached } = await loadStep(id, "review");
  const l = state.listing;
  const [shots, saved] = await Promise.all([photos.listForOwner(user.id, id), addresses.list(user.id)]);
  const pickup = saved.find((a) => a.id === l.pickupAddressId);
  const ready = shots.filter((p) => p.status === "ready" && p.url);
  const sellerBike = state.fitments.find((f) => f.source === "SELLER_DECLARED");
  const matched = state.fitments.filter((f) => f.source === "PART_NUMBER_MATCH");
  const name = (v: (typeof state.fitments)[number]["variant"]) => `${v.model.make.name} ${v.model.name} ${v.name}`;
  const problems = LISTING_STEPS.filter((s) => s.slug !== "review" && state.steps[s.slug].length);

  return (
    <WizardFrame listingId={id} step="review" reached={reached} incomplete={incomplete}>
      {problems.length ? (
        <section role="alert" className="flex flex-col gap-2 border border-danger bg-danger-tint p-4">
          <h2 className="text-lg text-danger">Finish these before submitting</h2>
          <ul className="flex flex-col gap-2">
            {problems.map((s) => (
              <li key={s.slug} className="flex flex-col">
                <span>{state.steps[s.slug].join(" ")}</span>
                <Link href={`/sell/${id}/${s.slug}`} className="text-action underline underline-offset-4">Fix in {s.label}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-steel">This is how buyers will see your listing.</p>
      <article className="grid gap-6 border border-rule bg-surface p-4 lg:grid-cols-12">
        <div className="grid grid-cols-3 gap-2 lg:col-span-7">
          {ready.length ? (
            ready.map((p, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
              <img key={p.id} src={p.url!} alt={`${l.partName ?? "Part"}, photo ${i + 1}`} className={i === 0 ? "col-span-3 aspect-square w-full object-cover" : "aspect-square w-full object-cover"} />
            ))
          ) : (
            <p className="col-span-3 text-steel">No photos yet.</p>
          )}
        </div>
        <div className="flex flex-col gap-3 lg:col-span-5">
          <h2 className="text-2xl">{l.partName ?? "Untitled part"}</h2>
          {l.pricePaise ? <Price paise={l.pricePaise} size="lg" /> : null}
          {sellerBike ? (
            <p className="flex items-start gap-2 border border-caution bg-caution-tint p-3 text-caution">
              <Icon name="alert" className="mt-0.5 shrink-0" />
              Seller says this fits the {name(sellerBike.variant)}. Not confirmed by part number.
            </p>
          ) : null}
          {l.conditionGrade ? (
            <p>
              <span className="font-semibold">{GRADE_TEXT[l.conditionGrade as Grade].label}</span>
              <span className="block text-sm text-steel">{GRADE_TEXT[l.conditionGrade as Grade].meaning}</span>
            </p>
          ) : null}
          {state.part ? (
            <p className="flex flex-wrap items-center gap-2">
              Part number <PartNumberText value={state.part.display} /> ({state.part.brand})
              {state.part.isSample ? <Badge tone="caution">SAMPLE</Badge> : null}
            </p>
          ) : null}
          {matched.length ? <p className="text-sm text-steel">Matched by part number: {matched.map((f) => name(f.variant)).join(", ")}.</p> : null}
          <p className="text-sm text-steel">
            {l.fulfilmentMode === "DELIVERY" ? "Delivery by courier" : "Local pickup only"}
            {pickup ? `, from ${pickup.city} ${pickup.pincode}` : ""}.
          </p>
          {l.kmUsedApprox !== null ? <p className="num text-sm text-steel">About {l.kmUsedApprox.toLocaleString("en-IN")} km used.</p> : null}
          <p className="prose-measure whitespace-pre-line">{l.description}</p>
        </div>
      </article>

      <div className="flex flex-wrap items-start gap-4">
        <ActionForm action={submitListing} submitLabel={l.status === "CHANGES_REQUESTED" ? "Resubmit listing" : "Submit listing"}>
          <input type="hidden" name="listingId" value={id} />
        </ActionForm>
        <InlineAction action={withdrawListing} label="Withdraw this draft">
          <input type="hidden" name="listingId" value={id} />
        </InlineAction>
      </div>
      <p className="prose-measure text-sm text-steel">After you submit, we check the listing before it goes live. You can&apos;t edit it while it&apos;s being checked.</p>
    </WizardFrame>
  );
}
