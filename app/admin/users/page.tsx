import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { FilterBar, Pager, plainParams } from "@/components/admin/list-controls";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";

export const metadata: Metadata = { title: "Users | Admin | RePart" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Users: search by id, phone or email; filter by role and status (PLAN.md §4.8). */
export default async function UsersPage({ searchParams }: Props) {
  if (!(await adminPage("/admin/users"))) return <PermissionDenied />;
  const params = plainParams(await searchParams);
  const { rows, filter: f, total, pages } = await admin.users(params);
  return (
    <Page title="Users">
      <FilterBar>
        <Input label="Search" name="q" defaultValue={f.q ?? ""} placeholder="User id, phone or email" />
        <Select label="Role" name="role" defaultValue={f.role ?? ""}>
          <option value="">Any</option>
          <option value="MEMBER">Member</option>
          <option value="MECHANIC">Mechanic</option>
          <option value="ADMIN">Admin</option>
        </Select>
        <Select label="Status" name="status" defaultValue={f.status ?? ""}>
          <option value="">Any</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="DELETED">Deleted</option>
        </Select>
        <Select label="Sort" name="sort" defaultValue={f.sort}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </Select>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No matching users" body="Try a different search." />
      ) : (
        <AdminTable head={["User", "Phone", "Email", "Roles", "Status", "Joined"]}>
          {rows.map((u) => (
            <tr key={u.id}>
              <Td>
                <Link href={`/admin/users/${u.id}`} className="text-action underline-offset-4 hover:underline">{u.name ?? "Unnamed"}</Link>
                <span className="block break-all text-sm text-steel">{u.id}</span>
                {u.isSample ? <Badge>Sample</Badge> : null}
              </Td>
              <Td className="text-sm">{u.phone}</Td>
              <Td className="text-sm">{u.email ?? ""}</Td>
              <Td className="text-sm">{u.roles.map((r) => r.toLowerCase()).join(", ")}</Td>
              <Td>{u.status === "ACTIVE" ? <Badge tone="fit">Active</Badge> : <Badge tone="danger">{u.status.toLowerCase()}</Badge>}</Td>
              <Td><DateText date={u.createdAt} /></Td>
            </tr>
          ))}
        </AdminTable>
      )}
      <Pager path="/admin/users" params={params} page={f.page} pages={pages} total={total} />
    </Page>
  );
}
