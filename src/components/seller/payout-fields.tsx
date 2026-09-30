"use client";

import { useState } from "react";
import { FormInput, FormSelect } from "@/components/forms/action-form";
import { SegmentedControl } from "@/components/ui/choice";

/**
 * Payout details: KYC basics, then bank account OR UPI. Only the chosen method's fields are rendered,
 * so the other method is never submitted. The server validates everything again.
 */
export function PayoutFields({ defaults }: { defaults: { name: string; email: string } }) {
  const [method, setMethod] = useState<"BANK" | "UPI">("BANK");
  return (
    <div className="flex flex-col gap-4">
      <FormSelect label="You are selling as" name="accountType" defaultValue="INDIVIDUAL">
        <option value="INDIVIDUAL">An individual</option>
        <option value="BUSINESS">A business</option>
      </FormSelect>
      <FormInput label="Name as on your PAN" name="name" defaultValue={defaults.name} autoComplete="name" />
      <FormInput label="Email" name="email" type="email" defaultValue={defaults.email} autoComplete="email" help="Our payment partner sends payout updates here." />
      <FormInput label="PAN" name="pan" autoComplete="off" maxLength={10} help="Required by our payment partner to pay you. Not stored by RePart." />
      <FormInput label="GSTIN (businesses, optional)" name="gst" autoComplete="off" maxLength={15} />
      <input type="hidden" name="payoutMethod" value={method} />
      <SegmentedControl
        legend="Get paid to"
        value={method}
        onChange={setMethod}
        options={[
          { value: "BANK", label: "Bank account" },
          { value: "UPI", label: "UPI" },
        ]}
      />
      <FormInput label="Account holder's name" name="accountHolder" autoComplete="off" />
      {method === "BANK" ? (
        <>
          <FormInput label="Account number" name="accountNumber" inputMode="numeric" autoComplete="off" />
          <FormInput label="IFSC" name="ifsc" autoComplete="off" maxLength={11} help="11 characters, printed on your cheque book or passbook." />
        </>
      ) : (
        <FormInput label="UPI id" name="vpa" autoComplete="off" placeholder="name@bank" />
      )}
    </div>
  );
}
