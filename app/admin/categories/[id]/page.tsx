import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, FormInput, FormSelect, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/field";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { categories } from "@/server/services";
import { saveCategory } from "../../actions";

export const metadata: Metadata = { title: "Edit category | Admin | RePart" };

const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? "" : String(paise / 100));

const CHECKLIST_EXAMPLE = '[{"id":"cracks","question":"Are there any cracks?","weight":40,"badAnswer":"YES","blocksListing":false}]';
const PHOTO_EXAMPLE = '[{"shotType":"front","label":"Front","instructions":"Whole part, in daylight.","required":true}]';

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/categories/${id}`))) return <PermissionDenied />;
  const isNew = id === "new";
  const [all, c] = await Promise.all([
    categories.list(),
    isNew
      ? null
      : categories.get(id).catch((err) => {
          if (err instanceof NotFoundError) notFound();
          throw err;
        }),
  ]);

  return (
    <Page title={c ? `Edit ${c.name}` : "Add a category"} narrow>
      <ActionForm action={saveCategory} submitLabel="Save category" extraActions={<Link href="/admin/categories" className={buttonClasses("tertiary")}>Cancel</Link>}>
        <input type="hidden" name="id" value={c?.id ?? ""} />
        <FormInput label="Name" name="name" defaultValue={c?.name} />
        <FormInput label="Slug (optional)" name="slug" defaultValue={c?.slug} help="Used in CSV files and URLs. Made from the name if left empty." />
        <FormSelect label="Parent category (optional)" name="parentId" defaultValue={c?.parentId ?? ""}>
          <option value="">None</option>
          {all.filter((x) => x.id !== c?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </FormSelect>
        <FormInput label="Sort order" name="sortOrder" inputMode="numeric" defaultValue={c?.sortOrder ?? 0} />
        <Checkbox name="isSafetyCritical" label="Safety-critical" description="Only manufacturer-catalogue and mechanic-confirmed links count for fit. Needs Tier B or C." defaultChecked={c?.isSafetyCritical} />
        <FormSelect label="Inspection tier" name="inspectionTier" defaultValue={c?.inspectionTier ?? "A_AUTOMATED"}>
          <option value="A_AUTOMATED">A: automated checks only</option>
          <option value="B_CONDITIONAL">B: inspection above a price</option>
          <option value="C_ALWAYS">C: always inspected</option>
        </FormSelect>
        <FormInput label="Tier B price threshold (₹)" name="inspectionValueThresholdRupees" inputMode="decimal" defaultValue={rupees(c?.inspectionValueThreshold)} help="Tier B only. Parts priced above this are inspected." />
        <FormInput label="Optional check fee (₹)" name="optionalCheckFeeRupees" inputMode="decimal" defaultValue={rupees(c?.optionalCheckFee ?? 0)} />
        <Checkbox name="optionalCheckEnabled" label="Buyers can add an optional check" defaultChecked={c?.optionalCheckEnabled ?? true} />
        <FormSelect label="Shipping" name="shippingRestriction" defaultValue={c?.shippingRestriction ?? "NONE"}>
          <option value="NONE">No restriction</option>
          <option value="FRAGILE">Fragile</option>
          <option value="OVERSIZE">Oversize</option>
          <option value="NOT_SHIPPABLE">Local pickup only</option>
        </FormSelect>
        <FormTextarea label="Packaging guide" name="packagingGuide" defaultValue={c?.packagingGuide} />
        <FormInput label="Where to find the part number (optional)" name="partNumberHint" defaultValue={c?.partNumberHint ?? ""} />
        <FormTextarea
          label="Condition checklist (JSON)"
          name="conditionChecklist"
          rows={8}
          defaultValue={c ? JSON.stringify(c.conditionChecklist, null, 2) : CHECKLIST_EXAMPLE}
          help="A list of questions. weight is deducted from 100 when the bad answer is given."
        />
        <FormTextarea label="Photo guide (JSON)" name="photoGuide" rows={8} defaultValue={c ? JSON.stringify(c.photoGuide, null, 2) : PHOTO_EXAMPLE} help="The shots sellers are asked for." />
      </ActionForm>
    </Page>
  );
}
