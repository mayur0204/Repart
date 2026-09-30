import type { Metadata } from "next";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { FilterBar, Pager, plainParams } from "@/components/admin/list-controls";
import { Page } from "@/components/layout/page";
import { DateText } from "@/components/ui/display";
import { Input } from "@/components/ui/field";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";

export const metadata: Metadata = { title: "Audit log | Admin | RePart" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
/** before/after snapshots are already redacted when written (recordAudit); long ones are shortened for display. */
const snapshot = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/** Read-only view of the append-only audit log (PLAN.md §1.2), newest first, 50 per page. */
export default async function AuditPage({ searchParams }: Props) {
  if (!(await adminPage("/admin/audit"))) return <PermissionDenied />;
  const params = plainParams(await searchParams);
  const { rows, filter: f, total, pages } = await admin.audit(params);
  return (
    <Page title="Audit log" intro="Every recorded change, newest first. Entries can't be edited or deleted.">
      <FilterBar>
        <Input label="Actor id" name="actor" defaultValue={f.actor ?? ""} />
        <Input label="Action contains" name="action" defaultValue={f.action ?? ""} placeholder="e.g. user.suspended" />
        <Input label="Entity type" name="entityType" defaultValue={f.entityType ?? ""} placeholder="e.g. Order" />
        <Input label="Entity id" name="entityId" defaultValue={f.entityId ?? ""} />
        <Input label="From" name="from" type="date" defaultValue={f.from ?? ""} />
        <Input label="To" name="to" type="date" defaultValue={f.to ?? ""} />
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No matching entries" body="Try a wider filter." />
      ) : (
        <AdminTable head={["When", "Actor", "Action", "Entity", "Details"]}>
          {rows.map((a) => (
            <tr key={a.id}>
              <Td><DateText date={a.createdAt} /></Td>
              <Td className="break-all text-sm">{a.actorType.toLowerCase().replace("_", " ")}{a.actorId ? ` ${a.actorId}` : ""}</Td>
              <Td className="text-sm">{a.action}</Td>
              <Td className="break-all text-sm">{a.entityType} {a.entityId}</Td>
              <Td className="max-w-96 break-all text-sm text-steel">
                {a.before ? <span className="block">before {snapshot(a.before)}</span> : null}
                {a.after ? <span className="block">after {snapshot(a.after)}</span> : null}
              </Td>
            </tr>
          ))}
        </AdminTable>
      )}
      <Pager path="/admin/audit" params={params} page={f.page} pages={pages} total={total} />
    </Page>
  );
}
