import type { Metadata } from "next";
import { Page } from "@/components/layout/page";
import { Badge } from "@/components/ui/display";
import { CONSENT_POLICY_VERSION, CONSENT_PURPOSE_KEYS, CONSENT_PURPOSES } from "@/server/services/consent/consent";

export const metadata: Metadata = { title: "Privacy policy | RePart" };

/** Public privacy policy (PLAN.md §4.1). The legal text is a TODO for the owner; the purposes shown match what sign-in asks for. */
export default function PrivacyPolicyPage() {
  return (
    <Page title="Privacy policy" intro={`Version ${CONSENT_POLICY_VERSION}.`}>
      <Badge tone="caution">Draft: full legal text to be supplied before launch</Badge>
      <section className="prose-measure flex flex-col gap-4">
        <h2 className="text-xl">What we use your details for</h2>
        {CONSENT_PURPOSE_KEYS.map((p) => (
          <div key={p}>
            <h3 className="text-lg">
              {CONSENT_PURPOSES[p].title}
              {CONSENT_PURPOSES[p].required ? " (needed for an account)" : " (optional)"}
            </h3>
            <p className="text-steel">{CONSENT_PURPOSES[p].summary}</p>
          </div>
        ))}
        <h2 className="text-xl">Your choices</h2>
        <p className="text-steel">
          Signed-in users can withdraw optional consents, request a copy of their data or ask for account deletion from Account, Privacy.
        </p>
      </section>
    </Page>
  );
}
