import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, FormInput } from "@/components/forms/action-form";
import { Page } from "@/components/layout/page";
import { Checkbox } from "@/components/ui/field";
import { safeNext, withNext } from "@/lib/return-to";
import { getCurrentUser, needsOnboarding } from "@/server/auth/current";
import { consent } from "@/server/services";
import { CONSENT_PURPOSE_KEYS, CONSENT_PURPOSES } from "@/server/services/consent/consent";
import { completeAboutYou } from "../actions";

export const metadata: Metadata = { title: "About you | RePart" };

export default async function AboutYouPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect(withNext("/sign-in", next));
  if (!(await needsOnboarding(user))) redirect(safeNext(next));
  const status = await consent.list(user.id);
  const required = CONSENT_PURPOSE_KEYS.filter((p) => CONSENT_PURPOSES[p].required);
  const optional = CONSENT_PURPOSE_KEYS.filter((p) => !CONSENT_PURPOSES[p].required);

  return (
    <Page title="About you" intro="Sellers and couriers see your name on your orders." narrow>
      <ActionForm action={completeAboutYou} submitLabel="Agree and continue" fullWidthSubmit>
        <input type="hidden" name="next" value={next ?? ""} />
        <FormInput label="Your name" name="name" autoComplete="name" defaultValue={user.name ?? ""} autoFocus />
        <FormInput label="Email (optional)" name="email" type="email" autoComplete="email" defaultValue={user.email ?? ""} help="For order receipts. We never share it." />

        <section className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-4">
          <h2 className="text-lg">How we use your details</h2>
          {required.map((p) => (
            <div key={p}>
              <p className="font-semibold">{CONSENT_PURPOSES[p].title}</p>
              <p className="text-sm text-steel">{CONSENT_PURPOSES[p].summary}</p>
            </div>
          ))}
          <p className="text-sm">
            Selecting Agree and continue accepts this. Read the{" "}
            <Link href="/privacy" target="_blank" className="text-action underline underline-offset-4">
              full privacy policy
            </Link>
            .
          </p>
          <div className="flex flex-col gap-2 border-t border-rule pt-3">
            <p className="text-sm text-steel">Optional. You can change these later in Account, Privacy.</p>
            {optional.map((p) => (
              <Checkbox
                key={p}
                name="optionalConsents"
                value={p}
                label={CONSENT_PURPOSES[p].title}
                description={CONSENT_PURPOSES[p].summary}
                defaultChecked={status.find((s) => s.purpose === p)?.granted}
              />
            ))}
          </div>
        </section>
      </ActionForm>
    </Page>
  );
}
