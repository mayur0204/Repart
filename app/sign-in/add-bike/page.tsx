import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { VehicleFields } from "@/components/garage/vehicle-fields";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { safeNext } from "@/lib/return-to";
import { requireMemberPage } from "@/server/auth/current";
import { catalogue as catalogueService } from "@/server/services";
import { addFirstBike } from "../actions";

export const metadata: Metadata = { title: "Add your bike | RePart" };

export default async function AddBikePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  await requireMemberPage(`/sign-in/add-bike${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  const catalogue = await catalogueService.vehicles();

  return (
    <Page title="Add your bike" intro="We'll show which parts fit it. You can add more bikes later in your garage." narrow>
      <ActionForm
        action={addFirstBike}
        submitLabel="Add bike"
        extraActions={
          <Link href={safeNext(next)} className={buttonClasses("tertiary")}>
            Skip for now
          </Link>
        }
      >
        <input type="hidden" name="next" value={next ?? ""} />
        <VehicleFields catalogue={catalogue} />
      </ActionForm>
    </Page>
  );
}
