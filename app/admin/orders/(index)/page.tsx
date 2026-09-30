import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { FilterBar, Pager, plainParams } from "@/components/admin/list-controls";
import { Page } from "@/components/layout/page";
import { Badge, DateText, Price } from "@/components/ui/display";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { DISPUTE_STATUS_TEXT } from "@/lib/dispute";
import { ORDER_STATE_TEXT, SETTLEMENT_TEXT } from "@/lib/order-state";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";

export const metadata: Metadata = { title: "Orders | Admin | RePart" };

const PAYMENT_STATUSES = ["CREATED", "PENDING", "SUCCESS", "FAILED", "EXPIRED"];

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Orders with search (order / buyer / seller id, phone, email), filters and sorting (PLAN.md §4.8). */
export default async function AdminOrdersPage({ searchParams }: Props) {
  if (!(await adminPage("/admin/orders"))) return <PermissionDenied />;
  const params = plainParams(await searchParams);
  const { rows, filter: f, total, pages } = await admin.searchOrders(params);
  return (
    <Page title="Orders" intro="Search by order, buyer or seller id, or a buyer/seller phone or email. Orders near the payment provider's hold deadline are marked.">
      <FilterBar>
        <Input label="Search" name="q" defaultValue={f.q ?? ""} placeholder="Order id, user id, phone or email" />
        <Select label="State" name="state" defaultValue={f.state ?? ""}>
          <option value="">Any</option>
          {Object.entries(ORDER_STATE_TEXT).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </Select>
        <Select label="Payment" name="paymentStatus" defaultValue={f.paymentStatus ?? ""}>
          <option value="">Any</option>
          {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </Select>
        <Select label="Dispute" name="disputeStatus" defaultValue={f.disputeStatus ?? ""}>
          <option value="">Any</option>
          {Object.entries(DISPUTE_STATUS_TEXT).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </Select>
        <Input label="From" name="from" type="date" defaultValue={f.from ?? ""} />
        <Input label="To" name="to" type="date" defaultValue={f.to ?? ""} />
        <Select label="Sort" name="sort" defaultValue={f.sort}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="deadline">Hold deadline</option>
        </Select>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No matching orders" body="Try a different search or filter." />
      ) : (
        <AdminTable head={["Order", "State", "Total", "Payment", "Seller payout", "Dispute", "Hold ends", "Created"]}>
          {rows.map((o) => (
            <tr key={o.id}>
              <Td>
                <Link href={`/admin/orders/${o.id}`} className="text-action underline-offset-4 hover:underline">{o.listing.title ?? o.listing.partName ?? o.id}</Link>
                <span className="block text-sm text-steel">{o.id}</span>
                {o.deadlineBreachedAt ? <Badge tone="danger">Hold deadline passed</Badge> : o.nearDeadline ? <Badge tone="caution">Near hold deadline</Badge> : null}
              </Td>
              <Td>{ORDER_STATE_TEXT[o.state] ?? o.state}</Td>
              <Td className="num"><Price paise={o.totalPaise} size="sm" /></Td>
              <Td>{o.payment?.status.toLowerCase() ?? "None"}</Td>
              <Td className="text-sm">{o.payment ? (SETTLEMENT_TEXT[o.payment.vendorSettlementStatus] ?? o.payment.vendorSettlementStatus) : null}</Td>
              <Td className="text-sm">{o.dispute ? (DISPUTE_STATUS_TEXT[o.dispute.status] ?? o.dispute.status) : null}</Td>
              <Td>{o.autoReleaseAt ? <DateText date={o.autoReleaseAt} /> : null}</Td>
              <Td><DateText date={o.createdAt} /></Td>
            </tr>
          ))}
        </AdminTable>
      )}
      <Pager path="/admin/orders" params={params} page={f.page} pages={pages} total={total} />
    </Page>
  );
}
