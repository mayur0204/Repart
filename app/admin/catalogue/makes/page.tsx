import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { catalogueAdminService as catalogue } from "@/server/services";
import { deleteMake, saveMake } from "../../actions";

export const metadata: Metadata = { title: "Makes | Admin | RePart" };

export default async function MakesPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  if (!(await adminPage("/admin/catalogue/makes"))) return <PermissionDenied />;
  const { edit } = await searchParams;
  const makes = await catalogue.listMakes();
  const editing = makes.find((m) => m.id === edit);

  return (
    <Page title="Makes">
      <section className="flex max-w-xl flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">{editing ? `Edit ${editing.name}` : "Add a make"}</h2>
        <ActionForm
          key={editing?.id ?? "new"}
          action={saveMake}
          submitLabel={editing ? "Save make" : "Add make"}
          extraActions={editing ? <Link href="/admin/catalogue/makes" className={buttonClasses("tertiary")}>Cancel</Link> : null}
        >
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          <FormInput label="Name" name="name" defaultValue={editing?.name} />
          <FormInput label="Slug (optional)" name="slug" defaultValue={editing?.slug} help="Used in CSV files. Made from the name if left empty." />
        </ActionForm>
      </section>
      <AdminTable head={["Name", "Slug", "Models", ""]}>
        {makes.map((m) => (
          <tr key={m.id}>
            <Td>{m.name}</Td>
            <Td className="text-steel">{m.slug}</Td>
            <Td className="num">{m._count.models}</Td>
            <Td>
              <div className="flex gap-2">
                <Link href={`?edit=${m.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">Edit</Link>
                <InlineAction action={deleteMake} label="Delete"><input type="hidden" name="id" value={m.id} /></InlineAction>
              </div>
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
