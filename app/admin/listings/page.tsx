import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { Badge, DateText, Price } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { risk } from "@/server/services";

export const metadata: Metadata = { title: "Listing review | Admin | RePart" };

export default async function ListingReviewQueue() {
  if (!(await adminPage("/admin/listings"))) return <PermissionDenied />;
  const queue = await risk.reviewQueue();
  return (
    <Page title="Listing review" intro="Live listings that automated checks flagged: a high risk score or any soft flag. They stay live while you review them.">
      {queue.length === 0 ? (
        <EmptyState title="Nothing to review" body="Flagged listings appear here after their risk check." />
      ) : (
        <AdminTable head={["Listing", "Score", "Why it's here", "Inspection", "Live since"]}>
          {queue.map((l) => (
            <tr key={l.id}>
              <Td>
                <Link href={`/admin/listings/${l.id}`} className="text-action underline-offset-4 hover:underline">{l.title ?? "Untitled"}</Link>
                <span className="block text-sm text-steel">
                  {l.category?.name}, {l.seller.name ?? "seller"}
                  {l.pricePaise ? <>, <Price paise={l.pricePaise} size="sm" /></> : null}
                </span>
              </Td>
              <Td className="num">{l.latest.score}</Td>
              <Td className="text-sm"><ul className="flex flex-col gap-1">{l.reviewReasons.map((r) => <li key={r}>{r}</li>)}</ul></Td>
              <Td>{l.inspectionRequirement ? <Badge tone={l.inspectionRequirement === "REQUIRED" ? "caution" : "neutral"} icon={false}>{l.inspectionRequirement.replace("_", " ").toLowerCase()}</Badge> : null}</Td>
              <Td>{l.liveAt ? <DateText date={l.liveAt} /> : null}</Td>
            </tr>
          ))}
        </AdminTable>
      )}
    </Page>
  );
}
