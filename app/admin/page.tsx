import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { ORDER_STATE_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { disputes } from "@/server/services";

export const metadata: Metadata = { title: "Admin | RePart" };

/**
 * Admin home. M11: "Disputes near auto-release" (PLAN.md §5.3) plus paid open orders near the provider's hold
 * deadline (A-10). The overview metrics arrive in M12.
 */
export default async function AdminHome() {
  if (!(await adminPage("/admin"))) return <PermissionDenied />;
  const near = await disputes.nearAutoRelease();
  const rows = (list: typeof near.disputes, link: (r: (typeof near.disputes)[number]) => string) =>
    list.map((r) => (
      <tr key={r.id}>
        <Td><Link href={link(r)} className="text-action underline-offset-4 hover:underline">{r.title}</Link></Td>
        <Td>{ORDER_STATE_TEXT[r.state] ?? r.state}</Td>
        <Td>{r.autoReleaseAt ? <DateText date={r.autoReleaseAt} /> : null}</Td>
        <Td>{r.deadlineBreachedAt ? <Badge tone="danger">Passed</Badge> : <Badge tone={r.hoursLeft <= 24 ? "danger" : "caution"}>{`${r.hoursLeft} hours left`}</Badge>}</Td>
      </tr>
    ));
  return (
    <Page title="Admin">
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Disputes near auto-release</h2>
        <p className="text-sm text-steel">The payment provider releases the seller&apos;s money automatically at the hold deadline. Decide these first.</p>
        {near.disputes.length ? (
          <AdminTable head={["Order", "State", "Hold ends", "Time left"]}>{rows(near.disputes, (r) => (r.dispute ? `/admin/disputes/${r.dispute.id}` : `/admin/orders/${r.id}`))}</AdminTable>
        ) : (
          <p>No disputes near their deadline.</p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Other paid orders near auto-release</h2>
        {near.others.length ? <AdminTable head={["Order", "State", "Hold ends", "Time left"]}>{rows(near.others, (r) => `/admin/orders/${r.id}`)}</AdminTable> : <p>None.</p>}
      </section>
      <p>
        <Link href="/admin/disputes" className="text-action underline underline-offset-4">All disputes</Link>
      </p>
    </Page>
  );
}
