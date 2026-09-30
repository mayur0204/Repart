import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { Badge, DateText, Price } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { ORDER_STATE_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { orders } from "@/server/services";

export const metadata: Metadata = { title: "Orders | Admin | RePart" };

export default async function AdminOrdersPage() {
  if (!(await adminPage("/admin/orders"))) return <PermissionDenied />;
  const rows = await orders.adminList();
  return (
    <Page title="Orders" intro="Newest first. Orders near the payment provider's 45-day hold deadline are marked.">
      {rows.length === 0 ? (
        <EmptyState title="No orders yet" body="Orders appear here once buyers check out." />
      ) : (
        <AdminTable head={["Order", "State", "Total", "Payment", "Seller payout", "Created"]}>
          {rows.map((o) => {
            return (
              <tr key={o.id}>
                <Td>
                  <Link href={`/admin/orders/${o.id}`} className="text-action underline-offset-4 hover:underline">{o.listing.title ?? o.listing.partName ?? o.id}</Link>
                  {o.deadlineBreachedAt ? <Badge tone="danger">Hold deadline passed</Badge> : o.nearDeadline ? <Badge tone="caution">Near hold deadline</Badge> : null}
                </Td>
                <Td>{ORDER_STATE_TEXT[o.state] ?? o.state}</Td>
                <Td className="num"><Price paise={o.totalPaise} size="sm" /></Td>
                <Td>{o.payment?.status ?? "None"}</Td>
                <Td className="text-sm">{o.payment ? (SETTLEMENT_TEXT[o.payment.vendorSettlementStatus] ?? o.payment.vendorSettlementStatus) : null}</Td>
                <Td><DateText date={o.createdAt} /></Td>
              </tr>
            );
          })}
        </AdminTable>
      )}
    </Page>
  );
}
