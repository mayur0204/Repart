import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/checkout/auto-refresh";
import { PayForm } from "@/components/checkout/pay-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { retryPayment } from "../actions";

export const metadata: Metadata = { title: "Payment | RePart" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Payment return page (PLAN.md §4.5). It never marks anything paid itself: it asks the provider through
 * the server (same verified path as the webhook) and shows RePart's order state.
 */
export default async function PaymentReturnPage({ searchParams }: Props) {
  const raw = (await searchParams).order;
  const orderId = Array.isArray(raw) ? raw[0] : raw;
  if (!orderId) notFound();
  const user = await requireMemberPage(`/checkout/return?order=${encodeURIComponent(orderId)}`);
  let order;
  try {
    order = await orders.forUser(user.id, orderId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (order.role !== "buyer") notFound();
  if (order.state === "CREATED") {
    await orders.confirm(orderId).catch(() => null); // provider unreachable: the webhook or the next refresh will catch up
    order = await orders.forUser(user.id, orderId);
  }

  const paid = order.state !== "CREATED" && order.state !== "CANCELLED";
  const failed = order.state === "CREATED" && order.payment?.status === "FAILED";
  const expired = order.state === "CANCELLED" && order.payment?.status !== "SUCCESS";

  return (
    <Page title={paid ? "Payment received" : failed ? "Payment didn't go through" : expired ? "Order cancelled" : "Confirming your payment"} narrow>
      <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
        {paid ? (
          <p>Thanks. Your payment for {order.title} is confirmed and held safely. The seller has been asked to confirm the order.</p>
        ) : failed ? (
          <>
            <p>Your bank or payment app didn&apos;t complete the payment. No money was taken for this attempt. You can try again while the order is still reserved for you.</p>
            <PayForm action={retryPayment} label="Try paying again" mode="sandbox">
              <input type="hidden" name="orderId" value={order.id} />
            </PayForm>
          </>
        ) : expired ? (
          <p>The time to pay ran out, so the part was released. {order.cancelReason}</p>
        ) : (
          <>
            <p>We&apos;re waiting for the payment provider to confirm your payment. This page updates by itself.</p>
            <AutoRefresh />
          </>
        )}
        <ButtonLink href={`/orders/${order.id}`} variant="secondary">View order</ButtonLink>
      </section>
    </Page>
  );
}
