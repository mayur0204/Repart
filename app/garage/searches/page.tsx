import type { Metadata } from "next";
import Link from "next/link";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, DateText } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { publicSearch } from "@/server/services";
import { deleteSavedSearch, setSearchAlerts } from "../actions";

export const metadata: Metadata = { title: "Saved searches | RePart" };

export default async function SavedSearchesPage() {
  const user = await requireMemberPage("/garage/searches");
  const searches = await publicSearch.savedSearches(user.id);
  return (
    <Page title="Saved searches" intro="With alerts on, we tell you in RePart when a new part matches.">
      {searches.length ? (
        <ul className="flex flex-col rounded-lg overflow-hidden border border-rule bg-surface">
          {searches.map((s) => {
            const params = new URLSearchParams(Object.entries(s.query as Record<string, string | number>).map(([k, v]) => [k, String(v)]));
            return (
              <li key={s.id} className="flex flex-col gap-2 border-b border-rule p-4 last:border-b-0 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col">
                  <Link href={`/search?${params.toString()}`} className="font-semibold text-action underline-offset-4 hover:underline">{s.label}</Link>
                  <span className="text-sm text-steel">Saved <DateText date={s.createdAt} />.</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.alertsEnabled ? <Badge tone="fit">Alerts on</Badge> : <Badge tone="neutral">Alerts off</Badge>}
                  <InlineAction action={setSearchAlerts} label={s.alertsEnabled ? "Turn alerts off" : "Turn alerts on"}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="enabled" value={s.alertsEnabled ? "false" : "true"} />
                  </InlineAction>
                  <InlineAction action={deleteSavedSearch} label="Delete">
                    <input type="hidden" name="id" value={s.id} />
                  </InlineAction>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No saved searches" body="Search for a part or your bike, then select Save this search." action={<ButtonLink href="/search" variant="secondary">Search parts</ButtonLink>} />
      )}
    </Page>
  );
}
