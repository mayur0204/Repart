import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { inspections } from "@/server/services";
import { reassignInspection } from "../actions";
import { GarageChoice } from "../garage-choice";
import { GarageForm } from "../garage-form";

export const metadata: Metadata = { title: "Mechanics | Admin | RePart" };

/** Partner garages: service areas, capacity, today's load, and Partner Checks waiting for a garage (PLAN.md §4.8). */
export default async function MechanicsPage() {
  if (!(await adminPage("/admin/mechanics"))) return <PermissionDenied />;
  const { garages, waiting } = await inspections.garages();
  const options = new Map(await Promise.all(waiting.map(async (o) => [o.id, await inspections.reassignmentOptions(o.id)] as const)));
  return (
    <Page title="Partner garages" intro="Garages that do Partner Checks, their service areas and daily capacity.">
      {waiting.length ? (
        <section className="flex flex-col gap-3 border border-caution bg-surface p-4">
          <h2 className="text-xl">Partner Checks waiting for a garage</h2>
          <p className="text-sm">These orders can&apos;t move to pickup until a garage checks the part.</p>
          {waiting.map((o) => (
            <ActionForm key={o.id} action={reassignInspection} submitLabel="Assign garage">
              <p>
                <Link href={`/admin/orders/${o.id}`} className="text-action underline underline-offset-4">{o.listing.title ?? o.listing.partName ?? o.id}</Link>, pincode {o.listing.pickupPincode ?? "unknown"}, ordered <DateText date={o.createdAt} />
              </p>
              <input type="hidden" name="orderId" value={o.id} />
              <GarageChoice options={options.get(o.id) ?? []} />
              <FormInput label="Reason" name="reason" defaultValue="No garage was available when the seller confirmed" />
            </ActionForm>
          ))}
        </section>
      ) : null}
      <AdminTable head={["Garage", "Service pincodes", "Today", "Staff", "Status"]}>
        {garages.map((g) => (
          <tr key={g.id}>
            <Td><Link href={`/admin/mechanics/${g.id}`} className="text-action underline-offset-4 hover:underline">{g.garageName}</Link></Td>
            <Td className="text-sm">{g.servicePincodes.join(", ")}</Td>
            <Td className="num">{g.todayLoad} of {g.capacityPerDay}</Td>
            <Td className="num">{g._count.staff}</Td>
            <Td>{g.active ? <Badge tone="fit">Active</Badge> : <Badge tone="caution">Inactive</Badge>}</Td>
          </tr>
        ))}
      </AdminTable>
      <section className="flex max-w-2xl flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">Add a garage</h2>
        <GarageForm />
      </section>
    </Page>
  );
}
