import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { ChecklistFields } from "@/components/sell/checklist-fields";
import { SaveDraftButton, WizardFrame } from "@/components/sell/wizard-frame";
import { EmptyState } from "@/components/ui/states";
import type { ChecklistAnswers } from "@/lib/listing";
import { saveCondition } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Condition | Sell a part | RePart" };

export default async function ConditionStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { state, incomplete, reached } = await loadStep(id, "condition");

  return (
    <WizardFrame listingId={id} step="condition" reached={reached} incomplete={incomplete}>
      {!state.category ? (
        <EmptyState title="Choose the part first" body="The checklist depends on the kind of part." action={<Link href={`/sell/${id}/part`} className="text-action underline">Go to step 2</Link>} />
      ) : (
        <>
          <p className="prose-measure text-steel">Answer honestly. Buyers see the grade, and a mechanic may check the part against these answers.</p>
          <ActionForm action={saveCondition} submitLabel="Save and continue" extraActions={<SaveDraftButton />}>
            <input type="hidden" name="listingId" value={id} />
            <ChecklistFields items={state.checklist} initial={(state.listing.checklistAnswers ?? {}) as ChecklistAnswers} thresholds={state.settings.grading} />
          </ActionForm>
        </>
      )}
    </WizardFrame>
  );
}
