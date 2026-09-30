import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { formatPrice } from "@/lib/format";
import { requireMemberPage } from "@/server/auth/current";
import { env } from "@/server/env";
import { NotFoundError } from "@/server/http/errors";
import { orders } from "@/server/services";
import { mockCheckout } from "../../../checkout/actions";

export const metadata: Metadata = { title: "Mock payment | RePart" };

/** Fake hosted checkout for the mock provider (PLAN.md §7.3). Never mounted in production or with Cashfree. */
export default async function MockCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  if (process.env.NODE_ENV === "production" || env().PAYMENT_PROVIDER !== "mock") notFound();
  const { orderId } = await params;
  const user = await requireMemberPage(`/dev/mock-checkout/${orderId}`);
  let o;
  try {
    o = await orders.forUser(user.id, orderId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  if (o.role !== "buyer") notFound();

  const outcomes = [
    { value: "SUCCESS", label: "Pay successfully" },
    { value: "FAILED", label: "Payment fails" },
    { value: "USER_DROPPED", label: "Abandon payment" },
  ] as const;
  return (
    <Page title="Mock payment" intro="Development only. Each button sends a signed mock webhook through the real webhook handler." narrow>
      <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
        <p>
          {o.title}: <span className="tabular-nums">{formatPrice(o.totalPaise)}</span>
        </p>
        {outcomes.map((x) => (
          <ActionForm key={x.value} action={mockCheckout} submitLabel={x.label} submitVariant={x.value === "SUCCESS" ? "primary" : "secondary"} fullWidthSubmit>
            <input type="hidden" name="orderId" value={o.id} />
            <input type="hidden" name="outcome" value={x.value} />
          </ActionForm>
        ))}
      </section>
    </Page>
  );
}
