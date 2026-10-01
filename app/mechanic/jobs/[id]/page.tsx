import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, DateText } from "@/components/ui/display";
import { PermissionDenied } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { ForbiddenError, NotFoundError } from "@/server/http/errors";
import { inspections } from "@/server/services";

export const metadata: Metadata = { title: "Job | Mechanic | RePart" };

const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");
const OUTCOME_TEXT = { PASS: "Passed", PASS_WITH_NOTES: "Passed with notes", FAIL: "Failed" } as const;

/** Job detail (PLAN.md §4.7): address, slot, part summary and the seller's photos. */
export default async function MechanicJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireMemberPage(`/mechanic/jobs/${id}`);
  let d;
  try {
    d = await inspections.job(user.id, id);
  } catch (err) {
    if (err instanceof ForbiddenError) return <PermissionDenied body="This page is for RePart partner garage staff." />;
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const a = (d.job.locationAddress ?? {}) as { contactName?: string; line1?: string; line2?: string | null; landmark?: string | null; city?: string; pincode?: string };
  return (
    <Page title={d.listing.title} actions={<Badge>{d.job.status === "COMPLETED" && d.job.outcome ? OUTCOME_TEXT[d.job.outcome] : d.job.status === "SCHEDULED" ? "Scheduled" : d.job.status.toLowerCase().replace("_", " ")}</Badge>}>
      <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">Where and when</h2>
        {d.job.slotStart ? (
          <p>
            <DateText date={d.job.slotStart} />, {time(d.job.slotStart)} to {time(d.job.slotEnd)}
          </p>
        ) : null}
        <p>{[a.contactName, a.line1, a.line2, a.landmark, a.city, a.pincode].filter(Boolean).join(", ")}</p>
        {d.job.reason === "AUDIT" ? <p className="text-sm text-steel">Routine quality check picked by RePart.</p> : null}
      </section>
      <section className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-4">
        <h2 className="text-xl">The part</h2>
        <p>
          {d.listing.category}
          {d.listing.partNumber ? `, part number ${d.listing.partNumber}` : ""}
          {d.listing.grade ? `, seller's grade ${d.listing.grade.toLowerCase().replace("_", " ")}` : ""}
        </p>
        {d.listing.description ? <p className="text-sm">{d.listing.description}</p> : null}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {d.sellerPhotos.map((p) => (
            <li key={p.url}>
              {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage */}
              <img loading="lazy" decoding="async" src={p.url} alt={`Seller photo: ${p.shotType}`} className="aspect-square w-full rounded-lg border border-rule object-cover" />
            </li>
          ))}
        </ul>
      </section>
      {d.job.status === "SCHEDULED" ? <ButtonLink href={`/mechanic/jobs/${d.job.id}/inspect`} fullWidth>Start inspection</ButtonLink> : null}
      {d.job.completedAt ? (
        <p className="text-steel">
          Inspection submitted <DateText date={d.job.completedAt} />.
        </p>
      ) : null}
    </Page>
  );
}
