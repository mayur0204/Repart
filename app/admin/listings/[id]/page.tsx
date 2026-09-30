import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { ActionForm, FormTextarea, InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { TrustBadge } from "@/components/listing/trust";
import { Badge, DateText, PartNumberText, Price } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { risk } from "@/server/services";
import { canTransition } from "@/server/services/listing/state";
import { StatusBadge } from "../../../seller/status";
import { keepListingLive, rejectListing, requestListingChanges } from "../../actions";

export const metadata: Metadata = { title: "Listing risk | Admin | RePart" };

type Check = { code: string; message: string; severity: string; passed: boolean; confidence: number; photoId: string | null };
type Results = { stage1: Check[]; stage2: Check[] | null; stage2Skipped: boolean; needsAdminReview: boolean; reviewReasons: string[] };

export default async function ListingRiskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await adminPage(`/admin/listings/${id}`))) return <PermissionDenied />;
  const l = await risk.detail(id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const latest = l.riskAssessments[0];
  const results = latest?.checkResults as unknown as Results | undefined;

  return (
    <Page title={l.title ?? "Untitled listing"} intro={<>{l.category?.name}, sold by {l.seller.name ?? "a seller"}. {l.pricePaise ? <Price paise={l.pricePaise} size="sm" /> : null}</>}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={l.status} />
        <TrustBadge label={l.trustLabel} />
        {l.inspectionRequirement ? <Badge tone="neutral" icon={false}>Inspection: {l.inspectionRequirement.toLowerCase().replace("_", " ")}{l.inspectionReason ? ` (${l.inspectionReason})` : ""}</Badge> : null}
        {l.partNumber ? <span className="text-sm">Part number <PartNumberText value={l.partNumber.display} /> ({l.partNumber.brand}){l.partNumber.isSample ? ", SAMPLE" : ""}</span> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <section className="flex flex-col gap-3 lg:col-span-8">
          <h2 className="text-xl">Latest risk check</h2>
          {latest && results ? (
            <>
              <p className="num text-steel">
                Score {latest.score}. {latest.routingDecision === "LIVE" ? "Routed live" : "Changes requested"}. Rule set version {latest.ruleSetVersion}, vision model {latest.visionModelVersion ?? "not run"}. <DateText date={latest.createdAt} />.
              </p>
              <AdminTable head={["Check", "Result", "Severity", "Detail"]}>
                {[...results.stage1, ...(results.stage2 ?? [])].map((c, i) => (
                  <tr key={`${c.code}-${i}`}>
                    <Td className="text-sm">{c.code}</Td>
                    <Td>{c.passed ? <Badge tone="fit">Passed</Badge> : <Badge tone={c.severity === "HARD" ? "danger" : "caution"}>Failed</Badge>}</Td>
                    <Td className="text-sm">{c.severity}{c.confidence < 1 ? `, confidence ${c.confidence.toFixed(2)}` : ""}</Td>
                    <Td className="text-sm">{c.message}</Td>
                  </tr>
                ))}
              </AdminTable>
              {results.stage2Skipped ? <p className="text-sm text-steel">Vision checks were skipped because Stage 1 had hard failures.</p> : null}
            </>
          ) : (
            <p className="text-steel">No risk check has run for this listing yet.</p>
          )}
          {l.riskAssessments.length > 1 ? <p className="text-sm text-steel">{l.riskAssessments.length - 1} earlier check(s) are kept for the record.</p> : null}

          <h2 className="text-xl">Photos</h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {l.photos.map((p, i) => (
              <li key={p.id} className="flex flex-col gap-1 text-sm">
                {p.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
                  <img loading="lazy" decoding="async" src={p.url} alt={`Photo ${i + 1}, ${p.shotType}`} className="aspect-square w-full border border-rule object-cover" />
                ) : (
                  <span className="flex aspect-square items-center justify-center border border-rule text-steel">Not available</span>
                )}
                <span className="num text-steel">
                  Photo {i + 1}: {p.width}×{p.height}, blur {p.blurScore?.toFixed(0)}, brightness {p.brightnessScore?.toFixed(0)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="flex flex-col gap-4 lg:col-span-4">
          {results?.needsAdminReview ? (
            <section className="flex flex-col gap-2 border border-caution bg-caution-tint p-3 text-caution">
              <h2 className="text-lg">Why it was flagged</h2>
              <ul className="flex flex-col gap-1 text-sm">{results.reviewReasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </section>
          ) : null}
          {l.status === "LIVE" ? (
            <InlineAction action={keepListingLive} label="Keep live, remove from queue" variant="secondary">
              <input type="hidden" name="listingId" value={l.id} />
            </InlineAction>
          ) : null}
          {canTransition(l.status, "adminRequestChanges") ? (
            <ActionForm action={requestListingChanges} submitLabel="Request changes" submitVariant="secondary">
              <input type="hidden" name="listingId" value={l.id} />
              <FormTextarea label="What the seller must fix" name="reason" rows={3} help="Shown to the seller. Say exactly what to change." />
            </ActionForm>
          ) : null}
          {canTransition(l.status, "adminReject") ? (
            <ActionForm action={rejectListing} submitLabel="Reject listing" submitVariant="danger">
              <input type="hidden" name="listingId" value={l.id} />
              <FormTextarea label="Reason for rejecting" name="reason" rows={3} help="Shown to the seller. Rejection can't be undone." />
            </ActionForm>
          ) : null}
          <section className="flex flex-col gap-1">
            <h2 className="text-lg">History</h2>
            <ul className="flex flex-col text-sm">
              {l.events.map((e) => (
                <li key={e.id} className="border-b border-rule py-1">
                  {e.event}: {e.fromStatus ?? "new"} to {e.toStatus} by {e.actorType.toLowerCase()}, <DateText date={e.createdAt} />
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </Page>
  );
}
