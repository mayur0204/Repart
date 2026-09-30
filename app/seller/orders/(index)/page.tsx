import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { fulfilment } from "@/server/services";

export const metadata: Metadata = { title: "Orders to handle | RePart" };

type Row = Awaited<ReturnType<typeof fulfilment.sellerOrders>>["toHandle"][number];

function OrderRows({ rows }: { rows: Row[] }) {
  return (
    <ul className="flex flex-col border-t border-rule">
      {rows.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-rule py-3">
          <div className="flex flex-col">
            <Link href={`/seller/orders/${o.id}`} className="text-action underline-offset-4 hover:underline">{o.title}</Link>
            <span className="text-sm text-steel">
              Ordered <DateText date={o.createdAt} />, {o.fulfilmentMode === "LOCAL_PICKUP" ? "local pickup" : "courier delivery"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {o.hoursLeft !== null ? <Badge tone={o.hoursLeft <= 6 ? "danger" : "caution"}>{`Confirm within ${o.hoursLeft} h`}</Badge> : <Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>}
            <span className="tabular-nums">{formatPrice(o.vendorSharePaise)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Seller orders (PLAN.md §4.4): orders that need the seller first, then the rest. Amounts are what the seller receives. */
export default async function SellerOrdersPage() {
  const user = await requireMemberPage("/seller/orders");
  const { toHandle, others } = await fulfilment.sellerOrders(user.id);
  return (
    <Page title="Your orders">
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Orders to handle</h2>
        {toHandle.length ? <OrderRows rows={toHandle} /> : <EmptyState title="Nothing to handle" body="New orders appear here when a buyer pays." />}
      </section>
      {others.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Other orders</h2>
          <OrderRows rows={others} />
        </section>
      ) : null}
    </Page>
  );
}
