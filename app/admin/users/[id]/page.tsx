import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { admin } from "@/server/services";
import { changeUserRole, changeUserStatus } from "../actions";

export const metadata: Metadata = { title: "User | Admin | RePart" };

/** One user: details, roles (grant/revoke MECHANIC, ADMIN), suspend/unsuspend, seller and mechanic links, history. */
export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/users/${id}`))) return <PermissionDenied />;
  let u;
  try {
    u = await admin.user(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  return (
    <Page title={u.name ?? "Unnamed user"} intro={u.id} actions={u.status === "ACTIVE" ? <Badge tone="fit">Active</Badge> : <Badge tone="danger">{u.status.toLowerCase()}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 border border-rule bg-surface p-4 text-sm">
          <h2 className="text-xl">Account</h2>
          <p>Phone {u.phone}{u.email ? `, email ${u.email}` : ""}</p>
          <p>
            Joined <DateText date={u.createdAt} />
            {u.isSample ? ", sample account" : ""}
          </p>
          <p>
            {u._count.listings} listings, {u._count.buyerOrders} purchases, {u._count.sellerOrders} sales
          </p>
          <p>Seller payouts: {u.payoutAccount ? `${u.payoutAccount.status.toLowerCase().replace(/_/g, " ")}${u.payoutAccount.providerVendorId ? ` (vendor ${u.payoutAccount.providerVendorId})` : ""}` : "not set up"}</p>
          <p>
            Garage:{" "}
            {u.mechanicStaff ? (
              <>
                <Link href={`/admin/mechanics/${u.mechanicStaff.partner.id}`} className="text-action underline underline-offset-4">{u.mechanicStaff.partner.garageName}</Link>
                {u.mechanicStaff.active ? "" : " (inactive link)"}
              </>
            ) : (
              "none"
            )}
          </p>
        </section>
        <section className="flex flex-col gap-3 border border-rule bg-surface p-4">
          <h2 className="text-xl">Roles</h2>
          <p className="text-sm">{u.roles.map((r) => r.toLowerCase()).join(", ")}</p>
          <div className="flex flex-wrap gap-2">
            {(["MECHANIC", "ADMIN"] as const).map((role) => {
              const has = u.roles.includes(role);
              return (
                <InlineAction key={role} action={changeUserRole} label={has ? `Remove ${role.toLowerCase()}` : `Make ${role.toLowerCase()}`} variant="secondary">
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="role" value={role} />
                  <input type="hidden" name="grant" value={has ? "false" : "true"} />
                </InlineAction>
              );
            })}
          </div>
          <p className="text-sm text-steel">Mechanic garage links are managed on the Mechanics pages. The last active admin can&apos;t be removed.</p>
          <h2 className="text-xl">Status</h2>
          {u.status === "DELETED" ? (
            <p className="text-sm">Deleted accounts can&apos;t be changed here.</p>
          ) : (
            <ActionForm action={changeUserStatus} submitLabel={u.status === "SUSPENDED" ? "Restore account" : "Suspend account"} submitVariant="secondary">
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="status" value={u.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED"} />
              <FormInput label="Reason (recorded in the audit log)" name="reason" required />
              {u.status !== "SUSPENDED" ? <p className="text-sm text-steel">A suspended user is signed out on their next request and can&apos;t sign in.</p> : null}
            </ActionForm>
          )}
        </section>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">History</h2>
        <AdminTable head={["When", "Action", "Entity", "By"]}>
          {u.audit.map((a) => (
            <tr key={a.id}>
              <Td><DateText date={a.createdAt} /></Td>
              <Td className="text-sm">{a.action}</Td>
              <Td className="break-all text-sm">{a.entityType} {a.entityId}</Td>
              <Td className="text-sm">{a.actorType.toLowerCase().replace("_", " ")}</Td>
            </tr>
          ))}
        </AdminTable>
        <Link href={`/admin/audit?entityType=User&entityId=${u.id}`} className="text-action underline underline-offset-4">Full audit log for this user</Link>
      </section>
    </Page>
  );
}
