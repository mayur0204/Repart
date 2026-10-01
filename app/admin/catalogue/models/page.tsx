import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, FormSelect, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { catalogueAdminService as catalogue } from "@/server/services";
import { deleteModel, saveModel } from "../../actions";

export const metadata: Metadata = { title: "Models | Admin | RePart" };

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  if (!(await adminPage("/admin/catalogue/models"))) return <PermissionDenied />;
  const { edit } = await searchParams;
  const [makes, models] = await Promise.all([catalogue.listMakes(), catalogue.listModels()]);
  const editing = models.find((m) => m.id === edit);

  return (
    <Page title="Models">
      <section className="flex max-w-xl flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">{editing ? `Edit ${editing.make.name} ${editing.name}` : "Add a model"}</h2>
        <ActionForm
          key={editing?.id ?? "new"}
          action={saveModel}
          submitLabel={editing ? "Save model" : "Add model"}
          extraActions={editing ? <Link href="/admin/catalogue/models" className={buttonClasses("tertiary")}>Cancel</Link> : null}
        >
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          <FormSelect label="Make" name="makeId" defaultValue={editing?.makeId ?? ""}>
            <option value="">Choose a make</option>
            {makes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </FormSelect>
          <FormInput label="Name" name="name" defaultValue={editing?.name} />
          <FormInput label="Slug (optional)" name="slug" defaultValue={editing?.slug} />
          <FormSelect label="Type" name="vehicleType" defaultValue={editing?.vehicleType ?? ""}>
            <option value="">Choose a type</option>
            <option value="MOTORCYCLE">Motorcycle</option>
            <option value="SCOOTER">Scooter</option>
          </FormSelect>
        </ActionForm>
      </section>
      <AdminTable head={["Make", "Model", "Slug", "Type", "Variants", ""]}>
        {models.map((m) => (
          <tr key={m.id}>
            <Td>{m.make.name}</Td>
            <Td>{m.name}</Td>
            <Td className="text-steel">{m.slug}</Td>
            <Td>{m.vehicleType === "SCOOTER" ? "Scooter" : m.vehicleType === "MOTORCYCLE" ? "Motorcycle" : "Car"}</Td>
            <Td className="num">{m._count.variants}</Td>
            <Td>
              <div className="flex gap-2">
                <Link href={`?edit=${m.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">Edit</Link>
                <InlineAction action={deleteModel} label="Delete"><input type="hidden" name="id" value={m.id} /></InlineAction>
              </div>
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
