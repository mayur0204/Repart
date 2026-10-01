import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";

export const metadata: Metadata = { title: "Admin | RePart" };

function Metric({ label, value, href, note }: { label: string; value: ReactNode; href: string; note?: string }) {
  return (
    <Link href={href} className="flex flex-col gap-1 rounded-lg border border-rule bg-surface p-4 hover:bg-page">
      <span className="text-sm text-steel">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {note ? <span className="text-sm text-steel">{note}</span> : null}
    </Link>
  );
}

/**
 * Admin overview (PLAN.md §4.8): current-state metrics, disputes and paid orders near the provider's automatic
 * release (§5.3, A-10), and open reconciliation mismatches. No historical windows are defined, so none are shown.
 */
export default async function AdminHome() {
  if (!(await adminPage("/admin"))) return <PermissionDenied />;
  const m = await admin.overview();
  const near = m.nearAutoRelease;
  const rows = (list: typeof near.disputes, link: (r: (typeof near.disputes)[number]) => string) =>
    list.map((r) => (
      <tr key={r.id}>
        <Td><Link href={link(r)} className="text-action underline-offset-4 hover:underline">{r.title}</Link></Td>
        <Td>{ORDER_STATE_TEXT[r.state] ?? r.state}</Td>
        <Td>{r.autoReleaseAt ? <DateText date={r.autoReleaseAt} /> : null}</Td>
        <Td>{r.deadlineBreachedAt ? <Badge tone="danger">Passed</Badge> : <Badge tone={r.hoursLeft <= 24 ? "danger" : "caution"}>{`${r.hoursLeft} hours left`}</Badge>}</Td>
      </tr>
    ));
  const approaching = near.disputes.length + near.others.length;
  return (
    <Page title="Admin">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Metric label="Open disputes" value={m.openDisputes} href="/admin/disputes" />
        <Metric label="Orders approaching auto-release" value={approaching} href="/admin/orders?sort=deadline" note="Paid, not finished, within the warning window" />
        <Metric label="Listing review queue" value={m.reviewQueueCount} href="/admin/listings" />
        <Metric label="Refunded" value={formatPrice(m.refundedPaise)} href="/admin/orders" note={`${m.refundedCount} refunds succeeded, ${m.pendingRefunds} in progress`} />
        <Metric label="Open reconciliation mismatches" value={m.openMismatchCount} href="/admin/reconciliation" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Orders by state</h2>
          <AdminTable head={["State", "Orders"]}>
            {m.ordersByState.map((o) => (
              <tr key={o.state}>
                <Td><Link href={`/admin/orders?state=${o.state}`} className="text-action underline-offset-4 hover:underline">{ORDER_STATE_TEXT[o.state] ?? o.state}</Link></Td>
                <Td className="num">{o.count}</Td>
              </tr>
            ))}
          </AdminTable>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Listings by status</h2>
          <AdminTable head={["Status", "Listings"]}>
            {m.listingsByStatus.map((l) => (
              <tr key={l.status}>
                <Td>{l.status.toLowerCase().replace(/_/g, " ")}</Td>
                <Td className="num">{l.count}</Td>
              </tr>
            ))}
          </AdminTable>
        </section>
      </div>

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
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Reconciliation mismatches</h2>
        {m.openMismatches.length ? (
          <AdminTable head={["Kind", "Order", "Run"]}>
            {m.openMismatches.map((x) => (
              <tr key={x.id}>
                <Td>{x.kind}</Td>
                <Td>{x.orderId ? <Link href={`/admin/orders/${x.orderId}`} className="text-action underline-offset-4 hover:underline">{x.orderId}</Link> : "Unknown"}</Td>
                <Td><DateText date={x.run.runDate} /></Td>
              </tr>
            ))}
          </AdminTable>
        ) : (
          <p>No open mismatches.</p>
        )}
        <Link href="/admin/reconciliation" className="text-action underline underline-offset-4">All reconciliation runs</Link>
      </section>
    </Page>
  );
}
