import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, FormInput, FormSelect } from "@/components/forms/action-form";
import { SaveDraftButton, WizardFrame } from "@/components/sell/wizard-frame";
import { Price } from "@/components/ui/display";
import { addresses, listings } from "@/server/services";
import { savePrice } from "../../actions";
import { loadStep } from "../load";

export const metadata: Metadata = { title: "Price and pickup | Sell a part | RePart" };

const WEIGHTS = { UNDER_1KG: "Under 1 kg", KG_1_3: "1 to 3 kg", KG_3_7: "3 to 7 kg", KG_7_15: "7 to 15 kg", KG_15_30: "15 to 30 kg", OVER_30KG: "Over 30 kg" };
const SIZES = { SMALL: "Small (fits a shoebox)", MEDIUM: "Medium (fits a carry-on bag)", LARGE: "Large (fits a big carton)", OVERSIZE: "Oversize" };

export default async function PriceStep({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, state, incomplete, reached } = await loadStep(id, "price");
  const [saved, range] = await Promise.all([addresses.list(user.id), listings.comparablePrice(state.listing)]);
  const l = state.listing;
  const pickupOnly = state.category?.shippingRestriction === "NOT_SHIPPABLE";

  return (
    <WizardFrame listingId={id} step="price" reached={reached} incomplete={incomplete}>
      <ActionForm action={savePrice} submitLabel="Save and continue" extraActions={<SaveDraftButton />}>
        <input type="hidden" name="listingId" value={id} />
        <FormInput
          label="Price (₹)"
          name="priceRupees"
          inputMode="decimal"
          defaultValue={l.pricePaise ? String(l.pricePaise / 100) : ""}
          help={
            range ? (
              <>
                Similar parts listed on RePart: <Price paise={range.lowPaise} size="sm" /> to <Price paise={range.highPaise} size="sm" /> (middle half of {range.count}).
              </>
            ) : (
              "We show a typical price range once enough similar parts are listed."
            )
          }
        />
        {saved.length ? (
          <FormSelect label="Pickup address" name="pickupAddressId" defaultValue={l.pickupAddressId ?? saved.find((a) => a.isDefault)?.id ?? ""} help="Buyers see only the town and pincode until they order.">
            {saved.map((a) => <option key={a.id} value={a.id}>{a.label ?? a.contactName}: {a.line1}, {a.city} {a.pincode}</option>)}
          </FormSelect>
        ) : (
          <p className="rounded-lg border border-caution bg-caution-tint p-3 text-caution">
            Add a pickup address first in <Link href="/account/addresses" className="underline">Account, Addresses</Link>, then come back to this step.
          </p>
        )}
        <FormSelect label="Packed weight" name="weightBand" defaultValue={l.weightBand ?? ""}>
          <option value="">Choose</option>
          {Object.entries(WEIGHTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </FormSelect>
        <FormSelect label="Packed size" name="dimensionBand" defaultValue={l.dimensionBand ?? ""}>
          <option value="">Choose</option>
          {Object.entries(SIZES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </FormSelect>
        <FormSelect label="How the buyer gets it" name="fulfilmentMode" defaultValue={pickupOnly ? "LOCAL_PICKUP" : l.fulfilmentMode} help={pickupOnly ? "Parts in this category can only be sold for local pickup." : "Delivery needs an active payout account."}>
          {pickupOnly ? null : <option value="DELIVERY">Delivery by courier</option>}
          <option value="LOCAL_PICKUP">Local pickup only</option>
        </FormSelect>
        {state.category ? (
          <section className="flex flex-col gap-1 rounded-lg border border-rule bg-surface p-3">
            <h2 className="text-lg">How to pack {state.category.name.toLowerCase()}</h2>
            <p className="prose-measure text-steel">{state.category.packagingGuide}</p>
          </section>
        ) : null}
      </ActionForm>
    </WizardFrame>
  );
}
