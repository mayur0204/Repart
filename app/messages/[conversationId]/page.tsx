import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Thread } from "@/components/messages/thread";
import { Badge, Price } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { requireMemberPage } from "@/server/auth/current";
import { NotFoundError } from "@/server/http/errors";
import { messaging } from "@/server/services";
import { MESSAGE_REPORT_REASONS } from "@/server/services/messaging/messaging";
import { markConversationRead, reportMessage, sendMessage } from "../actions";

export const metadata: Metadata = { title: "Message thread | RePart" };

const STATUS_NOTE: Partial<Record<string, string>> = { RESERVED: "Someone has ordered this part.", SOLD: "This part has been sold.", WITHDRAWN: "The seller withdrew this listing." };

/** Thread (PLAN.md §4.6): pinned listing summary, masking note, report message. Participants only; others get a 404. */
export default async function ThreadPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const user = await requireMemberPage(`/messages/${conversationId}`);
  const t = await messaging.thread(user.id, conversationId).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const live = t.listing.status === "LIVE";

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6 lg:px-8">
      <Link href="/messages" className="text-sm text-action underline-offset-4 hover:underline">All messages</Link>
      <section aria-label="Listing" className="sticky top-14 z-10 grid grid-cols-[4rem_1fr] gap-3 border border-rule bg-surface p-3">
        {t.listing.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
          <img src={t.listing.photoUrl} alt="" className="aspect-square w-16 object-cover" />
        ) : (
          <span aria-hidden="true" className="aspect-square w-16 bg-page" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          {live ? (
            <Link href={`/listings/${t.listing.id}`} className="truncate font-semibold text-action underline-offset-4 hover:underline">{t.listing.title}</Link>
          ) : (
            <span className="truncate font-semibold">{t.listing.title}</span>
          )}
          <span className="flex flex-wrap items-center gap-2 text-sm text-steel">
            <Price paise={t.listing.pricePaise} size="sm" />
            {t.role === "buyer" ? `Seller: ${t.otherName}` : `Buyer: ${t.otherName}`}
            {t.listing.isSample ? <Badge tone="caution" icon={false}>SAMPLE</Badge> : null}
          </span>
          {STATUS_NOTE[t.listing.status] ? <span className="text-sm text-steel">{STATUS_NOTE[t.listing.status]}</span> : null}
        </div>
      </section>
      <p className="flex items-start gap-2 border border-rule bg-page p-3 text-sm text-steel">
        <Icon name="lock" size="sm" className="mt-0.5 shrink-0" />
        For your safety, phone numbers, emails and UPI ids are removed from messages. Keep talking and paying on RePart so you&apos;re protected.
      </p>
      <Thread conversationId={t.id} initial={t.messages} reasons={MESSAGE_REPORT_REASONS} actions={{ send: sendMessage, markRead: markConversationRead, report: reportMessage }} />
    </main>
  );
}
