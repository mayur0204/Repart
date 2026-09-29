import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { VehicleFields } from "@/components/garage/vehicle-fields";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { requireMemberPage } from "@/server/auth/current";
import { catalogue } from "@/server/services";
import { addVehicle } from "../actions";

export const metadata: Metadata = { title: "Add a bike | RePart" };

export default async function AddVehiclePage() {
  await requireMemberPage("/garage/add");
  const data = await catalogue.vehicles();
  return (
    <Page title="Add a bike" narrow>
      <ActionForm
        action={addVehicle}
        submitLabel="Add bike"
        extraActions={
          <Link href="/garage" className={buttonClasses("tertiary")}>
            Cancel
          </Link>
        }
      >
        <VehicleFields catalogue={data} />
      </ActionForm>
    </Page>
  );
}
