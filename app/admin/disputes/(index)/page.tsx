import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { DISPUTE_REASON_TEXT, DISPUTE_STATUS_TEXT } from "@/lib/dispute";
import { adminPage } from "@/server/auth/current";
import { disputes } from "@/server/services";

export const metadata: Metadata = { title: "Disputes | Admin | RePart" };

/** Disputes, open first, sorted by the payment provider's automatic-release deadline (PLAN.md §5.3). */
export default async function DisputesPage() {
  if (!(await adminPage("/admin/disputes"))) return <PermissionDenied />;
  const rows = await disputes.adminList();
  return (
    <Page title="Disputes" intro="Open disputes first, sorted by when the payment provider would release the seller's money automatically. Every dispute needs an explicit decision.">
      {rows.length === 0 ? (
        <EmptyState title="No disputes" body="Problems buyers report appear here." />
      ) : (
        <AdminTable head={["Order", "Reason", "Status", "Hold ends", "Reported"]}>
          {rows.map((d) => (
            <tr key={d.id}>
              <Td>
                <Link href={`/admin/disputes/${d.id}`} className="text-action underline-offset-4 hover:underline">{d.title}</Link>
                {d.critical ? <Badge tone="danger">Under 24 hours</Badge> : d.nearDeadline ? <Badge tone="caution">Near deadline</Badge> : null}
              </Td>
              <Td className="text-sm">{DISPUTE_REASON_TEXT[d.reason] ?? d.reason}</Td>
              <Td className="text-sm">{DISPUTE_STATUS_TEXT[d.status] ?? d.status}</Td>
              <Td>{d.autoReleaseAt ? <DateText date={d.autoReleaseAt} /> : "None"}</Td>
              <Td><DateText date={d.createdAt} /></Td>
            </tr>
          ))}
        </AdminTable>
      )}
    </Page>
  );
}
