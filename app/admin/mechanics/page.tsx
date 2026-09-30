import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { GarageForm } from "./garage-form";
import { ActionForm, FormInput, FormSelect } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { inspections } from "@/server/services";
import { pickupSlots } from "@/server/services/order/fulfilment";
import { reassignInspection } from "./actions";

export const metadata: Metadata = { title: "Mechanics | Admin | RePart" };

const slotLabel = (s: { start: Date }) => s.start.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** Partner garages: service areas, capacity, today's load, and Partner Checks waiting for a garage (PLAN.md §4.8). */
export default async function MechanicsPage() {
  if (!(await adminPage("/admin/mechanics"))) return <PermissionDenied />;
  const { garages, waiting } = await inspections.garages();
  const slots = pickupSlots(new Date());
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
              <FormSelect label="Slot" name="slot" defaultValue={slots[0]?.id}>
                {slots.map((s) => <option key={s.id} value={s.id}>{slotLabel(s)}</option>)}
              </FormSelect>
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
