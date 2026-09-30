import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { EmptyState } from "@/components/ui/states";
import { ButtonLink } from "@/components/ui/button";
import { Badge, DateText } from "@/components/ui/display";
import { formatPrice } from "@/lib/format";
import { ORDER_STATE_TEXT } from "@/lib/order-state";
import { requireMemberPage } from "@/server/auth/current";
import { orders } from "@/server/services";

export const metadata: Metadata = { title: "Orders | RePart" };

/** Orders you bought and sold (PLAN.md §4.5). */
export default async function OrdersPage() {
  const user = await requireMemberPage("/orders");
  const rows = await orders.list(user.id);
  return (
    <Page title="Orders">
      {rows.length === 0 ? (
        <EmptyState title="No orders yet" body="Parts you buy or sell appear here." action={<ButtonLink href="/search">Find a part</ButtonLink>} />
      ) : (
        <ul className="flex flex-col border-t border-rule">
          {rows.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-rule py-3">
              <div className="flex flex-col">
                <Link href={`/orders/${o.id}`} className="text-action underline-offset-4 hover:underline">{o.title}</Link>
                <span className="text-sm text-steel">
                  {o.role === "buyer" ? "Bought" : "Sold"} on <DateText date={o.createdAt} />
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Badge>{ORDER_STATE_TEXT[o.state] ?? o.state}</Badge>
                <span className="tabular-nums">{formatPrice(o.role === "buyer" ? o.totalPaise : o.vendorSharePaise)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
