"use client";

import { useState } from "react";
import { FormInput, FormTextarea } from "@/components/forms/action-form";
import { Icon } from "@/components/ui/icon";
import { detectContactDetails } from "@/lib/listing";

/** Step 5: km, reason, and the description with a character guide and an inline contact-details warning. */
export function DetailsFields({ initial, min, max }: { initial: { km: string; reason: string; description: string }; min: number; max: number }) {
  const [text, setText] = useState(initial.description);
  const found = detectContactDetails(text);
  const length = text.trim().length;
  return (
    <div className="flex flex-col gap-4">
      <FormInput label="Kilometres used (approximate, optional)" name="kmUsedApprox" inputMode="numeric" defaultValue={initial.km} />
      <FormInput label="Reason for sale (optional)" name="reasonForSale" defaultValue={initial.reason} placeholder="Upgraded to a new part" />
      <FormTextarea
        label="Description"
        name="description"
        rows={6}
        maxLength={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        help={
          <span className="num">
            {length < min ? `${min - length} more characters needed. ` : ""}
            {length} of {max}. Say how it was used, any wear or faults, and what&apos;s included.
          </span>
        }
      />
      {found.length ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-caution bg-caution-tint p-3 text-caution">
          <Icon name="alert" className="mt-0.5 shrink-0" />
          It looks like you&apos;ve typed a {found.join(" and ")}. Remove it: buyers contact you through RePart messages, which keeps both of you protected.
        </p>
      ) : null}
    </div>
  );
}
