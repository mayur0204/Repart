import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/layout/page";
import { ButtonLink } from "@/components/ui/button";
import { Badge, DateText, Price } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { requireMemberPage } from "@/server/auth/current";
import { messaging } from "@/server/services";

export const metadata: Metadata = { title: "Messages | RePart" };

/** Inbox (PLAN.md §4.6): one thread per listing, latest activity first. */
export default async function InboxPage() {
  const user = await requireMemberPage("/messages");
  const threads = await messaging.inbox(user.id);
  return (
    <Page title="Messages">
      {threads.length === 0 ? (
        <EmptyState title="No messages yet" body="Open a listing and select Message seller to ask about a part." action={<ButtonLink href="/search" variant="secondary">Search parts</ButtonLink>} />
      ) : (
        <ul className="flex flex-col border border-rule bg-surface">
          {threads.map((t) => (
            <li key={t.id} className="border-b border-rule last:border-b-0">
              <Link href={`/messages/${t.id}`} className={cn("grid grid-cols-[4rem_1fr] gap-3 p-3 hover:bg-page", t.unread && "border-l-4 border-l-action")}>
                {t.listing.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
                  <img src={t.listing.photoUrl} alt="" className="aspect-square w-16 object-cover" />
                ) : (
                  <span aria-hidden="true" className="aspect-square w-16 bg-page" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn("truncate", t.unread ? "font-semibold text-ink" : "text-ink")}>{t.listing.title}</span>
                    {t.unread ? <Badge tone="neutral" icon={false}>New</Badge> : null}
                    {t.listing.isSample ? <Badge tone="caution" icon={false}>SAMPLE</Badge> : null}
                  </span>
                  <span className="text-sm text-steel">
                    {t.role === "buyer" ? `Seller: ${t.otherName}` : `Buyer: ${t.otherName}`}, <Price paise={t.listing.pricePaise} size="sm" />
                  </span>
                  {t.last ? (
                    <span className="truncate text-sm text-steel">
                      {t.last.mine ? "You: " : ""}
                      {t.last.body} <DateText date={t.last.createdAt} />
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
