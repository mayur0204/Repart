import { FormSelect } from "@/components/forms/action-form";
import { formatPrice } from "@/lib/format";

type Option = { value: string; garageName: string; servicePincodes: string[]; feePerInspection: number; slotStart: Date; free: number; capacity: number };

const when = (d: Date) => d.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** Only eligible (active, serves the pincode, has capacity that day) garage + slot pairs are offered; the server re-checks. */
export function GarageChoice({ options }: { options: Option[] }) {
  if (!options.length) return <p className="text-sm text-danger">No eligible garage has capacity in the next few days.</p>;
  return (
    <FormSelect label="Garage and slot" name="choice" defaultValue="">
      <option value="" disabled>Choose a garage and slot</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {`${o.garageName}, ${when(o.slotStart)}, ${o.free} of ${o.capacity} free, fee ${formatPrice(o.feePerInspection)} (serves ${o.servicePincodes.join(", ")})`}
        </option>
      ))}
    </FormSelect>
  );
}
