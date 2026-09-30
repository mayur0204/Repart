import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { catalogueAdminService as catalogue } from "@/server/services";

export const metadata: Metadata = { title: "Catalogue | Admin | RePart" };

export default async function CatalogueHome() {
  if (!(await adminPage("/admin/catalogue"))) return <PermissionDenied />;
  const [makes, models, variants, parts] = await Promise.all([catalogue.listMakes(), catalogue.listModels(), catalogue.listVariants(), catalogue.listPartNumbers()]);
  const sections = [
    { href: "/admin/catalogue/makes", label: "Makes", count: makes.length },
    { href: "/admin/catalogue/models", label: "Models", count: models.length },
    { href: "/admin/catalogue/variants", label: "Variants", count: variants.length },
    { href: "/admin/catalogue/part-numbers", label: "Part numbers", count: parts.length, note: parts.length >= 200 ? "200 or more" : undefined },
    { href: "/admin/catalogue/import", label: "CSV import", note: "Add or update many rows at once, with a dry run first." },
  ];
  return (
    <Page title="Catalogue" intro="Vehicles and part numbers used for fit checks. Every change is recorded in the audit log.">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="flex min-h-11 flex-col gap-1 border border-rule bg-surface p-4 hover:border-ink">
              <span className="font-semibold text-action">{s.label}</span>
              <span className="text-sm text-steel">{s.note ?? <span className="num">{s.count} rows</span>}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
