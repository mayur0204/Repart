import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { settings } from "@/server/services";
import { diffSettings, SettingsError } from "@/server/services/settings/settings";
import { activateSettingsVersion } from "../../../actions";

export const metadata: Metadata = { title: "Settings version | Admin | RePart" };

const show = (v: unknown) => (v === undefined ? "(not set)" : JSON.stringify(v));

export default async function SettingsVersionPage({ params }: { params: Promise<{ v: string }> }) {
  const { v } = await params;
  const version = Number(v);
  if (!(await adminPage(`/admin/settings/versions/${v}`))) return <PermissionDenied />;
  if (!Number.isInteger(version) || version < 1) notFound();
  const [snapshot, active] = await Promise.all([
    settings.version(version).catch((err) => {
      if (err instanceof SettingsError) notFound();
      throw err;
    }),
    settings.active(),
  ]);
  const changes = diffSettings(active.settings, snapshot.settings);
  const isActive = active.version === version;

  return (
    <Page title={`Settings version ${version}`} intro={isActive ? "This is the active version." : `Compared with the active version ${active.version}.`}>
      {!isActive ? (
        <InlineAction action={activateSettingsVersion} label={`Activate version ${version}`} variant="primary">
          <input type="hidden" name="version" value={version} />
        </InlineAction>
      ) : null}
      {!isActive ? (
        changes.length ? (
          <AdminTable head={["Setting", `Active (v${active.version})`, `This version (v${version})`]}>
            {changes.map((c) => (
              <tr key={c.path}>
                <Td className="text-sm">{c.path}</Td>
                <Td className="num text-sm">{show(c.before)}</Td>
                <Td className="num text-sm">{show(c.after)}</Td>
              </tr>
            ))}
          </AdminTable>
        ) : (
          <p className="text-steel">No differences from the active version.</p>
        )
      ) : null}
      <details className="border border-rule bg-surface p-3">
        <summary className="cursor-pointer font-semibold">All values</summary>
        <pre className="mt-2 overflow-x-auto font-sans text-sm whitespace-pre">{JSON.stringify(snapshot.settings, null, 2)}</pre>
      </details>
    </Page>
  );
}
