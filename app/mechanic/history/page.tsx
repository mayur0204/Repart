import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { DateText } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { formatPrice } from "@/lib/format";
import { requireMemberPage } from "@/server/auth/current";
import { ForbiddenError } from "@/server/http/errors";
import { inspections } from "@/server/services";

export const metadata: Metadata = { title: "History | Mechanic | RePart" };

const OUTCOME_TEXT = { PASS: "Passed", PASS_WITH_NOTES: "Passed with notes", FAIL: "Failed" } as const;

/** History and earnings (PLAN.md §4.7): completed checks × the garage's fee per check, paid outside RePart. */
export default async function MechanicHistoryPage() {
  const user = await requireMemberPage("/mechanic/history");
  let h;
  try {
    h = await inspections.history(user.id);
  } catch (err) {
    if (err instanceof ForbiddenError) return <PermissionDenied body="This page is for RePart partner garage staff." />;
    throw err;
  }
  return (
    <Page title="History and earnings" intro={h.partner.garageName}>
      <p className="border border-rule bg-surface p-4">
        {h.completedCount} completed {h.completedCount === 1 ? "check" : "checks"} at {formatPrice(h.partner.feePerInspection)} each: <span className="font-semibold tabular-nums">{formatPrice(h.earningsPaise)}</span>
      </p>
      {h.done.length ? (
        <ul className="flex flex-col border-t border-rule">
          {h.done.map((j) => (
            <li key={j.id} className="flex flex-wrap justify-between gap-2 border-b border-rule py-3">
              <Link href={`/mechanic/jobs/${j.id}`} className="text-action underline-offset-4 hover:underline">{j.listing.title ?? j.listing.partName ?? "Part"}</Link>
              <span className="text-sm text-steel">
                {j.outcome ? OUTCOME_TEXT[j.outcome] : ""}
                {j.completedAt ? <>, <DateText date={j.completedAt} /></> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No completed checks yet" body="Submitted inspections appear here." />
      )}
    </Page>
  );
}
