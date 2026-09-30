import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { DateText } from "@/components/ui/display";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { ForbiddenError } from "@/server/http/errors";
import { inspections } from "@/server/services";

export const metadata: Metadata = { title: "Jobs | Mechanic | RePart" };

const time = (d: Date | null) => (d ? d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

type Job = Awaited<ReturnType<typeof inspections.jobs>>["today"][number];

function JobList({ jobs }: { jobs: Job[] }) {
  return (
    <ul className="flex flex-col border-t border-rule">
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-col gap-1 border-b border-rule py-3">
          <Link href={`/mechanic/jobs/${j.id}`} className="text-lg text-action underline-offset-4 hover:underline">{j.listing.title ?? j.listing.partName ?? "Part"}</Link>
          <span className="text-sm text-steel">
            {j.slotStart ? <DateText date={j.slotStart} /> : null} {time(j.slotStart)} to {time(j.slotEnd)}
            {j.reason === "AUDIT" ? ", routine quality check" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Mechanic jobs: today and upcoming (PLAN.md §4.7). Only jobs assigned to the mechanic's garage. */
export default async function MechanicJobsPage() {
  const user = await requireMemberPage("/mechanic");
  let data;
  try {
    data = await inspections.jobs(user.id);
  } catch (err) {
    if (err instanceof ForbiddenError) return <PermissionDenied body="This page is for RePart partner garage staff." />;
    throw err;
  }
  return (
    <Page title="Jobs" intro={data.partner.garageName} actions={<ButtonLink href="/mechanic/history" variant="secondary">History</ButtonLink>}>
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Today</h2>
        {data.today.length ? <JobList jobs={data.today} /> : <EmptyState title="No checks today" body="Jobs booked for today appear here." />}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-xl">Upcoming</h2>
        {data.upcoming.length ? <JobList jobs={data.upcoming} /> : <p className="text-steel">Nothing booked yet.</p>}
      </section>
    </Page>
  );
}
