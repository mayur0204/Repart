import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { FilterBar, Pager, plainParams } from "@/components/admin/list-controls";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";
import { moderateReport } from "./actions";

export const metadata: Metadata = { title: "Reports | Admin | RePart" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const targetLink = (r: { targetType: string; listingId: string | null; userId: string | null }) =>
  r.targetType === "LISTING" && r.listingId ? `/admin/listings/${r.listingId}` : r.targetType === "USER" && r.userId ? `/admin/users/${r.userId}` : null;

/**
 * Reports from members about listings, users and messages (PLAN.md §4.8). Actioned / dismissed only records the
 * decision; suspending a user or changing a listing is done with the user and listing tools.
 */
export default async function ReportsPage({ searchParams }: Props) {
  if (!(await adminPage("/admin/reports"))) return <PermissionDenied />;
  const params = plainParams(await searchParams);
  const { rows, filter: f, total, pages } = await admin.reports(params);
  return (
    <Page title="Reports" intro="Marking a report actioned or dismissed records the decision only. Use the user or listing pages to suspend an account or change a listing.">
      <FilterBar>
        <Input label="Search" name="q" defaultValue={f.q ?? ""} placeholder="Report id or target id" />
        <Select label="Status" name="status" defaultValue={f.status ?? ""}>
          <option value="">Any</option>
          <option value="OPEN">Open</option>
          <option value="ACTIONED">Actioned</option>
          <option value="DISMISSED">Dismissed</option>
        </Select>
        <Select label="About" name="targetType" defaultValue={f.targetType ?? ""}>
          <option value="">Any</option>
          <option value="LISTING">Listing</option>
          <option value="USER">User</option>
          <option value="MESSAGE">Message</option>
        </Select>
        <Input label="Reason contains" name="reason" defaultValue={f.reason ?? ""} />
        <Input label="From" name="from" type="date" defaultValue={f.from ?? ""} />
        <Input label="To" name="to" type="date" defaultValue={f.to ?? ""} />
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No matching reports" body="Reports from members appear here." />
      ) : (
        <AdminTable head={["Report", "About", "Reason", "Details", "Status", "Reported", "Handled", ""]}>
          {rows.map((r) => {
            const link = targetLink(r);
            return (
              <tr key={r.id}>
                <Td className="break-all text-sm">{r.id}</Td>
                <Td className="text-sm">
                  {r.targetType.toLowerCase()}{" "}
                  {link ? <Link href={link} className="break-all text-action underline underline-offset-4">{r.targetId}</Link> : <span className="break-all">{r.targetId}</span>}
                </Td>
                <Td className="text-sm">{r.reason}</Td>
                <Td className="max-w-64 text-sm">{r.details}</Td>
                <Td>{r.status === "OPEN" ? <Badge tone="caution">Open</Badge> : <Badge>{r.status.toLowerCase()}</Badge>}</Td>
                <Td><DateText date={r.createdAt} /></Td>
                <Td className="text-sm">{r.handledAt ? <><DateText date={r.handledAt} /> by {r.handledById}</> : null}</Td>
                <Td>
                  {r.status === "OPEN" ? (
                    <div className="flex flex-col gap-1">
                      <InlineAction action={moderateReport} label="Actioned">
                        <input type="hidden" name="reportId" value={r.id} />
                        <input type="hidden" name="decision" value="ACTIONED" />
                      </InlineAction>
                      <InlineAction action={moderateReport} label="Dismiss">
                        <input type="hidden" name="reportId" value={r.id} />
                        <input type="hidden" name="decision" value="DISMISSED" />
                      </InlineAction>
                    </div>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </AdminTable>
      )}
      <Pager path="/admin/reports" params={params} page={f.page} pages={pages} total={total} />
    </Page>
  );
}
