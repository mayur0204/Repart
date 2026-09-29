import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { PhotoUploader } from "@/components/sell/photo-uploader";
import { WizardFrame } from "@/components/sell/wizard-frame";
import { EmptyState } from "@/components/ui/states";
import { photos } from "@/server/services";
import { confirmPhotoUpload, continueFromPhotos, movePhoto, removePhoto, requestPhotoUpload } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Photos | Sell a part | RePart" };

export default async function PhotosStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, state, incomplete, reached } = await loadStep(id, "photos");
  const initialPhotos = state.category ? await photos.listForOwner(user.id, id) : [];
  return (
    <WizardFrame listingId={id} step="photos" reached={reached} incomplete={incomplete}>
      {!state.category ? (
        <EmptyState title="Choose the part first" body="The shot list depends on the kind of part." action={<Link href={`/sell/${id}/part`} className="text-action underline">Go to step 2</Link>} />
      ) : (
        <>
          <p className="prose-measure text-steel">
            Take photos in daylight on a plain background. Location and camera details are removed from every photo before anyone sees it.
          </p>
          <PhotoUploader
            listingId={id}
            initialPhotos={initialPhotos}
            shots={state.photoGuide}
            minPhotos={state.settings.risk.minPhotos}
            thresholds={{ minBrightness: state.settings.risk.minBrightness, maxBrightness: state.settings.risk.maxBrightness, blurThreshold: state.settings.risk.blurThreshold }}
            actions={{ request: requestPhotoUpload, confirm: confirmPhotoUpload, remove: removePhoto, move: movePhoto }}
          />
          <ActionForm action={continueFromPhotos} submitLabel="Continue">
            <input type="hidden" name="listingId" value={id} />
          </ActionForm>
        </>
      )}
    </WizardFrame>
  );
}
