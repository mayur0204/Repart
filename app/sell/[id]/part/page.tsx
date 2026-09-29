import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { SaveDraftButton, WizardFrame } from "@/components/sell/wizard-frame";
import { buttonClasses } from "@/components/ui/button";
import { Badge, PartNumberText } from "@/components/ui/display";
import { Checkbox } from "@/components/ui/field";
import { listings } from "@/server/services";
import { savePart } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Part | Sell a part | RePart" };

export default async function PartStep({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ pn?: string; pick?: string }> }) {
  const { id } = await params;
  const { pn, pick } = await searchParams;
  const { state, incomplete, reached } = await loadStep(id, "part");
  const query = pn ?? state.part?.display ?? "";
  const candidates = query ? await listings.findPartNumbers(query) : [];
  const chosen = candidates.find((c) => c.id === (pick ?? state.listing.partNumberId)) ?? (candidates.length === 1 ? candidates[0] : undefined);
  const suggested = chosen ? await listings.suggestedVariants(chosen.id) : [];
  const confirmed = new Set(state.fitments.filter((f) => f.source === "PART_NUMBER_MATCH").map((f) => f.variant.id));

  return (
    <WizardFrame listingId={id} step="part" reached={reached} incomplete={incomplete}>
      <form method="get" role="search" className="flex max-w-xl flex-col gap-2">
        <label htmlFor="pn" className="text-sm font-semibold">Part number</label>
        <div className="flex gap-2">
          <input id="pn" name="pn" defaultValue={query} className="min-h-11 flex-1 border border-rule bg-surface px-3" placeholder="As printed on the part or box" />
          <button type="submit" className={buttonClasses("secondary")}>Find</button>
        </div>
        <p className="text-sm text-steel">{chosen?.category.partNumberHint ?? "Usually stamped on the part or printed on a label. Spaces and dashes don't matter."}</p>
      </form>

      {query && candidates.length === 0 ? (
        <p className="prose-measure border border-caution bg-caution-tint p-3 text-caution">
          {query} isn&apos;t in our catalogue yet. Check the number, or try another number printed on the part. Listings need a catalogue part number so buyers can check fit.
        </p>
      ) : null}

      {candidates.length > 1 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg">Which brand?</h2>
          <ul className="flex flex-wrap gap-2">
            {candidates.map((c) => (
              <li key={c.id}>
                <Link href={`?pn=${encodeURIComponent(query)}&pick=${c.id}`} className={buttonClasses(c.id === chosen?.id ? "primary" : "secondary")}>
                  {c.brand}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {chosen ? (
        <ActionForm action={savePart} submitLabel="Save and continue" extraActions={<SaveDraftButton />}>
          <input type="hidden" name="listingId" value={id} />
          <input type="hidden" name="partNumberId" value={chosen.id} />
          <div className="flex flex-wrap items-center gap-2 border border-rule bg-surface p-3">
            <PartNumberText value={chosen.display} />
            <span>{chosen.brand}, {chosen.category.name}</span>
            {chosen.isSample ? <Badge tone="caution">SAMPLE catalogue data</Badge> : null}
            {chosen.category.isSafetyCritical ? <Badge tone="caution">Safety-critical</Badge> : null}
          </div>
          <FormInput label="Part name" name="partName" defaultValue={state.listing.partName ?? ""} help="What buyers search for, for example 'Front brake pads'." />
          {suggested.length ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-semibold">This part number is recorded to fit these bikes. Tick the ones you&apos;re sure about.</legend>
              {suggested.map((v) => (
                <Checkbox
                  key={v.id}
                  name="confirmedVariantIds"
                  value={v.id}
                  defaultChecked={confirmed.has(v.id)}
                  label={`${v.model.make.name} ${v.model.name} ${v.name}`}
                  description={`${v.yearFrom} to ${v.yearTo ?? "now"}`}
                />
              ))}
            </fieldset>
          ) : (
            <p className="text-steel">No bikes are recorded for this part number yet. Your own bike from step 1 is still shown to buyers.</p>
          )}
        </ActionForm>
      ) : null}
    </WizardFrame>
  );
}
