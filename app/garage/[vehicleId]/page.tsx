import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/forms/action-form";
import { VehicleFields } from "@/components/garage/vehicle-fields";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { catalogue, garage } from "@/server/services";
import { updateVehicle } from "../actions";

export const metadata: Metadata = { title: "Edit bike | RePart" };

export default async function EditVehiclePage({ params }: { params: Promise<{ vehicleId: string }> }) {
  const { vehicleId } = await params;
  const user = await requireMemberPage(`/garage/${vehicleId}`);
  const vehicle = await garage.get(user.id, vehicleId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const data = await catalogue.vehicles();

  return (
    <Page title="Edit bike" narrow>
      <ActionForm
        action={updateVehicle}
        submitLabel="Save bike"
        extraActions={
          <Link href="/garage" className={buttonClasses("tertiary")}>
            Cancel
          </Link>
        }
      >
        <input type="hidden" name="id" value={vehicle.id} />
        <VehicleFields
          catalogue={data}
          initial={{
            makeId: vehicle.variant.model.make.id,
            modelId: vehicle.variant.model.id,
            variantId: vehicle.variantId,
            year: vehicle.year,
            nickname: vehicle.nickname,
          }}
        />
      </ActionForm>
    </Page>
  );
}
