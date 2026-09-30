import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ActionForm, FormInput, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { InspectionPhotos } from "@/components/mechanic/inspection-photos";
import { PermissionDenied } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { ForbiddenError, NotFoundError } from "@/server/http/errors";
import { inspections } from "@/server/services";
import { confirmInspectionPhoto, requestInspectionPhoto, submitInspection } from "../../../actions";

export const metadata: Metadata = { title: "Inspection | Mechanic | RePart" };

/** Inspection form (PLAN.md §4.7): checklist, required photos, measured values, outcome and notes → Submit inspection. */
export default async function InspectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/mechanic/jobs/${id}/inspect`);
  let d;
  try {
    d = await inspections.job(user.id, id);
  } catch (err) {
    if (err instanceof ForbiddenError) return <PermissionDenied body="This page is for RePart partner garage staff." />;
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (d.job.status !== "SCHEDULED") redirect(`/mechanic/jobs/${id}`);

  return (
    <Page title="Inspection" intro={`${d.listing.title}. Visual and basic check.`}>
      <section className="flex flex-col gap-3">
        <h2 className="text-xl">Photos</h2>
        <InspectionPhotos inspectionId={id} shots={d.shots} photos={d.photos} actions={{ request: requestInspectionPhoto, confirm: confirmInspectionPhoto }} />
      </section>
      <ActionForm action={submitInspection} submitLabel="Submit inspection">
        <input type="hidden" name="inspectionId" value={id} />
        <h2 className="text-xl">Checklist</h2>
        {d.checklist.map((c) => (
          <FormSelect key={c.id} label={c.question} name={`check_${c.id}`} defaultValue="">
            <option value="" disabled>Choose</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </FormSelect>
        ))}
        <h2 className="text-xl">Measured values (optional)</h2>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="grid grid-cols-3 gap-2">
            <FormInput label="What" name={`m${i}_label`} placeholder={i === 0 ? "Pad thickness" : undefined} />
            <FormInput label="Value" name={`m${i}_value`} inputMode="decimal" />
            <FormInput label="Unit" name={`m${i}_unit`} placeholder={i === 0 ? "mm" : undefined} />
          </div>
        ))}
        <h2 className="text-xl">Result</h2>
        <FormSelect label="Outcome" name="outcome" defaultValue="">
          <option value="" disabled>Choose</option>
          <option value="PASS">Pass</option>
          <option value="PASS_WITH_NOTES">Pass with notes</option>
          <option value="FAIL">Fail</option>
        </FormSelect>
        <FormTextarea label="Notes (shown to the buyer and seller; required unless it's a clean pass)" name="notes" rows={4} maxLength={2000} />
      </ActionForm>
    </Page>
  );
}
