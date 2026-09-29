"use client";

import { FormInput } from "@/components/forms/action-form";

type AddressDefaults = Partial<Record<"label" | "contactName" | "contactPhone" | "line1" | "line2" | "landmark" | "city" | "state" | "pincode", string | null>>;

/** Address form fields. Labels above, help below, errors from the enclosing ActionForm. */
export function AddressFields({ defaults = {} }: { defaults?: AddressDefaults }) {
  const v = (k: keyof AddressDefaults) => defaults[k] ?? "";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormInput label="Name of contact person" name="contactName" autoComplete="name" defaultValue={v("contactName")} />
      <FormInput label="Contact mobile" name="contactPhone" type="tel" autoComplete="tel-national" defaultValue={v("contactPhone").replace(/^\+91/, "")} help="The courier calls this number." />
      <div className="sm:col-span-2">
        <FormInput label="House number and street" name="line1" autoComplete="address-line1" defaultValue={v("line1")} />
      </div>
      <FormInput label="Area (optional)" name="line2" autoComplete="address-line2" defaultValue={v("line2")} />
      <FormInput label="Landmark (optional)" name="landmark" defaultValue={v("landmark")} help="Helps the courier find you." />
      <FormInput label="Town or city" name="city" autoComplete="address-level2" defaultValue={v("city")} />
      <FormInput label="State" name="state" autoComplete="address-level1" defaultValue={v("state")} />
      <FormInput label="Pincode" name="pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} defaultValue={v("pincode")} />
      <FormInput label="Label (optional)" name="label" defaultValue={v("label")} placeholder="Home, Work" />
    </div>
  );
}
