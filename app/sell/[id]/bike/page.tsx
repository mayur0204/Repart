import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/action-form";
import { BikeFields } from "@/components/sell/bike-fields";
import { SaveDraftButton, WizardFrame } from "@/components/sell/wizard-frame";
import { catalogue, garage } from "@/server/services";
import { vehicleLabel } from "@/server/services/garage/garage";
import { saveBike } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Bike | Sell a part | RePart" };

export default async function BikeStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, state, incomplete, reached } = await loadStep(id, "bike");
  const [bikes, data] = await Promise.all([garage.list(user.id), catalogue.vehicles()]);
  const current = state.fitments.find((f) => f.source === "SELLER_DECLARED")?.variant.id ?? null;

  return (
    <WizardFrame listingId={id} step="bike" reached={reached} incomplete={incomplete}>
      <p className="prose-measure text-steel">The bike this part was taken from. Buyers see it as &ldquo;Seller says this fits&rdquo; until a part number or mechanic confirms it.</p>
      <ActionForm action={saveBike} submitLabel="Save and continue" extraActions={<SaveDraftButton />}>
        <input type="hidden" name="listingId" value={id} />
        <BikeFields garage={bikes.map((b) => ({ id: b.id, label: vehicleLabel(b), nickname: b.nickname }))} catalogue={data} currentVariantId={current} />
      </ActionForm>
    </WizardFrame>
  );
}
