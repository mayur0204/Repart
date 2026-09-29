import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, FormSelect, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { catalogueAdminService as catalogue } from "@/server/services";
import { deleteVariant, saveVariant } from "../../actions";

export const metadata: Metadata = { title: "Variants | Admin | RePart" };

export default async function VariantsPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  if (!(await adminPage("/admin/catalogue/variants"))) return <PermissionDenied />;
  const { edit } = await searchParams;
  const [models, variants] = await Promise.all([catalogue.listModels(), catalogue.listVariants()]);
  const editing = variants.find((v) => v.id === edit);

  return (
    <Page title="Variants" intro="A variant is a specific version of a model over a range of years.">
      <section className="flex max-w-xl flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">{editing ? `Edit ${editing.name}` : "Add a variant"}</h2>
        <ActionForm
          key={editing?.id ?? "new"}
          action={saveVariant}
          submitLabel={editing ? "Save variant" : "Add variant"}
          extraActions={editing ? <Link href="/admin/catalogue/variants" className={buttonClasses("tertiary")}>Cancel</Link> : null}
        >
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          <FormSelect label="Model" name="modelId" defaultValue={editing?.modelId ?? ""}>
            <option value="">Choose a model</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.make.name} {m.name}</option>)}
          </FormSelect>
          <FormInput label="Name" name="name" defaultValue={editing?.name} />
          <div className="grid gap-4 sm:grid-cols-3">
            <FormInput label="First year" name="yearFrom" inputMode="numeric" defaultValue={editing?.yearFrom} />
            <FormInput label="Last year (optional)" name="yearTo" inputMode="numeric" defaultValue={editing?.yearTo ?? ""} help="Empty if still made." />
            <FormInput label="Engine cc (optional)" name="engineCc" inputMode="numeric" defaultValue={editing?.engineCc ?? ""} />
          </div>
        </ActionForm>
      </section>
      <AdminTable head={["Model", "Variant", "Years", "cc", "Used by", ""]}>
        {variants.map((v) => (
          <tr key={v.id}>
            <Td>{v.model.make.name} {v.model.name}</Td>
            <Td>{v.name}</Td>
            <Td className="num">{v.yearFrom} to {v.yearTo ?? "now"}</Td>
            <Td className="num">{v.engineCc ?? ""}</Td>
            <Td className="text-sm text-steel">{v._count.fitments} fitments, {v._count.garageEntries} garage bikes</Td>
            <Td>
              <div className="flex gap-2">
                <Link href={`?edit=${v.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">Edit</Link>
                <InlineAction action={deleteVariant} label="Delete"><input type="hidden" name="id" value={v.id} /></InlineAction>
              </div>
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
