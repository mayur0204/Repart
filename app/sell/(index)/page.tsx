import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { DateText } from "@/components/ui/display";
import { LISTING_STEPS } from "@/lib/listing";
import { requireMemberPage } from "@/server/auth/current";
import { listings } from "@/server/services";
import { startListing } from "../actions";

export const metadata: Metadata = { title: "Sell a part | RePart" };

export default async function SellPage() {
  const user = await requireMemberPage("/sell");
  const drafts = (await listings.sellerListings(user.id)).get("DRAFT") ?? [];
  return (
    <Page title="Sell a part" intro="Seven short steps. Your draft is saved at each step, so you can stop and come back.">
      <ActionForm action={startListing} submitLabel="Start a new listing" className="max-w-md" />
      {drafts.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl">Continue a draft</h2>
          <ul className="flex flex-col rounded-lg overflow-hidden border border-rule bg-surface">
            {drafts.map((d) => {
              const step = LISTING_STEPS[Math.min(d.wizardStep, 7) - 1]!;
              return (
                <li key={d.id} className="border-b border-rule last:border-b-0">
                  <Link href={`/sell/${d.id}/${step.slug}`} className="flex min-h-11 flex-col p-4 hover:bg-page">
                    <span className="font-semibold text-action">{d.title ?? "Untitled draft"}</span>
                    <span className="text-sm text-steel">
                      Step {Math.min(d.wizardStep, 7)} of 7, {step.label}. Last saved <DateText date={d.updatedAt} />.
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </Page>
  );
}
