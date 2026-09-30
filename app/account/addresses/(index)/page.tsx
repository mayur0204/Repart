import type { Metadata } from "next";
import Link from "next/link";
import { AddressFields } from "@/components/account/address-fields";
import { ActionForm, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge } from "@/components/ui/display";
import { Checkbox } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { addresses } from "@/server/services";
import { createAddress, deleteAddress, setDefaultAddress } from "../../actions";

export const metadata: Metadata = { title: "Addresses | RePart" };

export default async function AddressesPage() {
  const user = await requireMemberPage("/account/addresses");
  const list = await addresses.list(user.id);

  return (
    <Page title="Addresses" intro="Orders keep a copy of the address used, so changes here don't affect past orders.">
      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col gap-3 lg:col-span-5" aria-labelledby="saved-heading">
          <h2 id="saved-heading" className="text-xl">
            Saved addresses
          </h2>
          {list.length === 0 ? (
            <EmptyState title="No addresses yet" body="Add one so sellers can quote delivery and couriers know where to go." />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 border border-rule bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{a.label ?? a.contactName}</span>
                    {a.isDefault ? <Badge tone="neutral" icon={false}>Default</Badge> : null}
                  </div>
                  <address className="not-italic text-steel">
                    {a.contactName}
                    <br />
                    {[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}
                    <br />
                    {a.city}, {a.state} <span className="num">{a.pincode}</span>
                  </address>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/account/addresses/${a.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">
                      Edit
                    </Link>
                    {!a.isDefault ? (
                      <InlineAction action={setDefaultAddress} label="Make default">
                        <input type="hidden" name="id" value={a.id} />
                      </InlineAction>
                    ) : null}
                    <InlineAction action={deleteAddress} label="Delete">
                      <input type="hidden" name="id" value={a.id} />
                    </InlineAction>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4 lg:col-span-7" aria-labelledby="add-heading">
          <h2 id="add-heading" className="text-xl">
            Add an address
          </h2>
          <ActionForm action={createAddress} submitLabel="Save address">
            <AddressFields />
            <Checkbox name="makeDefault" label="Make this my default address" defaultChecked={list.length === 0} />
          </ActionForm>
        </section>
      </div>
    </Page>
  );
}
