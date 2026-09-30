import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Checkbox } from "@/components/ui/field";
import { saveGarage } from "./actions";

type Garage = { id: string; garageName: string; addressLine: string; city: string; state: string; pincode: string; servicePincodes: string[]; capacityPerDay: number; feePerInspection: number; active: boolean };

/** Onboard or edit a partner garage: address, service area, daily capacity, fee per check, active. */
export function GarageForm({ garage }: { garage?: Garage }) {
  return (
    <ActionForm action={saveGarage} submitLabel={garage ? "Save garage" : "Add garage"}>
      {garage ? <input type="hidden" name="id" value={garage.id} /> : null}
      <FormInput label="Garage name" name="garageName" defaultValue={garage?.garageName} required />
      <FormInput label="Address" name="addressLine" defaultValue={garage?.addressLine} required />
      <div className="grid gap-3 sm:grid-cols-3">
        <FormInput label="City" name="city" defaultValue={garage?.city} required />
        <FormInput label="State" name="state" defaultValue={garage?.state} required />
        <FormInput label="Pincode" name="pincode" defaultValue={garage?.pincode} inputMode="numeric" required />
      </div>
      <FormInput label="Service pincodes (comma separated)" name="servicePincodes" defaultValue={garage?.servicePincodes.join(", ")} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormInput label="Checks per day" name="capacityPerDay" inputMode="numeric" defaultValue={String(garage?.capacityPerDay ?? 4)} />
        <FormInput label="Fee per check (paise, paid outside RePart)" name="feePerInspection" inputMode="numeric" defaultValue={String(garage?.feePerInspection ?? 0)} />
      </div>
      <Checkbox name="active" defaultChecked={garage?.active ?? true} label="Active" description="Only active garages get new Partner Checks." />
    </ActionForm>
  );
}
