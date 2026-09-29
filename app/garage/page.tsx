import type { Metadata } from "next";
import Link from "next/link";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { requireMemberPage } from "@/server/auth/current";
import { garage } from "@/server/services";
import { MAX_GARAGE_VEHICLES } from "@/server/services/garage/garage";
import { removeVehicle, setPrimaryVehicle } from "./actions";

export const metadata: Metadata = { title: "Your garage | RePart" };

export default async function GaragePage() {
  const user = await requireMemberPage("/garage");
  const vehicles = await garage.list(user.id);

  return (
    <Page
      title="Your garage"
      intro="Your primary bike is used to check fit on every listing."
      actions={vehicles.length > 0 && vehicles.length < MAX_GARAGE_VEHICLES ? <ButtonLink href="/garage/add">Add a bike</ButtonLink> : null}
    >
      {vehicles.length === 0 ? (
        <EmptyState
          title="No bikes yet"
          body="Add the bike you ride and we'll show which parts fit it."
          action={<ButtonLink href="/garage/add">Add a bike</ButtonLink>}
        />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {vehicles.map((v) => (
            <li key={v.id} className="flex flex-col gap-2 border border-rule bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg">
                  {v.variant.model.make.name} {v.variant.model.name}
                </h2>
                {v.isPrimary ? <Badge tone="fit">Primary</Badge> : null}
              </div>
              <p className="text-steel">
                {v.variant.name}, <span className="num">{v.year}</span>
                {v.nickname ? <>. {v.nickname}</> : null}
              </p>
              <p className="text-sm text-steel">Parts that fit this bike appear here once search is live.</p>
              <div className="flex flex-wrap gap-2">
                <Link href={`/garage/${v.id}`} className="inline-flex min-h-11 items-center px-1 text-action underline-offset-4 hover:underline">
                  Edit
                </Link>
                {!v.isPrimary ? (
                  <InlineAction action={setPrimaryVehicle} label="Make primary">
                    <input type="hidden" name="id" value={v.id} />
                  </InlineAction>
                ) : null}
                <InlineAction action={removeVehicle} label="Remove">
                  <input type="hidden" name="id" value={v.id} />
                </InlineAction>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
