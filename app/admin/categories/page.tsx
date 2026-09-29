import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Price } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { categories } from "@/server/services";
import { deleteCategory } from "../actions";

export const metadata: Metadata = { title: "Categories | Admin | RePart" };

const TIER = { A_AUTOMATED: "A: automated", B_CONDITIONAL: "B: above a price", C_ALWAYS: "C: always" } as const;

export default async function CategoriesPage() {
  if (!(await adminPage("/admin/categories"))) return <PermissionDenied />;
  const list = await categories.list();
  return (
    <Page title="Categories" intro="Inspection tier, fees, checklists and photo guides for each kind of part." actions={<ButtonLink href="/admin/categories/new">Add a category</ButtonLink>}>
      <AdminTable head={["Category", "Inspection", "Safety", "Optional check", "Used by", ""]}>
        {list.map((c) => (
          <tr key={c.id}>
            <Td>
              {c.name}
              {c.parent ? <span className="block text-sm text-steel">in {c.parent.name}</span> : null}
            </Td>
            <Td>
              {TIER[c.inspectionTier]}
              {c.inspectionValueThreshold !== null ? <span className="block text-sm text-steel">above <Price paise={c.inspectionValueThreshold} size="sm" /></span> : null}
            </Td>
            <Td>{c.isSafetyCritical ? <Badge tone="caution">Safety-critical</Badge> : null}</Td>
            <Td>{c.optionalCheckEnabled ? <Price paise={c.optionalCheckFee} size="sm" /> : <span className="text-steel">Off</span>}</Td>
            <Td className="text-sm text-steel">{c._count.partNumbers} part numbers, {c._count.listings} listings</Td>
            <Td>
              <div className="flex gap-2">
                <Link href={`/admin/categories/${c.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">Edit</Link>
                <InlineAction action={deleteCategory} label="Delete"><input type="hidden" name="id" value={c.id} /></InlineAction>
              </div>
            </Td>
          </tr>
        ))}
      </AdminTable>
    </Page>
  );
}
