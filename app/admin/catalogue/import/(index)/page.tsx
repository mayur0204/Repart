import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormSelect } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { imports } from "@/server/services";
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS } from "@/server/services/catalogue/import";
import { uploadImport } from "../../../actions";
import { KIND_LABELS, StatusBadge } from "../status";

export const metadata: Metadata = { title: "CSV import | Admin | RePart" };

export default async function ImportPage() {
  if (!(await adminPage("/admin/catalogue/import"))) return <PermissionDenied />;
  const history = await imports.list();

  return (
    <Page
      title="CSV import"
      intro="Upload a file to check it first. Nothing changes until you review the report and select Apply import. Rows are added or updated, never deleted."
    >
      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4 lg:col-span-5">
          <h2 className="text-xl">Check a file</h2>
          <ActionForm action={uploadImport} submitLabel="Upload and check">
            <FormSelect label="The file contains" name="kind" defaultValue="">
              <option value="">Choose</option>
              {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </FormSelect>
            <div className="flex flex-col gap-1">
              <label htmlFor="csv-file" className="text-sm font-semibold">CSV file</label>
              <input id="csv-file" name="file" type="file" accept=".csv,text/csv" className="min-h-11 rounded-md border border-rule bg-surface p-2" />
              <p className="text-sm text-steel">UTF-8, first row is the header, up to {MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows and 1 MB.</p>
            </div>
          </ActionForm>
          <p className="text-sm text-steel">Import in this order so references resolve: makes, models, variants, part numbers, then interchange and fitments.</p>
        </section>
        <section className="flex flex-col gap-3 lg:col-span-7">
          <h2 className="text-xl">Column formats</h2>
          <dl className="flex flex-col rounded-lg overflow-hidden border border-rule bg-surface">
            {Object.entries(IMPORT_COLUMNS).map(([kind, spec]) => (
              <div key={kind} className="border-b border-rule p-3 last:border-b-0">
                <dt className="font-semibold">{KIND_LABELS[kind as keyof typeof KIND_LABELS]}</dt>
                <dd className="text-sm text-steel">
                  Required: {spec.required.join(", ")}. {spec.optional.length ? `Optional: ${spec.optional.join(", ")}.` : ""}
                  <pre className="mt-1 overflow-x-auto bg-page p-2 font-sans text-sm whitespace-pre text-ink">{spec.example}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl">Recent imports</h2>
        <AdminTable head={["File", "Contains", "Status", "Rows", "Problems", "Uploaded"]}>
          {history.map((h) => (
            <tr key={h.id}>
              <Td><Link href={`/admin/catalogue/import/${h.id}`} className="text-action underline-offset-4 hover:underline">{h.fileName}</Link></Td>
              <Td>{KIND_LABELS[h.kind]}</Td>
              <Td><StatusBadge status={h.status} /></Td>
              <Td className="num">{h.rowCount}</Td>
              <Td className="num">{h.errorCount > 0 ? <Badge tone="danger">{h.errorCount}</Badge> : 0}</Td>
              <Td><DateText date={h.createdAt} /></Td>
            </tr>
          ))}
        </AdminTable>
      </section>
    </Page>
  );
}
