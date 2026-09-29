import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { imports } from "@/server/services";
import { applyImport } from "../../../actions";
import { KIND_LABELS, StatusBadge } from "../status";

export const metadata: Metadata = { title: "Import report | Admin | RePart" };

const ACTION_LABEL = { create: "Add", update: "Update", unchanged: "No change", error: "Problem" } as const;

export default async function ImportReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/catalogue/import/${id}`))) return <PermissionDenied />;
  const row = await imports.get(id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const report = row.report;
  const problems = report?.rows.filter((r) => r.action === "error") ?? [];
  const changes = report?.rows.filter((r) => r.action === "create" || r.action === "update") ?? [];

  return (
    <Page title={row.fileName} intro={<>{KIND_LABELS[row.kind]}, uploaded <DateText date={row.createdAt} />.</>}>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={row.status} />
        {report ? (
          <span className="num text-steel">
            {report.rowCount} rows: {report.counts.create} to add, {report.counts.update} to update, {report.counts.unchanged} unchanged, {report.errorCount} with problems
          </span>
        ) : null}
      </div>

      {row.status === "VALIDATED" ? (
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4">
          <p className="prose-measure">
            This was a dry run. Applying checks the file again against the current catalogue and saves every row in one step. If any row has
            become invalid, nothing is saved.
          </p>
          <InlineAction action={applyImport} label="Apply import" variant="primary"><input type="hidden" name="id" value={row.id} /></InlineAction>
        </section>
      ) : null}
      {row.status === "FAILED" ? <p className="prose-measure text-danger">Fix the problems below in your file, then upload it again.</p> : null}
      {row.status === "APPLIED" && row.appliedAt ? <p className="text-steel">Applied on <DateText date={row.appliedAt} />.</p> : null}

      {report?.headerErrors.length ? (
        <ul className="flex flex-col gap-1 border border-danger bg-danger-tint p-3 text-danger" role="alert">
          {report.headerErrors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      ) : null}

      {problems.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">Problems</h2>
          <AdminTable head={["Line", "Row", "What to fix"]}>
            {problems.map((r) => (
              <tr key={r.line}>
                <Td className="num">{r.line}</Td>
                <Td className="text-sm">{r.key}</Td>
                <Td><ul>{r.errors.map((e) => <li key={e} className="text-danger">{e}</li>)}</ul></Td>
              </tr>
            ))}
          </AdminTable>
        </section>
      ) : null}

      {changes.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xl">{row.status === "APPLIED" ? "Changes made" : "Changes this import will make"}</h2>
          <AdminTable head={["Line", "Row", "Change"]}>
            {changes.slice(0, 500).map((r) => (
              <tr key={r.line}>
                <Td className="num">{r.line}</Td>
                <Td className="text-sm">{r.key}</Td>
                <Td><Badge tone={r.action === "create" ? "fit" : "neutral"} icon={false}>{ACTION_LABEL[r.action]}</Badge></Td>
              </tr>
            ))}
          </AdminTable>
          {changes.length > 500 ? <p className="text-sm text-steel">Showing the first 500 of {changes.length} changes.</p> : null}
        </section>
      ) : null}
    </Page>
  );
}
