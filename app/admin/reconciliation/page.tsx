import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { DateText } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { orders } from "@/server/services";
import { markMismatchResolved, runReconciliationNow } from "../orders/actions";

export const metadata: Metadata = { title: "Reconciliation | Admin | RePart" };

const json = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v));

/** Payment reconciliation (PLAN.md §7.2 step 8): mismatches are flagged here for a person; nothing is auto-corrected. */
export default async function ReconciliationPage() {
  if (!(await adminPage("/admin/reconciliation"))) return <PermissionDenied />;
  const { runs, open } = await orders.reconciliation();
  return (
    <Page title="Reconciliation" intro="RePart amounts compared with the payment provider's orders, payments and seller splits." actions={<InlineAction action={runReconciliationNow} label="Run now" variant="secondary" />}>
      <h2 className="text-xl">Open mismatches</h2>
      {open.length === 0 ? (
        <EmptyState title="No open mismatches" body="Everything checked so far matches." />
      ) : (
        <AdminTable head={["Kind", "Order", "Expected", "Found", "Run", ""]}>
          {open.map((m) => (
            <tr key={m.id}>
              <Td>{m.kind}</Td>
              <Td>{m.orderId ? <Link href={`/admin/orders/${m.orderId}`} className="text-action underline-offset-4 hover:underline">{m.orderId}</Link> : "Unknown"}</Td>
              <Td className="max-w-64 break-all text-sm">{json(m.expected)}</Td>
              <Td className="max-w-64 break-all text-sm">{json(m.actual)}</Td>
              <Td className="text-sm"><DateText date={m.run.runDate} /> ({m.run.status.toLowerCase()})</Td>
              <Td>
                <InlineAction action={markMismatchResolved} label="Mark resolved">
                  <input type="hidden" name="id" value={m.id} />
                </InlineAction>
              </Td>
            </tr>
          ))}
        </AdminTable>
      )}
      <h2 className="text-xl">Recent runs</h2>
      <AdminTable head={["Date", "Status", "Mismatches", "Summary"]}>
        {runs.map((r) => (
          <tr key={r.id}>
            <Td><DateText date={r.createdAt} /></Td>
            <Td>{r.status.toLowerCase()}</Td>
            <Td className="num">{r._count.mismatches}</Td>
            <Td className="text-sm">{json(r.summary)}</Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
