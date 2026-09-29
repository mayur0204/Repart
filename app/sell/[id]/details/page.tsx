import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/action-form";
import { DetailsFields } from "@/components/sell/details-fields";
import { SaveDraftButton, WizardFrame } from "@/components/sell/wizard-frame";
import { MAX_DESCRIPTION, MIN_DESCRIPTION } from "@/server/services/listing/steps";
import { saveDetails } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Details | Sell a part | RePart" };

export default async function DetailsStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { state, incomplete, reached } = await loadStep(id, "details");
  const l = state.listing;
  return (
    <WizardFrame listingId={id} step="details" reached={reached} incomplete={incomplete}>
      <ActionForm action={saveDetails} submitLabel="Save and continue" extraActions={<SaveDraftButton />}>
        <input type="hidden" name="listingId" value={id} />
        <DetailsFields
          initial={{ km: l.kmUsedApprox?.toString() ?? "", reason: l.reasonForSale ?? "", description: l.description ?? "" }}
          min={MIN_DESCRIPTION}
          max={MAX_DESCRIPTION}
        />
      </ActionForm>
    </WizardFrame>
  );
}
