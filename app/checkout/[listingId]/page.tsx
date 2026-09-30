import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BuyerBreakdown } from "@/components/checkout/money";
import { PayForm } from "@/components/checkout/pay-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/field";
import { formatPrice } from "@/lib/format";
import { requireMemberPage } from "@/server/auth/current";
import { FieldError, NotFoundError, UserError } from "@/server/http/errors";
import { addresses, orders } from "@/server/services";
import { orderMoneyView } from "@/server/services/order/pricing";
import { startCheckout } from "../actions";

export const metadata: Metadata = { title: "Checkout | RePart" };

type Props = { params: Promise<{ listingId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Checkout (PLAN.md §4.5): address → courier quote → Partner Check → breakdown → Pay. Priced on the server every time. */
export default async function CheckoutPage({ params, searchParams }: Props) {
  const { listingId } = await params;
  const sp = await searchParams;
  const user = await requireMemberPage(`/checkout/${listingId}`);
  const saved = await addresses.list(user.id);
  const addressId = one(sp.address) ?? saved.find((a) => a.isDefault)?.id ?? saved[0]?.id;
  const withCheck = one(sp.check) === "1";

  let priced: Awaited<ReturnType<typeof orders.price>> | null = null;
  let problem: string | null = null;
  try {
    priced = await orders.price(user.id, { listingId, addressId, withCheck });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof UserError || err instanceof FieldError) problem = err.message;
    else throw err;
  }
  const delivery = priced?.listing.fulfilmentMode !== "LOCAL_PICKUP";

  return (
    <Page title="Checkout" intro="You pay RePart. The seller is paid only after you receive the part and confirm it's OK." narrow>
      <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">{priced?.listing.title ?? "Your part"}</h2>
        {delivery ? (
          saved.length ? (
            <form method="get" className="flex flex-col gap-3">
              <Select label="Deliver to" name="address" defaultValue={addressId}>
                {saved.map((a) => (
                  <option key={a.id} value={a.id}>
                    {[a.label, a.line1, a.city, a.pincode].filter(Boolean).join(", ")}
                  </option>
                ))}
              </Select>
              {priced?.listing.inspectionRequirement === "OPTIONAL" ? (
                <Checkbox name="check" value="1" defaultChecked={withCheck} label={`Add a Partner Check (${formatPrice(priced.listing.checkFeePaise)})`} description="A partner garage checks the part before it's sent." />
              ) : null}
              <div>
                <button type="submit" className="min-h-11 text-action underline underline-offset-4">Update price</button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-2">
              <p>Add a delivery address to see the delivery charge.</p>
              <ButtonLink href="/account/addresses" variant="secondary">Add an address</ButtonLink>
            </div>
          )
        ) : (
          <p className="text-steel">Local pickup: you collect the part from the seller. No delivery charge.</p>
        )}
        {priced?.listing.inspectionRequirement === "REQUIRED" ? <p className="text-sm text-steel">A Partner Check is included for this part.</p> : null}
      </section>

      {problem ? (
        <p role="alert" className="border border-danger bg-danger-tint p-3 text-danger">{problem}</p>
      ) : priced ? (
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Price breakdown</h2>
          <BuyerBreakdown money={orderMoneyView(priced.quote)} />
          {priced.etaDays ? <p className="text-sm text-steel">Usually delivered in about {priced.etaDays} days after pickup.</p> : null}
          <PayForm action={startCheckout} label={`Pay ${formatPrice(priced.quote.totalPaise)}`} mode="sandbox">
            <input type="hidden" name="listingId" value={listingId} />
            {addressId ? <input type="hidden" name="addressId" value={addressId} /> : null}
            <input type="hidden" name="withCheck" value={withCheck ? "on" : ""} />
          </PayForm>
          <p className="text-sm text-steel">
            Your money is held until you confirm the part is OK. <Link href="/how-it-works" className="text-action underline underline-offset-4">How it works</Link>
          </p>
        </section>
      ) : null}
    </Page>
  );
}
