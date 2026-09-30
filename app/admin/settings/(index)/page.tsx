import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, FormTextarea } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { settings } from "@/server/services";
import { createSettingsVersion } from "../../actions";

export const metadata: Metadata = { title: "Settings | Admin | RePart" };

export default async function SettingsPage() {
  if (!(await adminPage("/admin/settings"))) return <PermissionDenied />;
  const [versions, active] = await Promise.all([settings.versions(), settings.active()]);
  return (
    <Page
      title="Settings"
      intro="Risk rules, thresholds, weights, tiers and fees. Saving creates a new inactive version; activating it is recorded in the audit log. Each risk check stores the version it used."
    >
      <AdminTable head={["Version", "Status", "Note", "Created"]}>
        {versions.map((v) => (
          <tr key={v.version}>
            <Td><Link href={`/admin/settings/versions/${v.version}`} className="num text-action underline-offset-4 hover:underline">Version {v.version}</Link></Td>
            <Td>{v.isActive ? <Badge tone="fit">Active</Badge> : <Badge tone="neutral" icon={false}>Inactive</Badge>}</Td>
            <Td className="text-sm">{v.note}</Td>
            <Td><DateText date={v.createdAt} /></Td>
          </tr>
        ))}
      </AdminTable>
      <section className="flex max-w-3xl flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">Create a new version</h2>
        <p className="text-steel">Starts from the active version ({active.version}). Change the values you need; the whole document is checked before it&apos;s saved.</p>
        <ActionForm action={createSettingsVersion} submitLabel="Save as new version">
          <FormInput label="Note" name="note" placeholder="Raise the blur threshold" />
          <FormTextarea label="Settings (JSON)" name="json" rows={24} defaultValue={JSON.stringify(active.settings, null, 2)} className="font-sans text-sm" />
        </ActionForm>
      </section>
    </Page>
  );
}
