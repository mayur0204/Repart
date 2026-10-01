import type { Metadata } from "next";
import Link from "next/link";
import { InlineAction } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Badge, DateText } from "@/components/ui/display";
import { requireMemberPage } from "@/server/auth/current";
import { consent } from "@/server/services";
import { CONSENT_POLICY_VERSION, CONSENT_PURPOSES } from "@/server/services/consent/consent";
import { grantConsent, requestPersonalData, withdrawConsent } from "../actions";

export const metadata: Metadata = { title: "Privacy | RePart" };

export default async function PrivacySettingsPage() {
  const user = await requireMemberPage("/account/privacy");
  const statuses = await consent.list(user.id);

  return (
    <Page
      title="Privacy"
      intro={
        <>
          What you&apos;ve agreed to under our privacy policy (version {CONSENT_POLICY_VERSION}). Read the{" "}
          <Link href="/privacy" className="text-action underline underline-offset-4">
            full policy
          </Link>
          .
        </>
      }
    >
      <section aria-labelledby="consents-heading" className="flex flex-col gap-3">
        <h2 id="consents-heading" className="text-xl">
          Consents
        </h2>
        <ul className="flex flex-col rounded-lg overflow-hidden border border-rule bg-surface">
          {statuses.map((s) => (
            <li key={s.purpose} className="flex flex-col gap-2 border-b border-rule p-4 last:border-b-0 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{CONSENT_PURPOSES[s.purpose].title}</span>
                  {s.granted ? <Badge tone="fit">Given</Badge> : <Badge tone="neutral">Not given</Badge>}
                  {s.required ? <span className="text-sm text-steel">Needed for your account</span> : null}
                </div>
                <p className="prose-measure text-sm text-steel">{CONSENT_PURPOSES[s.purpose].summary}</p>
                {s.grantedAt ? (
                  <p className="text-sm text-steel">
                    Given on <DateText date={s.grantedAt} />
                  </p>
                ) : null}
              </div>
              {s.required ? null : s.granted ? (
                <InlineAction action={withdrawConsent} label="Withdraw consent" variant="secondary">
                  <input type="hidden" name="purpose" value={s.purpose} />
                </InlineAction>
              ) : (
                <InlineAction action={grantConsent} label="Give consent" variant="secondary">
                  <input type="hidden" name="purpose" value={s.purpose} />
                </InlineAction>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="data-heading" className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
        <h2 id="data-heading" className="text-xl">
          Your data
        </h2>
        <p className="prose-measure text-steel">
          You can ask for a copy of everything we hold about you, or ask us to delete your account. We review each request and contact you. Orders
          still in progress must finish first, and we keep payment records for as long as tax law requires.
        </p>
        <div className="flex flex-wrap gap-2">
          <InlineAction action={requestPersonalData} label="Request a copy of my data" variant="secondary">
            <input type="hidden" name="kind" value="copy" />
          </InlineAction>
          <InlineAction action={requestPersonalData} label="Ask to delete my account" variant="secondary">
            <input type="hidden" name="kind" value="delete" />
          </InlineAction>
        </div>
      </section>
    </Page>
  );
}
