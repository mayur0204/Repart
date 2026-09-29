import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AddressFields } from "@/components/account/address-fields";
import { ActionForm } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { addresses } from "@/server/services";
import { updateAddress } from "../../actions";

export const metadata: Metadata = { title: "Edit address | RePart" };

export default async function EditAddressPage({ params }: { params: Promise<{ addressId: string }> }) {
  const { addressId } = await params;
  const user = await requireMemberPage(`/account/addresses/${addressId}`);
  const address = await addresses.get(user.id, addressId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });

  return (
    <Page title="Edit address" narrow>
      <ActionForm
        action={updateAddress}
        submitLabel="Save address"
        extraActions={
          <Link href="/account/addresses" className={buttonClasses("tertiary")}>
            Cancel
          </Link>
        }
      >
        <input type="hidden" name="id" value={address.id} />
        <AddressFields defaults={address} />
      </ActionForm>
    </Page>
  );
}
