import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, FormSelect, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { buttonClasses } from "@/components/ui/button";
import { PartNumberText } from "@/components/ui/display";
import { Checkbox } from "@/components/ui/field";
import { PermissionDenied } from "@/components/ui/states";
import { partNumberPath } from "@/lib/slug";
import { adminPage } from "@/server/auth/current";
import { catalogueAdminService as catalogue, categories } from "@/server/services";
import { deletePartNumber, savePartNumber } from "../../actions";

export const metadata: Metadata = { title: "Part numbers | Admin | RePart" };

export default async function PartNumbersPage({ searchParams }: { searchParams: Promise<{ edit?: string; q?: string }> }) {
  if (!(await adminPage("/admin/catalogue/part-numbers"))) return <PermissionDenied />;
  const { edit, q } = await searchParams;
  const [parts, cats] = await Promise.all([catalogue.listPartNumbers(q), categories.list()]);
  const editing = edit ? parts.find((p) => p.id === edit) ?? (await catalogue.listPartNumbers()).find((p) => p.id === edit) : undefined;

  return (
    <Page title="Part numbers" intro="Spaces, dashes and letter case are ignored when matching, so SAMPLE-BRK 0001 and sample brk-0001 are the same number for one brand.">
      <section className="flex max-w-xl flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">{editing ? `Edit ${editing.display}` : "Add a part number"}</h2>
        <ActionForm
          key={editing?.id ?? "new"}
          action={savePartNumber}
          submitLabel={editing ? "Save part number" : "Add part number"}
          extraActions={editing ? <Link href="/admin/catalogue/part-numbers" className={buttonClasses("tertiary")}>Cancel</Link> : null}
        >
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          <FormInput label="Part number" name="display" defaultValue={editing?.display} help="As printed on the part or box." />
          <FormInput label="Brand" name="brand" defaultValue={editing?.brand} />
          <FormSelect label="Category" name="categoryId" defaultValue={editing?.categoryId ?? ""}>
            <option value="">Choose a category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </FormSelect>
          <Checkbox name="isOem" label="Original manufacturer (OEM) number" defaultChecked={editing?.isOem} />
        </ActionForm>
      </section>
      <form method="get" role="search" className="flex max-w-xl items-end gap-2">
        <div className="flex-1">
          <label htmlFor="pn-q" className="text-sm font-semibold">Find by number or brand</label>
          <input id="pn-q" name="q" defaultValue={q} className="mt-1 block min-h-11 w-full rounded-md border border-rule bg-surface px-3" />
        </div>
        <button type="submit" className={buttonClasses("secondary")}>Search</button>
      </form>
      <AdminTable head={["Part number", "Brand", "OEM", "Category", "Used by", ""]}>
        {parts.map((p) => (
          <tr key={p.id}>
            <Td>
              <Link href={partNumberPath(p)} className="text-action underline-offset-4 hover:underline"><PartNumberText value={p.display} /></Link>
            </Td>
            <Td>{p.brand}</Td>
            <Td>{p.isOem ? "Yes" : "No"}</Td>
            <Td>{p.category.name}</Td>
            <Td className="text-sm text-steel">{p._count.listings} listings, {p._count.fitments} fitments, {p._count.linksAsA + p._count.linksAsB} links</Td>
            <Td>
              <div className="flex gap-2">
                <Link href={`?edit=${p.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">Edit</Link>
                <InlineAction action={deletePartNumber} label="Delete"><input type="hidden" name="id" value={p.id} /></InlineAction>
              </div>
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
