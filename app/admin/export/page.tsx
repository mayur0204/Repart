import type { Metadata } from "next";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { EXPORT_COLUMNS } from "@/server/services/admin/admin";

export const metadata: Metadata = { title: "Export | Admin | RePart" };

/** Training-data CSV export (brief §5): listing → photos → risk assessment → inspection → order outcome. */
export default async function ExportPage() {
  if (!(await adminPage("/admin/export"))) return <PermissionDenied />;
  return (
    <Page title="Training-data export" intro="One row per listing (drafts left out), with its photos' storage keys and quality measures, the latest risk assessment, the latest inspection and the latest order outcome. Every download is recorded in the audit log.">
      <div className="flex flex-wrap gap-3">
        <ButtonLink href="/api/admin/export/training.csv">Download CSV</ButtonLink>
        <ButtonLink href="/api/admin/export/training.csv?includeSample=true" variant="secondary">Download including sample data</ButtonLink>
      </div>
      <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
        <h2 className="text-xl">Columns</h2>
        <p className="text-sm text-steel">Fixed order. Photo fields list one value per photo, separated by a vertical bar, in the listing&apos;s photo order. Empty cells mean the value doesn&apos;t exist.</p>
        <ol className="list-decimal pl-6 text-sm">
          {EXPORT_COLUMNS.map((c) => <li key={c}>{c}</li>)}
        </ol>
      </section>
    </Page>
  );
}
