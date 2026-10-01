import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { Checkbox } from "@/components/ui/field";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { inspections } from "@/server/services";
import { linkMechanic, reassignInspection, setStaffActive } from "../actions";
import { GarageChoice } from "../garage-choice";
import { GarageForm } from "../garage-form";

export const metadata: Metadata = { title: "Garage | Admin | RePart" };

/** One garage: details, service area and capacity, staff links, and its Partner Checks with reassignment (PLAN.md §4.8). */
export default async function GaragePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/mechanics/${id}`))) return <PermissionDenied />;
  let g;
  try {
    g = await inspections.garage(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const scheduled = g.inspections.filter((i) => i.status === "SCHEDULED" && i.orderId).map((i) => i.orderId!);
  const options = new Map(await Promise.all(scheduled.map(async (orderId) => [orderId, await inspections.reassignmentOptions(orderId)] as const)));
  return (
    <Page title={g.garageName} actions={g.active ? <Badge tone="fit">Active</Badge> : <Badge tone="caution">Inactive</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-xl">Details</h2>
          <GarageForm garage={g} />
          <p className="text-sm text-steel">
            {g.inspectionsCompleted} checks done. Fail rate {g.failRate === null ? "n/a" : `${Math.round(g.failRate * 100)}%`}, on time {g.onTimeRate === null ? "n/a" : `${Math.round(g.onTimeRate * 100)}%`}.
          </p>
        </section>
        <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-xl">Mechanics</h2>
          <ul className="flex flex-col">
            {g.staff.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-rule py-2">
                <span>
                  {s.user.name ?? "Unnamed"} ({s.user.phone}) {s.active ? null : <Badge tone="caution">Inactive</Badge>}
                </span>
                <InlineAction action={setStaffActive} label={s.active ? "Deactivate" : "Activate"}>
                  <input type="hidden" name="staffId" value={s.id} />
                  <input type="hidden" name="partnerId" value={g.id} />
                  <input type="hidden" name="active" value={s.active ? "false" : "true"} />
                </InlineAction>
              </li>
            ))}
          </ul>
          <ActionForm action={linkMechanic} submitLabel="Link mechanic">
            <input type="hidden" name="partnerId" value={g.id} />
            <FormInput label="Mechanic's phone (+91 and 10 digits)" name="phone" placeholder="+91" />
            <p className="text-sm text-steel">They get the mechanic role and see this garage&apos;s jobs.</p>
          </ActionForm>
        </section>
      </div>
      <h2 className="text-xl">Partner Checks</h2>
      <AdminTable head={["Order", "Slot", "Reason", "Status", "Move"]}>
        {g.inspections.map((i) => (
          <tr key={i.id}>
            <Td>{i.orderId ? <Link href={`/admin/orders/${i.orderId}`} className="text-action underline-offset-4 hover:underline">{i.orderId}</Link> : null}</Td>
            <Td>{i.slotStart ? <DateText date={i.slotStart} /> : null}</Td>
            <Td className="text-sm">{i.reason.toLowerCase().replace(/_/g, " ")}</Td>
            <Td>{i.outcome ? i.outcome.toLowerCase().replace(/_/g, " ") : i.status.toLowerCase().replace(/_/g, " ")}</Td>
            <Td>
              {i.status === "SCHEDULED" && i.orderId ? (
                <details>
                  <summary className="cursor-pointer text-action">Reschedule or reassign</summary>
                  <ActionForm action={reassignInspection} submitLabel="Book new slot">
                    <input type="hidden" name="orderId" value={i.orderId} />
                    <GarageChoice options={options.get(i.orderId) ?? []} />
                    <Checkbox name="noShow" label="Mark the current appointment as a no-show" />
                    <FormInput label="Reason" name="reason" />
                  </ActionForm>
                </details>
              ) : null}
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
