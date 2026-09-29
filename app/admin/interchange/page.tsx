import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormInput, FormSelect, FormTextarea, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText, PartNumberText } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { partNumberPath } from "@/lib/slug";
import { adminPage } from "@/server/auth/current";
import { interchange } from "@/server/services";
import { SOURCE_LABELS } from "@/server/services/interchange/graph";
import { createLink, reviewLink } from "../actions";

export const metadata: Metadata = { title: "Interchange | Admin | RePart" };

const TYPE_LABELS = { EXACT_EQUIVALENT: "Same part", SUPERSEDED_BY: "A is replaced by B", FITS_WITH_MODIFICATION: "Fits with modification" } as const;

function Part({ p }: { p: { display: string; brand: string; category: { name: string; isSafetyCritical: boolean } } }) {
  return (
    <span className="flex flex-col">
      <Link href={partNumberPath(p)} className="text-action underline-offset-4 hover:underline"><PartNumberText value={p.display} /></Link>
      <span className="text-sm text-steel">{p.brand}, {p.category.name}</span>
    </span>
  );
}

export default async function InterchangeAdminPage() {
  if (!(await adminPage("/admin/interchange"))) return <PermissionDenied />;
  const queue = await interchange.reviewQueue();

  return (
    <Page title="Interchange" intro="Links between part numbers. Only approved same-part and replacement links form groups. In safety-critical categories only manufacturer-catalogue and mechanic-confirmed links count.">
      <section className="flex flex-col gap-3">
        <h2 className="text-xl">Review queue</h2>
        {queue.length === 0 ? (
          <EmptyState title="Nothing to review" body="User suggestions and links flagged by failed fits appear here." />
        ) : (
          <AdminTable head={["A", "Relation", "B", "Source", "Why it's here", ""]}>
            {queue.map((l) => (
              <tr key={l.id}>
                <Td><Part p={l.partNumberA} /></Td>
                <Td>
                  {TYPE_LABELS[l.type]}
                  {l.notes ? <span className="block text-sm text-steel">{l.notes}</span> : null}
                </Td>
                <Td><Part p={l.partNumberB} /></Td>
                <Td className="text-sm">{SOURCE_LABELS[l.source]}</Td>
                <Td className="text-sm">
                  {l.inReviewQueue ? <Badge tone="danger">Flagged {l.flaggedCount} time(s)</Badge> : <Badge tone="caution">Suggested</Badge>}
                  <span className="mt-1 block text-steel"><DateText date={l.createdAt} /></span>
                </Td>
                <Td>
                  <div className="flex flex-col items-start">
                    {l.status !== "APPROVED" ? (
                      <InlineAction action={reviewLink} label="Approve"><input type="hidden" name="id" value={l.id} /><input type="hidden" name="decision" value="APPROVE" /></InlineAction>
                    ) : (
                      <InlineAction action={reviewLink} label="Keep link"><input type="hidden" name="id" value={l.id} /><input type="hidden" name="decision" value="CLEAR_FLAG" /></InlineAction>
                    )}
                    <InlineAction action={reviewLink} label="Reject"><input type="hidden" name="id" value={l.id} /><input type="hidden" name="decision" value="REJECT" /></InlineAction>
                  </div>
                </Td>
              </tr>
            ))}
          </AdminTable>
        )}
      </section>

      <section className="flex max-w-2xl flex-col gap-3 border border-rule bg-surface p-4">
        <h2 className="text-xl">Add an approved link</h2>
        <ActionForm action={createLink} submitLabel="Add link">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormInput label="A brand" name="aBrand" />
            <FormInput label="A part number" name="aNumber" />
            <FormInput label="B brand" name="bBrand" />
            <FormInput label="B part number" name="bNumber" />
          </div>
          <FormSelect label="Relation" name="type" defaultValue="">
            <option value="">Choose</option>
            {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </FormSelect>
          <FormSelect label="Source" name="source" defaultValue="">
            <option value="">Choose</option>
            {(["OEM_CATALOGUE", "BRAND_CROSS_REFERENCE", "MECHANIC_CONFIRMED", "ADMIN"] as const).map((s) => <option key={s} value={s}>{SOURCE_LABELS[s]}</option>)}
          </FormSelect>
          <FormTextarea label="Notes" name="notes" rows={3} help="Required for fits with modification: say exactly what has to change." />
        </ActionForm>
      </section>
    </Page>
  );
}
